//! Provider reports locate candidate transactions; they never prove settlement.
//! Call only with identifiers from the authenticated, persisted bridge intent/source
//! event. No provider URL, recipient, signature or user-selected endpoint is fetched.
use super::{
    rpc_budget::{RpcBudget, RpcBudgetConfig},
    transport::retry_after_ms,
};
use crate::{metrics::Metrics, redis_store::RedisStore};
use reqwest::{
    StatusCode,
    header::{HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

const MAX_BODY: usize = 64 * 1024;
type Result<T> = std::result::Result<T, StatusError>;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeProvider {
    Relay,
}
impl BridgeProvider {
    pub fn name(self) -> &'static str {
        match self {
            Self::Relay => "relay",
        }
    }
    fn origin(self) -> &'static str {
        match self {
            Self::Relay => "https://api.relay.link",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum StatusError {
    #[error("invalid bridge status configuration or lookup")]
    Invalid,
    #[error("bridge status admission unavailable")]
    Busy,
    #[error("bridge status provider is cooling down")]
    CoolingDown,
    #[error("bridge status provider unavailable")]
    Unavailable,
    #[error("bridge status provider rejected the read")]
    Rejected,
    #[error("bridge status response does not bind the tracked transfer")]
    InvalidResponse,
    #[error("bridge status identifies multiple transfers")]
    Ambiguous,
    #[error("bridge status requires an unsupported execution verifier")]
    UnsupportedRoute,
}
impl StatusError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::Busy => "busy",
            Self::CoolingDown => "cooldown",
            Self::Unavailable => "unavailable",
            Self::Rejected => "rejected",
            Self::InvalidResponse => "invalid_response",
            Self::Ambiguous => "ambiguous",
            Self::UnsupportedRoute => "unsupported_route",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportedOutcome {
    NotIndexed,
    Pending,
    FillReported,
    RefundPending,
    RefundReported,
    RecoveryRequired,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateRole {
    DestinationFill,
    Refund,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateTransaction {
    pub chain_id: String,
    pub transaction_hash: String,
    pub role: CandidateRole,
}
/// An observation, never an operation-state transition or proof of wallet credit.
/// Chain/receipt/event/amount/recipient/finality verification must follow separately.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatusReport {
    pub provider: BridgeProvider,
    pub reported_outcome: ReportedOutcome,
    pub source_transaction_seen: bool,
    pub candidates: Vec<CandidateTransaction>,
    pub observed_at_ms: i64,
    pub provider_updated_at_ms: Option<i64>,
    pub verification_required: bool,
    pub poll_after_ms: u64,
}
/// Private fields prevent partially validated lookup state. These identifiers must
/// still be authenticated by the operation owner before constructing this value.
pub struct BridgeStatusLookup {
    provider: BridgeProvider,
    reference: String,
    source_chain: u64,
    destination_chain: u64,
    source_transaction: String,
}
fn chain(n: u64) -> bool {
    n > 0 && n <= 9_007_199_254_740_991
}
fn tx_hash(s: &str) -> Result<String> {
    if s.len() != 66
        || !s.starts_with("0x")
        || !s[2..].bytes().all(|b| b.is_ascii_hexdigit())
        || s[2..].bytes().all(|b| b == b'0')
    {
        return Err(StatusError::InvalidResponse);
    }
    Ok(s.to_ascii_lowercase())
}
impl BridgeStatusLookup {
    pub fn relay(
        request_id: &str,
        source_chain: u64,
        destination_chain: u64,
        source_transaction: &str,
    ) -> Result<Self> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return Err(StatusError::Invalid);
        }
        Self::new(
            BridgeProvider::Relay,
            request_id,
            source_chain,
            destination_chain,
            source_transaction,
        )
    }
    fn new(
        provider: BridgeProvider,
        reference: &str,
        source_chain: u64,
        destination_chain: u64,
        source_transaction: &str,
    ) -> Result<Self> {
        if !chain(source_chain) || !chain(destination_chain) || source_chain == destination_chain {
            return Err(StatusError::Invalid);
        }
        Ok(Self {
            provider,
            reference: reference.into(),
            source_chain,
            destination_chain,
            source_transaction: tx_hash(source_transaction).map_err(|_| StatusError::Invalid)?,
        })
    }
    fn path(&self) -> &'static str {
        match self.provider {
            BridgeProvider::Relay => "/intents/status/v3",
        }
    }
    fn query(&self) -> Vec<(&'static str, String)> {
        match self.provider {
            BridgeProvider::Relay => vec![("requestId", self.reference.clone())],
        }
    }
}
fn timestamp(v: &Value, now: i64) -> Result<i64> {
    v.as_i64()
        .filter(|n| *n > 0 && *n <= now.saturating_add(30_000))
        .ok_or(StatusError::InvalidResponse)
}
fn hashes(v: &Value) -> Result<Vec<String>> {
    if v.is_null() {
        return Ok(vec![]);
    }
    let list = v
        .as_array()
        .filter(|l| l.len() <= 8)
        .ok_or(StatusError::InvalidResponse)?;
    let values: Vec<_> = list
        .iter()
        .map(|v| tx_hash(v.as_str().ok_or(StatusError::InvalidResponse)?))
        .collect::<Result<_>>()?;
    if values.iter().collect::<BTreeSet<_>>().len() != values.len() {
        return Err(StatusError::InvalidResponse);
    }
    Ok(values)
}
fn report(
    provider: BridgeProvider,
    outcome: ReportedOutcome,
    seen: bool,
    candidates: Vec<CandidateTransaction>,
    now: i64,
    updated: Option<i64>,
) -> BridgeStatusReport {
    BridgeStatusReport {
        provider,
        reported_outcome: outcome,
        source_transaction_seen: seen,
        candidates,
        observed_at_ms: now,
        provider_updated_at_ms: updated,
        verification_required: true,
        poll_after_ms: if matches!(
            outcome,
            ReportedOutcome::RefundPending
                | ReportedOutcome::RecoveryRequired
                | ReportedOutcome::RefundReported
        ) {
            60_000
        } else {
            10_000
        },
    }
}
fn normalize(lookup: &BridgeStatusLookup, v: &Value, now: i64) -> Result<BridgeStatusReport> {
    if !v.is_object() || now <= 0 {
        return Err(StatusError::InvalidResponse);
    }
    let status = v["status"].as_str().ok_or(StatusError::InvalidResponse)?;
    match lookup.provider {
        BridgeProvider::Relay => {
            let incoming = hashes(&v["inTxHashes"])?;
            // A request containing multiple deposits is not safe to collapse into
            // one wallet operation. The requests/v3 recovery path must disambiguate.
            if incoming.len() > 1 {
                return Err(StatusError::Ambiguous);
            }
            let seen = incoming.first() == Some(&lookup.source_transaction);
            if !incoming.is_empty() && !seen {
                return Err(StatusError::InvalidResponse);
            }
            let outgoing = hashes(&v["txHashes"])?;
            let waiting = matches!(status, "waiting" | "depositing");
            for (field, expected) in [
                ("originChainId", lookup.source_chain),
                ("destinationChainId", lookup.destination_chain),
            ] {
                if !(waiting && v[field].is_null()) && v[field].as_u64() != Some(expected) {
                    return Err(StatusError::InvalidResponse);
                }
            }
            let updated = if v["updatedAt"].is_null() {
                None
            } else {
                Some(timestamp(&v["updatedAt"], now)?)
            };
            let outcome = match status {
                "waiting" | "depositing" | "pending" | "submitted" => ReportedOutcome::Pending,
                "success" if seen && !outgoing.is_empty() => ReportedOutcome::FillReported,
                "refund" if seen && !outgoing.is_empty() => ReportedOutcome::RefundReported,
                "refund" if seen => ReportedOutcome::RefundPending,
                "failure" => ReportedOutcome::RecoveryRequired,
                _ => return Err(StatusError::InvalidResponse),
            };
            // Ignore free-form details, provider polling URLs and reason strings.
            // Unclassified outgoing transactions must not become fill candidates.
            let role = match outcome {
                ReportedOutcome::FillReported => Some(CandidateRole::DestinationFill),
                ReportedOutcome::RefundReported => Some(CandidateRole::Refund),
                _ => None,
            };
            let candidates = role
                .map(|role| {
                    outgoing
                        .into_iter()
                        .map(|transaction_hash| CandidateTransaction {
                            chain_id: (if role == CandidateRole::Refund {
                                lookup.source_chain
                            } else {
                                lookup.destination_chain
                            })
                            .to_string(),
                            transaction_hash,
                            role,
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(report(
                lookup.provider,
                outcome,
                seen,
                candidates,
                now,
                updated,
            ))
        }
    }
}

/// Separate constructors enforce provider-specific credential headers.
/// Origins and paths are fixed. Operator account scope/spacing must reflect the
/// actual quota agreement; all future calls for that account must share this scope.
pub struct BridgeStatusClient {
    provider: BridgeProvider,
    client: reqwest::Client,
    headers: HeaderMap,
    budget: RpcBudget,
    permits: Semaphore,
    metrics: Arc<Metrics>,
    origin: Option<String>,
}
impl BridgeStatusClient {
    #[cfg(test)]
    pub(crate) fn with_test_origin(mut self, origin: String) -> Self {
        let parsed = reqwest::Url::parse(&origin).unwrap();
        assert_eq!(parsed.scheme(), "http");
        assert_eq!(parsed.host_str(), Some("127.0.0.1"));
        self.origin = Some(origin);
        self
    }
    pub fn provider(&self) -> BridgeProvider {
        self.provider
    }
    pub fn relay(
        api_key: Zeroizing<String>,
        budget: RpcBudgetConfig,
        redis: RedisStore,
        metrics: Arc<Metrics>,
    ) -> Result<Self> {
        Self::new(BridgeProvider::Relay, api_key, budget, redis, metrics)
    }
    fn new(
        provider: BridgeProvider,
        api_key: Zeroizing<String>,
        mut config: RpcBudgetConfig,
        redis: RedisStore,
        metrics: Arc<Metrics>,
    ) -> Result<Self> {
        if api_key.is_empty()
            || api_key.len() > 512
            || !api_key.bytes().all(|c| c.is_ascii_graphic())
            || config.simulation_cost != 1
        {
            return Err(StatusError::Invalid);
        }
        config.scope = format!("{}-{}", provider.name(), config.scope);
        let budget = RpcBudget::new(redis, config).map_err(|_| StatusError::Invalid)?;
        let mut headers = HeaderMap::new();
        let mut value = HeaderValue::from_str(&api_key).map_err(|_| StatusError::Invalid)?;
        value.set_sensitive(true);
        headers.insert("x-api-key", value);
        headers.insert("accept", HeaderValue::from_static("application/json"));
        headers.insert("cache-control", HeaderValue::from_static("no-cache"));
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(4)
            .build()
            .map_err(|_| StatusError::Invalid)?;
        Ok(Self {
            provider,
            client,
            headers,
            budget,
            permits: Semaphore::new(4),
            metrics,
            origin: None,
        })
    }
    #[tracing::instrument(name="provider.bridge_status",skip_all,fields(provider=self.provider.name()))]
    pub async fn read(&self, lookup: &BridgeStatusLookup) -> Result<BridgeStatusReport> {
        let started = Instant::now();
        let result = self.read_inner(lookup).await;
        self.metrics.bridge_status(
            self.provider,
            result.as_ref().err().copied(),
            started.elapsed().as_secs_f64(),
        );
        result
    }
    async fn read_inner(&self, lookup: &BridgeStatusLookup) -> Result<BridgeStatusReport> {
        if lookup.provider != self.provider {
            return Err(StatusError::Invalid);
        }
        let _permit = self.permits.try_acquire().map_err(|_| StatusError::Busy)?;
        self.budget.admit(false).await.map_err(|e| {
            if e == super::evm_rpc::RpcError::CoolingDown {
                StatusError::CoolingDown
            } else {
                StatusError::Busy
            }
        })?;
        let origin = self.provider.origin();
        let origin = self.origin.as_deref().unwrap_or(origin);
        let response = self
            .client
            .get(format!("{origin}{}", lookup.path()))
            .headers(self.headers.clone())
            .query(&lookup.query())
            .send()
            .await;
        let mut response = match response {
            Ok(r) => r,
            Err(_) => {
                self.budget
                    .cooldown(Some(10_000))
                    .await
                    .map_err(|_| StatusError::Busy)?;
                return Err(StatusError::Unavailable);
            }
        };
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            self.budget
                .cooldown(retry_after_ms(
                    response
                        .headers()
                        .get("retry-after")
                        .and_then(|h| h.to_str().ok()),
                    SystemTime::now(),
                ))
                .await
                .map_err(|_| StatusError::Busy)?;
            return Err(StatusError::CoolingDown);
        }
        let now = super::evm_prepare::now_ms();
        if status == StatusCode::NOT_FOUND {
            return Ok(report(
                self.provider,
                ReportedOutcome::NotIndexed,
                false,
                vec![],
                now,
                None,
            ));
        }
        if !status.is_success() {
            return Err(StatusError::Rejected);
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err(StatusError::InvalidResponse);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| StatusError::Unavailable)?
        {
            if body.len().saturating_add(chunk.len()) > MAX_BODY {
                return Err(StatusError::InvalidResponse);
            }
            body.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&body).map_err(|_| StatusError::InvalidResponse)?;
        normalize(lookup, &value, super::evm_prepare::now_ms())
    }
}
#[cfg(test)]
mod tests;
