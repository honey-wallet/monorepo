//! Authenticated Across swap/approval boundary for independently checked direct
//! ERC20 routes. A quote is not a simulation, signature or permission to dispatch.
use super::{
    across_evidence::DirectDepositTerms,
    evm_prepare::now_ms,
    rpc_budget::{RpcBudget, RpcBudgetConfig},
    transport::retry_after_ms,
};
use crate::{error::AppError, metrics::Metrics, redis_store::RedisStore};
use alloy_primitives::{Address, U256, keccak256};
use reqwest::{StatusCode, header::HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;
const ORIGIN: &str = "https://app.across.to/api/swap/approval";
const MAX_BODY: usize = 256 * 1024;
type Result<T> = std::result::Result<T, QuoteError>;
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum QuoteError {
    #[error("invalid Across quote request or configuration")]
    Invalid,
    #[error("Across quote admission unavailable")]
    Busy,
    #[error("Across quotes temporarily unavailable")]
    Unavailable,
    #[error("no supported Across route")]
    Unsupported,
    #[error("Across quote does not match the requested transfer")]
    InvalidResponse,
}
impl QuoteError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "invalid_request",
            Self::Busy => "busy",
            Self::Unavailable => "unavailable",
            Self::Unsupported => "no_route",
            Self::InvalidResponse => "invalid_response",
        }
    }
}
impl From<QuoteError> for AppError {
    fn from(e: QuoteError) -> Self {
        match e {
            QuoteError::Invalid => Self::BadRequest(e.to_string()),
            QuoteError::Unsupported => Self::Unsupported(e.to_string()),
            _ => Self::Busy,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeToken {
    /// Operator-reviewed cross-chain asset identity; symbols are display-only.
    pub asset_id: String,
    pub address: String,
    pub symbol: String,
    pub decimals: u8,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectRoute {
    pub id: String,
    pub destination_chain_id: String,
    pub source_spoke: String,
    pub input_token: BridgeToken,
    pub output_token: BridgeToken,
    pub minimum_input_raw: String,
    pub maximum_input_raw: String,
    pub maximum_bridge_fee_bps: u16,
    pub maximum_fill_seconds: u32,
    pub maximum_exclusivity_seconds: u32,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcrossConfiguration {
    pub provider: &'static str,
    pub source_chain_id: String,
    pub integrator_id: String,
    pub registry_revision: String,
    pub routes: Vec<DirectRoute>,
    pub execution_available: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcrossQuoteRequest {
    pub route_id: String,
    pub amount_raw: String,
    pub minimum_output_raw: String,
    pub recipient: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcrossQuote {
    pub provider: &'static str,
    pub quote_id: String,
    pub route_id: String,
    pub registry_revision: String,
    pub source_chain_id: String,
    pub destination_chain_id: String,
    pub sender: String,
    pub recipient: String,
    pub input_token: String,
    pub output_token: String,
    pub input_amount_raw: String,
    pub output_amount_raw: String,
    pub minimum_output_raw: String,
    pub bridge_fee_raw: String,
    pub integrator_fee_raw: String,
    pub integrator_id: String,
    pub source_gas_estimate_raw: String,
    pub approval_gas_included: bool,
    pub expected_fill_seconds: u32,
    pub refund_chain_id: String,
    pub refund_recipient: String,
    pub quote_timestamp: String,
    pub fill_deadline: String,
    pub exclusivity_parameter: String,
    pub exclusive_relayer: String,
    pub received_at_ms: i64,
    /// Provider-declared hard quote expiry. `expires_at_ms` additionally applies
    /// Honey's short cache TTL and contract deadline caps.
    pub provider_expires_at_ms: Option<i64>,
    pub expires_at_ms: i64,
    pub execution_available: bool,
}
/// Private artifact: independently parsed calldata and immutable quoted economics.
/// No deserializer; preparation must still perform fresh chain checks/simulation.
pub struct ValidatedAcrossQuote {
    quote: AcrossQuote,
    terms: DirectDepositTerms,
    calldata: String,
    raw_quote: Value,
}
impl ValidatedAcrossQuote {
    pub fn raw_quote(&self) -> &Value {
        &self.raw_quote
    }
    pub fn quote(&self) -> &AcrossQuote {
        &self.quote
    }
    pub fn terms(&self) -> &DirectDepositTerms {
        &self.terms
    }
    pub fn calldata(&self) -> &str {
        &self.calldata
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileConfig {
    #[serde(deserialize_with = "secret")]
    api_key: Zeroizing<String>,
    account_scope: String,
    interval_ms: u64,
    source_chain_id: String,
    integrator_id: String,
    registry_revision: String,
    routes: Vec<DirectRoute>,
}
fn secret<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    String::deserialize(d).map(Zeroizing::new)
}
fn uint(s: &str) -> Result<U256> {
    if s.is_empty()
        || s.len() > 78
        || !s.bytes().all(|c| c.is_ascii_digit())
        || s.len() > 1 && s.starts_with('0')
    {
        return Err(QuoteError::InvalidResponse);
    }
    U256::from_str_radix(s, 10).map_err(|_| QuoteError::InvalidResponse)
}
fn value_uint(v: &Value) -> Result<U256> {
    uint(v.as_str().ok_or(QuoteError::InvalidResponse)?)
}
fn addr(s: &str) -> Result<Address> {
    if s.len() != 42 || !s.starts_with("0x") {
        return Err(QuoteError::InvalidResponse);
    }
    s.parse().map_err(|_| QuoteError::InvalidResponse)
}
fn address(v: &Value) -> Result<Address> {
    addr(v.as_str().ok_or(QuoteError::InvalidResponse)?)
}
fn chain(s: &str) -> Result<u64> {
    let n: u64 = uint(s)?
        .try_into()
        .map_err(|_| QuoteError::InvalidResponse)?;
    if n == 0 || n > 9_007_199_254_740_991 {
        return Err(QuoteError::InvalidResponse);
    }
    Ok(n)
}
fn label(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}
fn token(v: &Value, t: &BridgeToken, c: u64) -> Result<()> {
    if address(&v["address"])? != addr(&t.address)?
        || v["chainId"].as_u64() != Some(c)
        || v["decimals"].as_u64() != Some(t.decimals.into())
    {
        return Err(QuoteError::InvalidResponse);
    }
    Ok(())
}
fn integer(v: &Value, max: u64) -> Result<u64> {
    v.as_u64()
        .filter(|n| *n <= max)
        .ok_or(QuoteError::InvalidResponse)
}
fn optional_uint(v: &Value) -> Result<U256> {
    if v.is_null() {
        Ok(U256::ZERO)
    } else {
        value_uint(v)
    }
}

fn validate_config(c: &mut FileConfig, auth_chain: u64) -> Result<()> {
    if chain(&c.source_chain_id)? != auth_chain
        || c.integrator_id.len() != 6
        || !c.integrator_id.starts_with("0x")
        || !c.integrator_id[2..].bytes().all(|b| b.is_ascii_hexdigit())
        || !label(&c.registry_revision, 64)
        || c.routes.is_empty()
        || c.routes.len() > 32
    {
        return Err(QuoteError::Invalid);
    }
    c.integrator_id.make_ascii_lowercase();
    let mut ids = std::collections::HashSet::new();
    for r in &mut c.routes {
        let min = uint(&r.minimum_input_raw)?;
        let max = uint(&r.maximum_input_raw)?;
        if !label(&r.id, 64)
            || !ids.insert(r.id.clone())
            || chain(&r.destination_chain_id)? == auth_chain
            || addr(&r.source_spoke)? == Address::ZERO
            || min == U256::ZERO
            || min > max
            || r.maximum_bridge_fee_bps > 1000
            || !(60..=86400).contains(&r.maximum_fill_seconds)
            || r.maximum_exclusivity_seconds > r.maximum_fill_seconds
            || r.input_token.decimals != r.output_token.decimals
            || !label(&r.input_token.asset_id, 64)
            || r.input_token.asset_id != r.output_token.asset_id
        {
            return Err(QuoteError::Invalid);
        }
        r.source_spoke = format!("{:#x}", addr(&r.source_spoke)?);
        for t in [&mut r.input_token, &mut r.output_token] {
            if t.decimals > 36 || !label(&t.symbol, 16) || addr(&t.address)? == Address::ZERO {
                return Err(QuoteError::Invalid);
            }
            t.address = format!("{:#x}", addr(&t.address)?);
        }
    }
    Ok(())
}
pub struct AcrossQuotes {
    configuration: AcrossConfiguration,
    client: reqwest::Client,
    key: HeaderValue,
    budget: RpcBudget,
    permits: Semaphore,
    metrics: Arc<Metrics>,
    origin: Option<String>,
}
impl AcrossQuotes {
    pub fn from_file(
        path: &str,
        auth_chain: u64,
        redis: RedisStore,
        metrics: Arc<Metrics>,
    ) -> Result<Self> {
        let c: FileConfig =
            crate::earn_service::load_file(path).map_err(|_| QuoteError::Invalid)?;
        Self::new(c, auth_chain, redis, metrics)
    }
    /// Explicit fixture-only transport. Never accepts a production credential.
    pub(crate) fn from_local_file(
        path: &str,
        origin: &str,
        redis: RedisStore,
        metrics: Arc<Metrics>,
    ) -> Result<Self> {
        let c: FileConfig =
            crate::earn_service::load_file(path).map_err(|_| QuoteError::Invalid)?;
        let url = reqwest::Url::parse(origin).map_err(|_| QuoteError::Invalid)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || c.api_key.as_str() != "local-fixture-only"
            || c.routes.iter().any(|r| r.destination_chain_id != "31338")
        {
            return Err(QuoteError::Invalid);
        }
        let mut service = Self::new(c, 31337, redis, metrics)?;
        service.origin = Some(format!("{}/swap/approval", origin.trim_end_matches('/')));
        Ok(service)
    }
    pub(crate) fn local_status(
        path: &str,
        origin: &str,
        redis: RedisStore,
        metrics: Arc<Metrics>,
    ) -> Result<super::bridge_status::BridgeStatusClient> {
        let c: FileConfig =
            crate::earn_service::load_file(path).map_err(|_| QuoteError::Invalid)?;
        if c.api_key.as_str() != "local-fixture-only" {
            return Err(QuoteError::Invalid);
        }
        super::bridge_status::BridgeStatusClient::local_across(
            origin,
            c.integrator_id,
            RpcBudgetConfig {
                scope: c.account_scope,
                interval_ms: c.interval_ms,
                simulation_cost: 1,
            },
            redis,
            metrics,
        )
        .map_err(|_| QuoteError::Invalid)
    }
    /// Recheck cached public evidence against current registry and its original TTL.
    pub(crate) fn restore_quote(
        &self,
        sender: &str,
        request: &AcrossQuoteRequest,
        raw: &Value,
        received_at: i64,
    ) -> Result<ValidatedAcrossQuote> {
        let at = now_ms();
        if received_at > at || at - received_at > 30_000 {
            return Err(QuoteError::InvalidResponse);
        }
        let q = self.normalize(sender, request, raw, received_at)?;
        if q.quote.expires_at_ms <= at {
            return Err(QuoteError::InvalidResponse);
        }
        Ok(q)
    }
    fn new(
        mut c: FileConfig,
        auth_chain: u64,
        redis: RedisStore,
        metrics: Arc<Metrics>,
    ) -> Result<Self> {
        validate_config(&mut c, auth_chain).map_err(|_| QuoteError::Invalid)?;
        if c.api_key.is_empty()
            || c.api_key.len() > 512
            || !c.api_key.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(QuoteError::Invalid);
        }
        let credential = Zeroizing::new(format!("Bearer {}", c.api_key.as_str()));
        let mut key = HeaderValue::from_str(&credential).map_err(|_| QuoteError::Invalid)?;
        key.set_sensitive(true);
        let budget = RpcBudget::new(
            redis,
            RpcBudgetConfig {
                scope: format!("across-{}", c.account_scope),
                interval_ms: c.interval_ms,
                simulation_cost: 1,
            },
        )
        .map_err(|_| QuoteError::Invalid)?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(4)
            .build()
            .map_err(|_| QuoteError::Invalid)?;
        Ok(Self {
            configuration: AcrossConfiguration {
                provider: "across",
                source_chain_id: c.source_chain_id,
                integrator_id: c.integrator_id,
                registry_revision: c.registry_revision,
                routes: c.routes,
                execution_available: false,
            },
            client,
            key,
            budget,
            permits: Semaphore::new(4),
            metrics,
            origin: None,
        })
    }
    pub fn configuration(&self) -> &AcrossConfiguration {
        &self.configuration
    }
    fn route<'a>(
        &'a self,
        request: &AcrossQuoteRequest,
        sender: &str,
    ) -> Result<(&'a DirectRoute, Address, Address, U256)> {
        let r = self
            .configuration
            .routes
            .iter()
            .find(|r| r.id == request.route_id)
            .ok_or(QuoteError::Unsupported)?;
        let owner = addr(sender).map_err(|_| QuoteError::Invalid)?;
        let recipient = addr(&request.recipient).map_err(|_| QuoteError::Invalid)?;
        let amount = uint(&request.amount_raw).map_err(|_| QuoteError::Invalid)?;
        let floor = uint(&request.minimum_output_raw).map_err(|_| QuoteError::Invalid)?;
        if owner == Address::ZERO
            || recipient == Address::ZERO
            || amount < uint(&r.minimum_input_raw)?
            || amount > uint(&r.maximum_input_raw)?
            || floor == U256::ZERO
            || floor > amount
        {
            return Err(QuoteError::Invalid);
        }
        Ok((r, owner, recipient, amount))
    }
    #[tracing::instrument(name = "provider.across_quote", skip_all)]
    pub async fn quote(
        &self,
        sender: &str,
        request: &AcrossQuoteRequest,
    ) -> Result<ValidatedAcrossQuote> {
        let started = Instant::now();
        let result = self.quote_inner(sender, request).await;
        self.metrics.across_quote(
            result.as_ref().err().copied(),
            started.elapsed().as_secs_f64(),
        );
        result
    }
    async fn quote_inner(
        &self,
        sender: &str,
        request: &AcrossQuoteRequest,
    ) -> Result<ValidatedAcrossQuote> {
        let (route, owner, recipient, _) = self.route(request, sender)?;
        let _permit = self.permits.try_acquire().map_err(|_| QuoteError::Busy)?;
        self.budget
            .admit(false)
            .await
            .map_err(|_| QuoteError::Busy)?;
        let query = [
            ("tradeType", "exactInput".into()),
            ("amount", request.amount_raw.clone()),
            ("inputToken", route.input_token.address.clone()),
            ("outputToken", route.output_token.address.clone()),
            ("originChainId", self.configuration.source_chain_id.clone()),
            ("destinationChainId", route.destination_chain_id.clone()),
            ("depositor", format!("{owner:#x}")),
            ("recipient", format!("{recipient:#x}")),
            ("refundAddress", format!("{owner:#x}")),
            ("refundOnOrigin", "true".into()),
            ("integratorId", self.configuration.integrator_id.clone()),
            ("strictTradeType", "true".into()),
            ("skipOriginTxEstimation", "false".into()),
            ("slippage", "0".into()),
        ];
        let origin = ORIGIN;
        let origin = self.origin.as_deref().unwrap_or(origin);
        let response = self
            .client
            .get(origin)
            .header("authorization", self.key.clone())
            .header("accept", "application/json")
            .header("cache-control", "no-cache")
            .query(&query)
            .send()
            .await;
        let mut response = match response {
            Ok(r) => r,
            Err(_) => {
                self.budget
                    .cooldown(Some(10000))
                    .await
                    .map_err(|_| QuoteError::Busy)?;
                return Err(QuoteError::Unavailable);
            }
        };
        if response.status() == StatusCode::TOO_MANY_REQUESTS || response.status().is_server_error()
        {
            self.budget
                .cooldown(retry_after_ms(
                    response
                        .headers()
                        .get("retry-after")
                        .and_then(|h| h.to_str().ok()),
                    SystemTime::now(),
                ))
                .await
                .map_err(|_| QuoteError::Busy)?;
            return Err(QuoteError::Unavailable);
        }
        if !response.status().is_success() {
            return Err(QuoteError::Unavailable);
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err(QuoteError::InvalidResponse);
        }
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| QuoteError::Unavailable)?
        {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err(QuoteError::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| QuoteError::InvalidResponse)?;
        self.normalize(sender, request, &value, now_ms())
    }
    fn normalize(
        &self,
        sender: &str,
        request: &AcrossQuoteRequest,
        v: &Value,
        now: i64,
    ) -> Result<ValidatedAcrossQuote> {
        let (r, owner, recipient, amount) = self.route(request, sender)?;
        let source = chain(&self.configuration.source_chain_id)?;
        let destination = chain(&r.destination_chain_id)?;
        if v["crossSwapType"] != "bridgeableToBridgeable"
            || v["amountType"] != "exactInput"
            || !v["steps"]["originSwap"].is_null()
            || !v["steps"]["destinationSwap"].is_null()
            || v["steps"]["bridge"]["provider"] != "across"
            || !v["swapTx"]["eip712"].is_null()
        {
            return Err(QuoteError::Unsupported);
        }
        let tx = &v["swapTx"];
        if tx["chainId"].as_u64() != Some(source)
            || address(&tx["to"])? != addr(&r.source_spoke)?
            || tx["simulationSuccess"] != true
        {
            return Err(QuoteError::InvalidResponse);
        }
        let calldata = tx["data"].as_str().ok_or(QuoteError::InvalidResponse)?;
        let terms = DirectDepositTerms::decode_calldata(
            source,
            Some(self.configuration.integrator_id.clone()),
            calldata,
            optional_uint(&tx["value"])?,
        )
        .map_err(|_| QuoteError::InvalidResponse)?;
        let output = terms.output_amount;
        if terms.depositor != owner
            || terms.recipient != recipient
            || terms.destination_chain != destination
            || terms.input_token != addr(&r.input_token.address)?
            || terms.output_token != addr(&r.output_token.address)?
            || terms.input_amount != amount
            || output < uint(&request.minimum_output_raw)?
            || output > amount
        {
            return Err(QuoteError::InvalidResponse);
        }
        let seconds = u64::try_from(now / 1000).map_err(|_| QuoteError::InvalidResponse)?;
        let quote_time = u64::from(terms.quote_timestamp);
        let fill = u64::from(terms.fill_deadline);
        if quote_time > seconds + 15
            || quote_time.saturating_add(300) < seconds
            || fill <= seconds + 30
            || fill > seconds + u64::from(r.maximum_fill_seconds)
        {
            return Err(QuoteError::InvalidResponse);
        }
        let exclusive = u64::from(terms.exclusivity_parameter);
        if (exclusive <= 31_536_000
            && (exclusive > u64::from(r.maximum_exclusivity_seconds) || seconds + exclusive > fill))
            || (exclusive > 31_536_000
                && (exclusive > seconds + u64::from(r.maximum_exclusivity_seconds)
                    || exclusive > fill))
        {
            return Err(QuoteError::InvalidResponse);
        }
        for (node, expected) in [
            (&v["inputAmount"], amount),
            (&v["expectedOutputAmount"], output),
            (&v["minOutputAmount"], output),
            (&v["steps"]["bridge"]["inputAmount"], amount),
            (&v["steps"]["bridge"]["outputAmount"], output),
        ] {
            if value_uint(node)? != expected {
                return Err(QuoteError::InvalidResponse);
            }
        }
        // maxInputAmount is optional in the published SDK schema. For exact input,
        // calldata and inputAmount already bind the spend; reject conflicts if supplied.
        if !v["maxInputAmount"].is_null() && value_uint(&v["maxInputAmount"])? != amount {
            return Err(QuoteError::InvalidResponse);
        }
        for (node, t, c) in [
            (&v["inputToken"], &r.input_token, source),
            (&v["outputToken"], &r.output_token, destination),
            (&v["refundToken"], &r.input_token, source),
            (&v["steps"]["bridge"]["tokenIn"], &r.input_token, source),
            (
                &v["steps"]["bridge"]["tokenOut"],
                &r.output_token,
                destination,
            ),
        ] {
            token(node, t, c)?;
        }
        let fee = amount - output;
        if fee
            .checked_mul(U256::from(10000))
            .ok_or(QuoteError::InvalidResponse)?
            > amount
                .checked_mul(U256::from(r.maximum_bridge_fee_bps))
                .ok_or(QuoteError::InvalidResponse)?
        {
            return Err(QuoteError::InvalidResponse);
        }
        for f in [&v["steps"]["bridge"]["fees"], &v["fees"]["total"]] {
            token(&f["token"], &r.input_token, source)?;
            if value_uint(&f["amount"])? != fee
                || value_uint(&f["pct"])? > U256::from(10u64).pow(U256::from(18))
            {
                return Err(QuoteError::InvalidResponse);
            }
        }
        for name in ["total", "totalMax", "maxTotal"] {
            let f = &v["fees"][name];
            if f.is_null() {
                continue;
            }
            token(&f["token"], &r.input_token, source)?;
            if value_uint(&f["amount"])? != fee {
                return Err(QuoteError::InvalidResponse);
            }
            let app = &f["details"]["app"];
            if !app.is_null() {
                token(&app["token"], &r.output_token, destination)?;
                if value_uint(&app["amount"])? != U256::ZERO
                    || value_uint(&app["pct"])? != U256::ZERO
                {
                    return Err(QuoteError::Unsupported);
                }
            }
        }
        for (check, allowance) in [
            (&v["checks"]["allowance"], true),
            (&v["checks"]["balance"], false),
        ] {
            if address(&check["token"])? != terms.input_token
                || value_uint(&check["expected"])? != amount
            {
                return Err(QuoteError::InvalidResponse);
            }
            value_uint(&check["actual"])?;
            if allowance && address(&check["spender"])? != addr(&r.source_spoke)? {
                return Err(QuoteError::InvalidResponse);
            }
        }
        if !v["approvalTxns"].is_null() {
            let approvals = v["approvalTxns"]
                .as_array()
                .filter(|a| a.len() <= 2)
                .ok_or(QuoteError::InvalidResponse)?;
            for approval in approvals {
                if approval["chainId"].as_u64() != Some(source)
                    || address(&approval["to"])? != terms.input_token
                    || optional_uint(&approval["value"])? != U256::ZERO
                {
                    return Err(QuoteError::InvalidResponse);
                }
                let s = approval["data"]
                    .as_str()
                    .ok_or(QuoteError::InvalidResponse)?;
                if s.len() != 138 || !s.starts_with("0x") {
                    return Err(QuoteError::InvalidResponse);
                }
                let data = hex::decode(&s[2..]).map_err(|_| QuoteError::InvalidResponse)?;
                if data[..4] != keccak256("approve(address,uint256)")[..4]
                    || data[4..16].iter().any(|b| *b != 0)
                    || Address::from_slice(&data[16..36]) != addr(&r.source_spoke)?
                {
                    return Err(QuoteError::InvalidResponse);
                }
                let approval_amount = U256::from_be_slice(&data[36..]);
                if ![U256::ZERO, amount, U256::MAX].contains(&approval_amount) {
                    return Err(QuoteError::InvalidResponse);
                }
            }
        }
        // Provider approvals are hints only and are not returned for signing.
        // Preparation must construct finite reset/amount approvals from fresh RPC.
        let gas = value_uint(&tx["gas"])?;
        if gas == U256::ZERO || gas > U256::from(2_000_000) {
            return Err(QuoteError::InvalidResponse);
        }
        for field in ["maxFeePerGas", "maxPriorityFeePerGas"] {
            if optional_uint(&tx[field])? > U256::from(u128::MAX) {
                return Err(QuoteError::InvalidResponse);
            }
        }
        if !tx["maxFeePerGas"].is_null()
            && !tx["maxPriorityFeePerGas"].is_null()
            && value_uint(&tx["maxPriorityFeePerGas"])? > value_uint(&tx["maxFeePerGas"])?
        {
            return Err(QuoteError::InvalidResponse);
        }
        let id = v["id"]
            .as_str()
            .filter(|s| label(s, 128))
            .ok_or(QuoteError::InvalidResponse)?;
        let fill_seconds = integer(&v["expectedFillTime"], fill - seconds)? as u32;
        if fill_seconds == 0 {
            return Err(QuoteError::InvalidResponse);
        }
        // A local TTL never extends provider freshness, the fill window, or the
        // remaining relative exclusivity window. Preparation must recheck chain time.
        let mut expires = now
            .checked_add(30000)
            .ok_or(QuoteError::InvalidResponse)?
            .min(((quote_time + 300) * 1000) as i64)
            .min(((fill - 30) * 1000) as i64);
        if exclusive <= 31_536_000 {
            expires = expires.min(((fill - exclusive) * 1000) as i64);
        }
        let provider_expires_at_ms = if !v["quoteExpiryTimestamp"].is_null() {
            let expiry = integer(&v["quoteExpiryTimestamp"], u32::MAX.into())?;
            let expiry_ms = (expiry * 1000) as i64;
            expires = expires.min(expiry_ms);
            Some(expiry_ms)
        } else {
            None
        };
        if expires <= now {
            return Err(QuoteError::InvalidResponse);
        }
        let quote = AcrossQuote {
            provider: "across",
            quote_id: id.into(),
            route_id: r.id.clone(),
            registry_revision: self.configuration.registry_revision.clone(),
            source_chain_id: source.to_string(),
            destination_chain_id: destination.to_string(),
            sender: format!("{owner:#x}"),
            recipient: format!("{recipient:#x}"),
            input_token: r.input_token.address.clone(),
            output_token: r.output_token.address.clone(),
            input_amount_raw: amount.to_string(),
            output_amount_raw: output.to_string(),
            minimum_output_raw: output.to_string(),
            bridge_fee_raw: fee.to_string(),
            integrator_fee_raw: "0".into(),
            integrator_id: self.configuration.integrator_id.clone(),
            source_gas_estimate_raw: gas.to_string(),
            approval_gas_included: false,
            expected_fill_seconds: fill_seconds,
            refund_chain_id: source.to_string(),
            refund_recipient: format!("{owner:#x}"),
            quote_timestamp: terms.quote_timestamp.to_string(),
            fill_deadline: terms.fill_deadline.to_string(),
            exclusivity_parameter: terms.exclusivity_parameter.to_string(),
            exclusive_relayer: format!("{:#x}", terms.exclusive_relayer),
            received_at_ms: now,
            provider_expires_at_ms,
            expires_at_ms: expires,
            execution_available: false,
        };
        Ok(ValidatedAcrossQuote {
            quote,
            terms,
            calldata: calldata.into(),
            raw_quote: v.clone(),
        })
    }
}
#[cfg(test)]
mod tests;
