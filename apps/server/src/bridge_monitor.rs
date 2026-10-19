//! Durable advisory polling for signed bridge deposits. Never dispatches, signs,
//! releases nonce guards or transitions operations based on provider status.
use crate::{
    error::AppError,
    identity::{digest, unavailable},
    providers::{
        bridge_status::{
            BridgeProvider, BridgeStatusClient, BridgeStatusLookup, BridgeStatusReport, StatusError,
        },
        rpc_budget::RpcBudgetConfig,
    },
    work::WorkStore,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::{sync::Arc, time::Duration};
use uuid::Uuid;
use zeroize::Zeroizing;
fn invalid() -> AppError {
    AppError::BadRequest("invalid bridge tracking binding".into())
}
fn conflict() -> AppError {
    AppError::Conflict("bridge tracking binding or lease changed".into())
}
fn now() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
/// The bridge command commits provider/chains/refund route under `bridgeTracking`
/// before signing (plus Relay request ID). Source hash comes from the signed bundle;
/// Across deposit ID is derived later from verified source-event evidence.
/// No public endpoint registers arbitrary IDs.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeBinding {
    pub provider: BridgeProvider,
    pub provider_reference: String,
    pub source_chain_id: String,
    pub destination_chain_id: String,
    pub refund_chain_id: String,
    pub source_transaction_hash: String,
}
impl BridgeBinding {
    pub(crate) fn intent_terms(&self) -> Result<serde_json::Value, AppError> {
        let mut terms = serde_json::to_value(self).map_err(|_| AppError::Busy)?;
        let fields = terms.as_object_mut().ok_or_else(invalid)?;
        fields.remove("sourceTransactionHash");
        if self.provider == BridgeProvider::Across {
            fields.remove("providerReference");
        }
        Ok(terms)
    }
    /// Bind either supported immutable Across schema to the same chain route.
    pub(crate) fn across_intent_terms(
        &self,
        intent: &serde_json::Value,
    ) -> Result<crate::providers::across_evidence::DirectDepositTerms, AppError> {
        let terms = crate::across_service::stored_bridge_terms(intent)?;
        if self.provider != BridgeProvider::Across
            || self.source_chain_id != terms.source_chain.to_string()
            || self.destination_chain_id != terms.destination_chain.to_string()
            || self.refund_chain_id != terms.source_chain.to_string()
            || (intent.get("service").is_none()
                && intent["bridgeTracking"] != self.intent_terms()?)
        {
            return Err(conflict());
        }
        Ok(terms)
    }
    fn lookup(&self) -> Result<BridgeStatusLookup, AppError> {
        fn chain(s: &str) -> Result<u64, AppError> {
            let n = s.parse::<u64>().map_err(|_| invalid())?;
            if n.to_string() != s {
                return Err(invalid());
            }
            Ok(n)
        }
        let (source, destination, refund) = (
            chain(&self.source_chain_id)?,
            chain(&self.destination_chain_id)?,
            chain(&self.refund_chain_id)?,
        );
        let lookup = match self.provider {
            BridgeProvider::Relay if source == refund => BridgeStatusLookup::relay(
                &self.provider_reference,
                source,
                destination,
                &self.source_transaction_hash,
            ),
            BridgeProvider::Across => BridgeStatusLookup::across(
                &self.provider_reference,
                source,
                destination,
                refund,
                &self.source_transaction_hash,
            ),
            _ => return Err(invalid()),
        }
        .map_err(|_| invalid())?;
        if self.source_transaction_hash != self.source_transaction_hash.to_ascii_lowercase() {
            return Err(invalid());
        }
        Ok(lookup)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatusRecovery {
    pub operation_id: Uuid,
    pub binding: BridgeBinding,
    pub observation: Option<BridgeStatusReport>,
    pub verified_delivery: Option<crate::across_settlement::AcrossDeliverySummary>,
    pub stale: bool,
    pub poll_version: String,
    pub next_poll_at_ms: i64,
    pub last_error_code: Option<String>,
}
struct PollLease {
    operation: Uuid,
    token: Uuid,
    version: i64,
    binding: BridgeBinding,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Account {
    #[serde(deserialize_with = "secret")]
    api_key: Zeroizing<String>,
    account_scope: String,
    interval_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcrossAccount {
    account: Account,
    integrator_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Accounts {
    relay: Option<Account>,
    across: Option<AcrossAccount>,
}
fn secret<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Zeroizing<String>, D::Error> {
    String::deserialize(d).map(Zeroizing::new)
}
pub struct BridgeMonitor {
    work: WorkStore,
    clients: Vec<BridgeStatusClient>,
}
impl BridgeMonitor {
    pub(crate) fn with_client(work: WorkStore, client: BridgeStatusClient) -> Self {
        Self {
            work,
            clients: vec![client],
        }
    }
    pub fn new(work: WorkStore) -> Self {
        Self {
            work,
            clients: vec![],
        }
    }
    pub fn from_file(
        work: WorkStore,
        path: &str,
        redis: crate::redis_store::RedisStore,
        metrics: Arc<crate::metrics::Metrics>,
    ) -> Result<Self, AppError> {
        let config: Accounts = crate::earn_service::load_file(path)?;
        let mut clients = vec![];
        let budget = |a: &Account| RpcBudgetConfig {
            scope: a.account_scope.clone(),
            interval_ms: a.interval_ms,
            simulation_cost: 1,
        };
        if let Some(a) = config.relay {
            let b = budget(&a);
            clients.push(
                BridgeStatusClient::relay(a.api_key, b, redis.clone(), metrics.clone())
                    .map_err(|_| invalid())?,
            );
        }
        if let Some(a) = config.across {
            let b = budget(&a.account);
            clients.push(
                BridgeStatusClient::across(a.account.api_key, a.integrator_id, b, redis, metrics)
                    .map_err(|_| invalid())?,
            );
        }
        if clients.is_empty() {
            return Err(invalid());
        }
        Ok(Self { work, clients })
    }
    /// Internal handoff only: requires the exact immutable intent binding and the
    /// last transaction of the already-persisted signed source bundle. An approval
    /// hash or another user's transaction cannot attach. Relay's request ID must
    /// match the intent. Across must use the separate verified-source handoff.
    #[tracing::instrument(name="bridge.attach",skip_all,fields(operation_id=%operation))]
    pub async fn attach(&self, operation: Uuid, binding: &BridgeBinding) -> Result<(), AppError> {
        if binding.provider != BridgeProvider::Relay {
            return Err(invalid());
        }
        self.attach_inner(operation, binding, None).await
    }
    /// Across's reference is derived from independently verified source evidence,
    /// never selected from a provider status response or an HTTP caller's string.
    pub async fn attach_across(
        &self,
        operation: Uuid,
        proof: &crate::providers::across_evidence::VerifiedAcrossDeposit,
    ) -> Result<(), AppError> {
        let terms = proof.terms();
        let binding = BridgeBinding {
            provider: BridgeProvider::Across,
            provider_reference: proof.deposit_id(),
            source_chain_id: terms.source_chain.to_string(),
            destination_chain_id: terms.destination_chain.to_string(),
            refund_chain_id: terms.source_chain.to_string(),
            source_transaction_hash: format!("{:#x}", proof.source().transaction_hash),
        };
        self.attach_inner(operation, &binding, Some(proof)).await
    }
    async fn attach_inner(
        &self,
        operation: Uuid,
        binding: &BridgeBinding,
        across: Option<&crate::providers::across_evidence::VerifiedAcrossDeposit>,
    ) -> Result<(), AppError> {
        binding.lookup()?;
        let json = serde_json::to_string(binding).map_err(|_| AppError::Busy)?;
        let hash = digest(json.as_bytes());
        let mut tx = self.work.pool.begin().await.map_err(unavailable)?;
        let row=sqlx::query("SELECT o.action,i.canonical_json FROM operations o JOIN operation_intents i ON i.operation_id=o.id WHERE o.id=$1 FOR UPDATE OF o")
            .bind(operation).fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or(AppError::NotFound)?;
        let intent: String = row.try_get("canonical_json").map_err(unavailable)?;
        let intent: serde_json::Value =
            serde_json::from_str(&intent).map_err(|_| AppError::Busy)?;
        if row.try_get::<String, _>("action").map_err(unavailable)? != "bridge"
            || (across.is_none() && intent["bridgeTracking"] != binding.intent_terms()?)
        {
            return Err(conflict());
        }
        if let Some(proof) = across {
            if binding.across_intent_terms(&intent)? != *proof.terms() {
                return Err(conflict());
            }
            let signer: Option<Vec<u8>> =
                sqlx::query_scalar("SELECT signer FROM evm_submissions WHERE operation_id=$1")
                    .bind(operation)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(unavailable)?;
            if signer.as_deref() != Some(proof.terms().depositor.as_slice()) {
                return Err(conflict());
            }
        }
        let source:Option<Uuid>=sqlx::query_scalar("SELECT t.id FROM evm_signed_transactions t JOIN evm_submissions s ON s.operation_id=t.operation_id JOIN operations o ON o.id=s.operation_id WHERE t.operation_id=$1 AND t.step=s.step_count-1 AND t.tx_hash=$2 AND t.chain_id=$3 AND s.wallet_id=o.wallet_id")
            .bind(operation).bind(hex::decode(&binding.source_transaction_hash[2..]).map_err(|_|invalid())?).bind(binding.source_chain_id.parse::<i64>().map_err(|_|invalid())?).fetch_optional(&mut *tx).await.map_err(unavailable)?;
        let source = source.ok_or_else(conflict)?;
        sqlx::query("INSERT INTO bridge_status_watches(operation_id,source_transaction_id,provider,binding_json,binding_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(operation_id) DO NOTHING")
            .bind(operation).bind(source).bind(binding.provider.name()).bind(&json).bind(&hash).execute(&mut *tx).await.map_err(unavailable)?;
        let stored: Vec<u8> = sqlx::query_scalar(
            "SELECT binding_hash FROM bridge_status_watches WHERE operation_id=$1",
        )
        .bind(operation)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if stored != hash {
            return Err(conflict());
        }
        // Check after row locks/inserts too: waiting cannot extend observation age.
        if across.is_some_and(|p| p.checked_at_ms() > now() || now() - p.checked_at_ms() > 10_000) {
            return Err(conflict());
        }
        tx.commit().await.map_err(unavailable)
    }
    pub async fn recover(
        &self,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<BridgeStatusRecovery, AppError> {
        let row=sqlx::query("SELECT w.*, o.state AS current_state, o.version AS current_version, (extract(epoch from next_poll_at)*1000)::bigint AS next_ms FROM bridge_status_watches w JOIN operations o ON o.id=w.operation_id WHERE o.id=$1 AND o.user_id=$2 AND o.wallet_id=$3")
            .bind(operation).bind(user).bind(wallet).fetch_optional(&self.work.pool).await.map_err(unavailable)?.ok_or(AppError::NotFound)?;
        let binding = decode_binding(&row)?;
        let json: Option<String> = row.try_get("observation_json").map_err(unavailable)?;
        let observation: Option<BridgeStatusReport> = if let Some(json) = json {
            let hash: Vec<u8> = row.try_get("observation_hash").map_err(unavailable)?;
            if digest(json.as_bytes()) != hash {
                return Err(AppError::Busy);
            }
            Some(serde_json::from_str(&json).map_err(|_| AppError::Busy)?)
        } else {
            None
        };
        let stale = observation.as_ref().is_none_or(|r| {
            r.observed_at_ms > now() || now() - r.observed_at_ms > (r.poll_after_ms * 3) as i64
        });
        Ok(BridgeStatusRecovery {
            operation_id: operation,
            binding,
            observation,
            verified_delivery: self.work.across_delivery(user, wallet, operation).await?,
            stale,
            poll_version: row
                .try_get::<i64, _>("poll_version")
                .map_err(unavailable)?
                .to_string(),
            next_poll_at_ms: row.try_get("next_ms").map_err(unavailable)?,
            last_error_code: row.try_get("last_error_code").map_err(unavailable)?,
        })
    }
    async fn claim(&self) -> Result<Option<PollLease>, AppError> {
        let providers: Vec<_> = self.clients.iter().map(|c| c.provider().name()).collect();
        if providers.is_empty() {
            return Ok(None);
        }
        let token = Uuid::new_v4();
        let row=sqlx::query("WITH candidate AS (SELECT operation_id FROM bridge_status_watches WHERE stopped_at IS NULL AND provider=ANY($1) AND next_poll_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY next_poll_at,operation_id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE bridge_status_watches w SET lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds' FROM candidate c WHERE w.operation_id=c.operation_id RETURNING w.*")
            .bind(providers).bind(token).fetch_optional(&self.work.pool).await.map_err(unavailable)?;
        row.map(|r| {
            Ok(PollLease {
                operation: r.try_get("operation_id").map_err(unavailable)?,
                token,
                version: r.try_get("poll_version").map_err(unavailable)?,
                binding: decode_binding(&r)?,
            })
        })
        .transpose()
    }
    async fn record(
        &self,
        lease: &PollLease,
        result: Result<BridgeStatusReport, StatusError>,
    ) -> Result<(), AppError> {
        let (json, hash, error, delay) = match result {
            Ok(r) => {
                if r.provider != lease.binding.provider
                    || !r.verification_required
                    || r.observed_at_ms > now()
                    || now() - r.observed_at_ms > 10_000
                {
                    return Err(conflict());
                }
                let delay = r.poll_after_ms as i64;
                let json = serde_json::to_string(&r).map_err(|_| AppError::Busy)?;
                let hash = digest(json.as_bytes());
                (Some(json), Some(hash), None, delay)
            }
            Err(e) => (None, None, Some(e.code()), 30_000),
        };
        // Stable bounded jitter spreads cohort retries; it never accelerates the
        // provider's per-transfer polling recommendation or global account quota.
        let delay = delay + i64::from(lease.operation.as_bytes()[0]) * 10;
        let changed=sqlx::query("UPDATE bridge_status_watches SET observation_json=COALESCE($4,observation_json),observation_hash=COALESCE($5,observation_hash),observed_at=CASE WHEN $4::text IS NULL THEN observed_at ELSE clock_timestamp() END,last_error_code=$6,poll_version=poll_version+1,next_poll_at=clock_timestamp()+($7*interval '1 millisecond'),lease_token=NULL,lease_until=NULL WHERE operation_id=$1 AND stopped_at IS NULL AND lease_token=$2 AND poll_version=$3 AND lease_until>clock_timestamp()")
            .bind(lease.operation).bind(lease.token).bind(lease.version).bind(json).bind(hash).bind(error).bind(delay).execute(&self.work.pool).await.map_err(unavailable)?.rows_affected();
        if changed != 1 {
            return Err(conflict());
        }
        Ok(())
    }
    #[tracing::instrument(name = "bridge.poll", skip_all)]
    pub async fn tick(&self) -> Result<bool, AppError> {
        let Some(lease) = self.claim().await? else {
            return Ok(false);
        };
        let client = self
            .clients
            .iter()
            .find(|c| c.provider() == lease.binding.provider)
            .ok_or(AppError::Busy)?;
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            client.read(&lease.binding.lookup()?),
        )
        .await
        .unwrap_or(Err(StatusError::Unavailable));
        self.record(&lease, result).await?;
        Ok(true)
    }
    pub fn start(
        self: Arc<Self>,
        health: crate::runtime::RuntimeHealth,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if !health.is_draining() && self.tick().await.is_err() {
                    tracing::warn!(
                        error_code = "bridge_poll_retry",
                        "Bridge observation deferred"
                    );
                }
            }
        })
    }
}
pub(crate) fn decode_binding(row: &sqlx::postgres::PgRow) -> Result<BridgeBinding, AppError> {
    let json: String = row.try_get("binding_json").map_err(unavailable)?;
    let hash: Vec<u8> = row.try_get("binding_hash").map_err(unavailable)?;
    if digest(json.as_bytes()) != hash {
        return Err(AppError::Busy);
    }
    let binding: BridgeBinding = serde_json::from_str(&json).map_err(|_| AppError::Busy)?;
    binding.lookup()?;
    Ok(binding)
}
#[cfg(test)]
mod tests;
