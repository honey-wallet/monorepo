//! Authenticated CLASSIC quote boundary. Quotes confer no signing authority.
use super::{
    evm_prepare::now_ms,
    rpc_budget::{RpcBudget, RpcBudgetConfig},
    transport::retry_after_ms,
};
use crate::{error::AppError, metrics::Metrics, redis_store::RedisStore};
use alloy_primitives::{Address, U256};
use reqwest::{StatusCode, header::HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

mod build;
pub use build::{BuildGasEstimate, ReviewOptions, ValidatedSwapQuote, VerifiedSwapBuild};

#[derive(Clone, Copy)]
enum Endpoint {
    Quote,
    Swap { expires_at_ms: i64 },
}
impl Endpoint {
    fn path(self) -> &'static str {
        match self {
            Self::Quote => "quote",
            Self::Swap { .. } => "swap",
        }
    }
}

const ORIGIN: &str = "https://trade-api.gateway.uniswap.org/v1";
const ROUTER_VERSION: &str = "2.1.2";
const MAX_BODY: usize = 256 * 1024;
type Result<T> = std::result::Result<T, QuoteError>;

#[derive(Clone, Copy, Debug, thiserror::Error)]
pub enum QuoteError {
    #[error("invalid swap quote request")]
    InvalidRequest,
    #[error("swap quote is temporarily unavailable")]
    Unavailable,
    #[error("swap quote admission is busy")]
    Busy,
    #[error("no supported swap route")]
    NoRoute,
    #[error("swap quote response did not match the request")]
    InvalidResponse,
}
impl QuoteError {
    fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Unavailable => "unavailable",
            Self::Busy => "busy",
            Self::NoRoute => "no_route",
            Self::InvalidResponse => "invalid_response",
        }
    }
}
impl From<QuoteError> for AppError {
    fn from(e: QuoteError) -> Self {
        match e {
            QuoteError::InvalidRequest => Self::BadRequest(e.to_string()),
            QuoteError::NoRoute => Self::Unsupported(e.to_string()),
            _ => Self::Busy,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwapToken {
    pub address: String,
    pub symbol: String,
    pub decimals: u8,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegratorFee {
    pub recipient: String,
    pub bps: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileConfig {
    #[serde(deserialize_with = "secret")]
    api_key: Zeroizing<String>,
    account_scope: String,
    interval_ms: u64,
    chain_id: u64,
    router: String,
    permit2: String,
    tokens: Vec<SwapToken>,
    integrator_fees: Vec<IntegratorFee>,
    registry_revision: String,
    fee_policy_revision: String,
}
fn secret<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    String::deserialize(d).map(Zeroizing::new)
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapQuoteConfiguration {
    pub provider: &'static str,
    pub chain_id: String,
    pub router: String,
    pub permit2: String,
    pub router_version: &'static str,
    pub tokens: Vec<SwapToken>,
    pub integrator_fees: Vec<IntegratorFee>,
    pub registry_revision: String,
    pub fee_policy_revision: String,
    pub execution_available: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwapQuoteRequest {
    pub token_in: String,
    pub token_out: String,
    pub amount_raw: String,
    pub slippage_bps: u16,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotedFee {
    pub recipient: String,
    pub bps: u16,
    pub amount_raw: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapQuote {
    pub provider: &'static str,
    pub routing: &'static str,
    pub quote_id: String,
    pub request_id: String,
    pub chain_id: String,
    pub signer: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in_raw: String,
    pub gross_output_raw: String,
    pub net_output_raw: String,
    pub minimum_output_raw: String,
    pub slippage_bps: u16,
    pub fees: Vec<QuotedFee>,
    pub swap_gas_estimate_raw: String,
    pub approval_gas_included: bool,
    pub permit_required: bool,
    pub source_block: String,
    pub registry_revision: String,
    pub fee_policy_revision: String,
    pub received_at_ms: i64,
    pub expires_at_ms: i64,
    pub execution_available: bool,
}
pub struct UniswapQuotes {
    configuration: SwapQuoteConfiguration,
    chain: u64,
    key: HeaderValue,
    client: reqwest::Client,
    budget: RpcBudget,
    permits: Semaphore,
    metrics: Arc<Metrics>,
    local_origin: Option<String>,
    #[cfg(test)]
    origin: Option<String>,
}
impl UniswapQuotes {
    pub fn from_file(
        path: &str,
        chain: u64,
        redis: RedisStore,
        metrics: Arc<Metrics>,
    ) -> std::result::Result<Self, AppError> {
        let file: FileConfig = crate::earn_service::load_file(path)?;
        Self::new(file, chain, redis, metrics).map_err(AppError::from)
    }
    fn new(f: FileConfig, chain: u64, redis: RedisStore, metrics: Arc<Metrics>) -> Result<Self> {
        Self::configured(f, chain, redis, metrics, None)
    }
    /// Synthetic Trading API endpoint for chain-31337 fork acceptance only. A
    /// production quote configuration can never redirect credentials to this URL.
    pub(crate) fn from_local_file(
        path: &str,
        origin: &str,
        redis: RedisStore,
        metrics: Arc<Metrics>,
    ) -> Result<Self> {
        let f: FileConfig =
            crate::earn_service::load_file(path).map_err(|_| QuoteError::InvalidRequest)?;
        let url = reqwest::Url::parse(origin).map_err(|_| QuoteError::InvalidRequest)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || f.api_key.as_str() != "local-fixture-only"
        {
            return Err(QuoteError::InvalidRequest);
        }
        Self::configured(
            f,
            31337,
            redis,
            metrics,
            Some(origin.trim_end_matches('/').into()),
        )
    }
    fn configured(
        f: FileConfig,
        chain: u64,
        redis: RedisStore,
        metrics: Arc<Metrics>,
        local_origin: Option<String>,
    ) -> Result<Self> {
        // Trading API chains, excluding zkSync: official supported-chains docs say
        // it has only router 2.0, incompatible with our explicit 2.1.2 header.
        // This is not an execution allowlist or a deployed-bytecode attestation.
        let supported_chain = [
            1, 10, 56, 130, 137, 143, 196, 480, 1868, 4217, 4326, 4663, 5042, 8453, 10143, 42161,
            42220, 43114, 57073, 59144, 81457, 7777777, 1301, 84532, 11155111,
        ]
        .contains(&f.chain_id)
            || local_origin.is_some() && f.chain_id == 31337;
        if !supported_chain
            || f.chain_id != chain
            || !(167..=60_000).contains(&f.interval_ms)
            || f.api_key.is_empty()
            || f.api_key.len() > 512
            || !f.api_key.bytes().all(|c| c.is_ascii_graphic())
            || f.tokens.len() < 2
            || f.tokens.len() > 64
            || f.integrator_fees.len() > 4
            || !revision(&f.registry_revision)
            || !revision(&f.fee_policy_revision)
        {
            return Err(QuoteError::InvalidRequest);
        }
        let mut addresses = HashSet::new();
        for token in &f.tokens {
            if address(&token.address).is_err()
                || token.address != token.address.to_lowercase()
                || token.decimals > 36
                || token.symbol.is_empty()
                || token.symbol.len() > 16
                || !token
                    .symbol
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || !addresses.insert(token.address.clone())
            {
                return Err(QuoteError::InvalidRequest);
            }
        }
        let mut recipients = HashSet::new();
        let mut bps = 0u32;
        for fee in &f.integrator_fees {
            address(&fee.recipient).map_err(|_| QuoteError::InvalidRequest)?;
            if fee.bps == 0
                || fee.recipient != fee.recipient.to_lowercase()
                || !recipients.insert(fee.recipient.clone())
            {
                return Err(QuoteError::InvalidRequest);
            }
            bps += u32::from(fee.bps);
        }
        if bps > 500 {
            return Err(QuoteError::InvalidRequest);
        }
        let router = address(&f.router).map_err(|_| QuoteError::InvalidRequest)?;
        let permit2 = address(&f.permit2).map_err(|_| QuoteError::InvalidRequest)?;
        let mut key = HeaderValue::from_str(&f.api_key).map_err(|_| QuoteError::InvalidRequest)?;
        key.set_sensitive(true);
        let budget = RpcBudget::new(
            redis,
            RpcBudgetConfig {
                scope: format!("uniswap-{}", f.account_scope),
                interval_ms: f.interval_ms,
                simulation_cost: 1,
            },
        )
        .map_err(|_| QuoteError::InvalidRequest)?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(4)
            .build()
            .map_err(|_| QuoteError::Unavailable)?;
        Ok(Self {
            configuration: SwapQuoteConfiguration {
                provider: "uniswap",
                chain_id: chain.to_string(),
                router: format!("{router:#x}"),
                permit2: format!("{permit2:#x}"),
                router_version: ROUTER_VERSION,
                tokens: f.tokens,
                integrator_fees: f.integrator_fees,
                registry_revision: f.registry_revision,
                fee_policy_revision: f.fee_policy_revision,
                execution_available: false,
            },
            chain,
            key,
            client,
            budget,
            permits: Semaphore::new(4),
            metrics,
            local_origin,
            #[cfg(test)]
            origin: None,
        })
    }
    #[cfg(test)]
    pub(crate) fn local_test_client(
        c: SwapQuoteConfiguration,
        origin: String,
        redis: RedisStore,
    ) -> Self {
        let f = FileConfig {
            api_key: Zeroizing::new("local-fixture-only".into()),
            account_scope: uuid::Uuid::new_v4().simple().to_string(),
            interval_ms: 167,
            chain_id: 31337,
            router: c.router,
            permit2: c.permit2,
            tokens: c.tokens,
            integrator_fees: c.integrator_fees,
            registry_revision: c.registry_revision,
            fee_policy_revision: c.fee_policy_revision,
        };
        Self::configured(f, 31337, redis, Arc::new(Metrics::default()), Some(origin)).unwrap()
    }
    pub fn configuration(&self) -> SwapQuoteConfiguration {
        self.configuration.clone()
    }
    pub(crate) fn validate_request(&self, signer: &str, r: &SwapQuoteRequest) -> Result<()> {
        self.request(signer, r).map(|_| ())
    }
    fn request(&self, signer: &str, r: &SwapQuoteRequest) -> Result<Value> {
        address(signer).map_err(|_| QuoteError::InvalidRequest)?;
        let amount = uint(&r.amount_raw).map_err(|_| QuoteError::InvalidRequest)?;
        if amount == U256::ZERO
            || amount >= U256::from(1u8).wrapping_shl(160) - U256::from(1u8)
            || r.token_in == r.token_out
            || r.slippage_bps > 1000
            || [&r.token_in, &r.token_out]
                .iter()
                .any(|a| !self.configuration.tokens.iter().any(|t| &t.address == *a))
            || self
                .configuration
                .integrator_fees
                .iter()
                .any(|f| f.recipient == signer.to_lowercase())
        {
            return Err(QuoteError::InvalidRequest);
        }
        // Numeric percentage is created from exact bps decimal text, never a float calculation.
        let slip: Value = serde_json::from_str(&format!(
            "{}.{:02}",
            r.slippage_bps / 100,
            r.slippage_bps % 100
        ))
        .map_err(|_| QuoteError::InvalidRequest)?;
        Ok(
            json!({"type":"EXACT_INPUT","amount":r.amount_raw,"tokenInChainId":self.chain,"tokenOutChainId":self.chain,"tokenIn":r.token_in,"tokenOut":r.token_out,"swapper":signer.to_lowercase(),"recipient":signer.to_lowercase(),"slippageTolerance":slip,"routingPreference":"BEST_PRICE","protocols":["V2","V3","V4"],"hooksOptions":"V4_NO_HOOKS","permitAmount":"EXACT","generatePermitAsTransaction":false,"swapSource":"WALLET","integratorFees":self.configuration.integrator_fees.iter().map(|f|json!({"recipient":f.recipient,"bips":f.bps})).collect::<Vec<_>>()}),
        )
    }
    #[tracing::instrument(name = "provider.uniswap_quote", skip_all)]
    pub async fn quote(&self, signer: &str, r: SwapQuoteRequest) -> Result<SwapQuote> {
        let body = self.request(signer, &r)?;
        let start = Instant::now();
        let result = self
            .fetch(Endpoint::Quote, &body)
            .await
            .and_then(|v| serde_json::from_slice(&v).map_err(|_| QuoteError::InvalidResponse))
            .and_then(|v| normalize(&self.configuration, signer, &r, &v, now_ms()));
        self.metrics.swap_quote(
            result.as_ref().err().map(|e| e.code()).unwrap_or("ok"),
            start.elapsed().as_secs_f64(),
        );
        result
    }
    async fn fetch(&self, endpoint: Endpoint, body: &Value) -> Result<Zeroizing<Vec<u8>>> {
        let _permit = self.permits.try_acquire().map_err(|_| QuoteError::Busy)?;
        self.budget
            .admit(false)
            .await
            .map_err(|_| QuoteError::Busy)?;
        if let Endpoint::Swap { expires_at_ms } = endpoint
            && now_ms() >= expires_at_ms
        {
            return Err(QuoteError::InvalidRequest);
        }
        let origin = ORIGIN;
        let origin = self.local_origin.as_deref().unwrap_or(origin);
        #[cfg(test)]
        let origin = self.origin.as_deref().unwrap_or(origin);
        let response = self
            .client
            .post(format!("{origin}/{}", endpoint.path()))
            .header("x-api-key", self.key.clone())
            .header("Accept", "application/json")
            .header("x-universal-router-version", ROUTER_VERSION)
            .header("x-erc20eth-enabled", "false")
            .header("x-permit2-disabled", "false")
            .json(body)
            .send()
            .await;
        let mut response = match response {
            Ok(r) => r,
            Err(_) => {
                self.hold(Some(10_000)).await?;
                return Err(QuoteError::Unavailable);
            }
        };
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            self.hold(retry_after_ms(
                response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok()),
                SystemTime::now(),
            ))
            .await?;
            return Err(QuoteError::Unavailable);
        }
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            self.hold(None).await?;
            return Err(QuoteError::Unavailable);
        }
        if status == StatusCode::NOT_FOUND {
            return Err(QuoteError::NoRoute);
        }
        if !status.is_success() {
            return Err(QuoteError::Unavailable);
        }
        if response
            .content_length()
            .is_some_and(|v| v > MAX_BODY as u64)
        {
            return Err(QuoteError::InvalidResponse);
        }
        if matches!(endpoint, Endpoint::Swap { .. })
            && response
                .headers()
                .get("x-universal-router-version")
                .and_then(|v| v.to_str().ok())
                != Some(ROUTER_VERSION)
        {
            return Err(QuoteError::InvalidResponse);
        }
        let mut bytes = Zeroizing::new(Vec::new());
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
        Ok(bytes)
    }
    async fn hold(&self, ms: Option<u64>) -> Result<()> {
        self.budget.cooldown(ms).await.map_err(|_| QuoteError::Busy)
    }
}

fn revision(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn address(s: &str) -> Result<Address> {
    let a = s
        .parse::<Address>()
        .map_err(|_| QuoteError::InvalidResponse)?;
    if s.len() != 42 || a == Address::ZERO {
        return Err(QuoteError::InvalidResponse);
    }
    Ok(a)
}
fn addr(v: &Value) -> Result<Address> {
    address(v.as_str().ok_or(QuoteError::InvalidResponse)?)
}
fn uint(s: &str) -> Result<U256> {
    if s.is_empty()
        || s.len() > 78
        || (s.len() > 1 && s.starts_with('0'))
        || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(QuoteError::InvalidResponse);
    }
    U256::from_str_radix(s, 10).map_err(|_| QuoteError::InvalidResponse)
}
fn number(v: &Value) -> Result<U256> {
    uint(v.as_str().ok_or(QuoteError::InvalidResponse)?)
}
fn bounded_id(v: &Value) -> Result<String> {
    let s = v.as_str().ok_or(QuoteError::InvalidResponse)?;
    if !revision(s) {
        return Err(QuoteError::InvalidResponse);
    }
    Ok(s.to_string())
}
fn mul_div(v: U256, n: u64, d: u64) -> Result<U256> {
    v.checked_mul(U256::from(n))
        .map(|v| v / U256::from(d))
        .ok_or(QuoteError::InvalidResponse)
}

fn normalize(
    c: &SwapQuoteConfiguration,
    signer: &str,
    r: &SwapQuoteRequest,
    v: &Value,
    now: i64,
) -> Result<SwapQuote> {
    let bad = QuoteError::InvalidResponse;
    let q = &v["quote"];
    let owner = address(signer)?;
    let input = address(&r.token_in)?;
    let output = address(&r.token_out)?;
    if v["routing"] != "CLASSIC"
        || q["tradeType"] != "EXACT_INPUT"
        || q["chainId"].as_u64().map(|n| n.to_string()) != Some(c.chain_id.clone())
        || addr(&q["swapper"])? != owner
        || addr(&q["input"]["token"])? != input
        || number(&q["input"]["amount"])? != uint(&r.amount_raw)?
        || addr(&q["output"]["token"])? != output
        || addr(&q["output"]["recipient"])? != owner
        || q.get("txFailureReasons")
            .is_some_and(|v| !v.as_array().is_some_and(|v| v.is_empty()))
        || v.get("permitTransaction").is_some_and(|v| !v.is_null())
    {
        return Err(bad);
    }
    if scaled_decimal(&q["slippage"], 2)? != u64::from(r.slippage_bps) {
        return Err(bad);
    }
    let gross = number(&q["output"]["amount"])?;
    let outputs = q["aggregatedOutputs"].as_array().ok_or(bad)?;
    if gross == U256::ZERO || outputs.len() != c.integrator_fees.len() + 1 {
        return Err(bad);
    }
    let mut net = None;
    let mut minimum = None;
    let mut fees = Vec::new();
    let mut total = U256::ZERO;
    let mut seen = HashSet::new();
    for leg in outputs {
        if addr(&leg["token"])? != output {
            return Err(bad);
        }
        let recipient = addr(&leg["recipient"])?;
        let amount = number(&leg["amount"])?;
        total = total.checked_add(amount).ok_or(bad)?;
        if !seen.insert(recipient) {
            return Err(bad);
        }
        if recipient == owner && leg.get("fee").is_none_or(Value::is_null) {
            net = Some(amount);
            minimum = Some(number(&leg["minAmount"])?);
        } else {
            let policy = c
                .integrator_fees
                .iter()
                .find(|f| address(&f.recipient).ok() == Some(recipient))
                .ok_or(bad)?;
            if leg["fee"] != "INTEGRATOR"
                || scaled_decimal(&leg["bps"], 0)? != u64::from(policy.bps)
                || amount != mul_div(gross, u64::from(policy.bps), 10000)?
            {
                return Err(bad);
            }
            fees.push(QuotedFee {
                recipient: format!("{recipient:#x}"),
                bps: policy.bps,
                amount_raw: amount.to_string(),
            });
        }
    }
    let net = net.ok_or(bad)?;
    let minimum = minimum.ok_or(bad)?;
    if total != gross
        || net == U256::ZERO
        || minimum == U256::ZERO
        || minimum > net
        || minimum < mul_div(net, 10000 - u64::from(r.slippage_bps), 10000)?
    {
        return Err(bad);
    }
    // Deprecated portion metadata must agree if present; never silently ignore a fee.
    if q.get("portionAmount")
        .is_some_and(|v| number(v).ok() != Some(gross - net))
    {
        return Err(bad);
    }
    if q.get("portionBips").is_some_and(|v| {
        v.as_u64() != Some(c.integrator_fees.iter().map(|f| u64::from(f.bps)).sum())
    }) {
        return Err(bad);
    }
    check_routes(c, r, q)?;
    let permit = v.get("permitData").ok_or(bad)?;
    if !permit.is_null() {
        check_permit(c, r, permit, now)?;
    }
    let source = number(&q["blockNumber"])?;
    if source > U256::from(u64::MAX) {
        return Err(bad);
    }
    Ok(SwapQuote {
        provider: "uniswap",
        routing: "CLASSIC",
        quote_id: bounded_id(&q["quoteId"])?,
        request_id: bounded_id(&v["requestId"])?,
        chain_id: c.chain_id.clone(),
        signer: format!("{owner:#x}"),
        token_in: r.token_in.clone(),
        token_out: r.token_out.clone(),
        amount_in_raw: r.amount_raw.clone(),
        gross_output_raw: gross.to_string(),
        net_output_raw: net.to_string(),
        minimum_output_raw: minimum.to_string(),
        slippage_bps: r.slippage_bps,
        fees,
        swap_gas_estimate_raw: number(&q["gasFee"])?.to_string(),
        approval_gas_included: false,
        permit_required: !permit.is_null(),
        source_block: source.to_string(),
        registry_revision: c.registry_revision.clone(),
        fee_policy_revision: c.fee_policy_revision.clone(),
        received_at_ms: now,
        expires_at_ms: now + 30_000,
        execution_available: false,
    })
}
fn check_routes(c: &SwapQuoteConfiguration, r: &SwapQuoteRequest, q: &Value) -> Result<()> {
    let bad = QuoteError::InvalidResponse;
    let routes = q["route"].as_array().ok_or(bad)?;
    if routes.is_empty() || routes.len() > 8 {
        return Err(bad);
    }
    let mut total_in = U256::ZERO;
    let mut total_out = U256::ZERO;
    for route in routes {
        let pools = route.as_array().ok_or(bad)?;
        if pools.is_empty() || pools.len() > 8 {
            return Err(bad);
        }
        let mut previous = address(&r.token_in)?;
        for pool in pools {
            if !["v2-pool", "v3-pool", "v4-pool"].contains(&pool["type"].as_str().unwrap_or("")) {
                return Err(bad);
            }
            if pool["type"] == "v4-pool" && pool["hooks"] != format!("{:#x}", Address::ZERO) {
                return Err(bad);
            }
            if pool["type"] == "v4-pool" {
                let id = pool["address"].as_str().ok_or(bad)?;
                if id.len() != 66
                    || !id.starts_with("0x")
                    || !id[2..].bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return Err(bad);
                }
            } else {
                addr(&pool["address"])?;
            }
            for name in ["tokenIn", "tokenOut"] {
                let t = &pool[name];
                let a = addr(&t["address"])?;
                if t["chainId"].as_u64().map(|n| n.to_string()) != Some(c.chain_id.clone()) {
                    return Err(bad);
                }
                let known = c
                    .tokens
                    .iter()
                    .find(|t| address(&t.address).ok() == Some(a))
                    .ok_or(bad)?;
                if t["decimals"].as_str() != Some(known.decimals.to_string().as_str())
                    || ["buyFeeBps", "sellFeeBps"].iter().any(|n| {
                        t.get(*n)
                            .is_some_and(|v| v != 0 && v != "0" && !v.is_null())
                    })
                {
                    return Err(bad);
                }
            }
            if addr(&pool["tokenIn"]["address"])? != previous {
                return Err(bad);
            }
            previous = addr(&pool["tokenOut"]["address"])?;
        }
        if previous != address(&r.token_out)? {
            return Err(bad);
        }
        total_in = total_in
            .checked_add(number(&pools[0]["amountIn"])?)
            .ok_or(bad)?;
        total_out = total_out
            .checked_add(number(&pools[pools.len() - 1]["amountOut"])?)
            .ok_or(bad)?;
    }
    if total_in != uint(&r.amount_raw)? || total_out != number(&q["output"]["amount"])? {
        return Err(bad);
    }
    Ok(())
}
fn check_permit(
    c: &SwapQuoteConfiguration,
    r: &SwapQuoteRequest,
    p: &Value,
    now: i64,
) -> Result<()> {
    let bad = QuoteError::InvalidResponse;
    let types = json!({"PermitSingle":[{"name":"details","type":"PermitDetails"},{"name":"spender","type":"address"},{"name":"sigDeadline","type":"uint256"}],"PermitDetails":[{"name":"token","type":"address"},{"name":"amount","type":"uint160"},{"name":"expiration","type":"uint48"},{"name":"nonce","type":"uint48"}]});
    let domain = &p["domain"];
    if p["types"] != types
        || domain.as_object().is_none_or(|d| d.len() != 3)
        || domain["name"] != "Permit2"
        || domain["chainId"].as_u64().map(|v| v.to_string()) != Some(c.chain_id.clone())
        || addr(&domain["verifyingContract"])? != address(&c.permit2)?
    {
        return Err(bad);
    }
    let values = &p["values"];
    let details = &values["details"];
    if values.as_object().is_none_or(|v| v.len() != 3)
        || details.as_object().is_none_or(|v| v.len() != 4)
        || addr(&values["spender"])? != address(&c.router)?
        || addr(&details["token"])? != address(&r.token_in)?
        || number(&details["amount"])? != uint(&r.amount_raw)?
    {
        return Err(bad);
    }
    // JSON uint48 numbers are lossless. Permit amounts always remain strings.
    let small = |v: &Value| -> Result<u64> {
        let n = if let Some(n) = v.as_u64() {
            n
        } else {
            number(v)?.try_into().map_err(|_| bad)?
        };
        if n >= (1u64 << 48) {
            return Err(bad);
        }
        Ok(n)
    };
    let expiration = small(&details["expiration"])?;
    let deadline = small(&values["sigDeadline"])?;
    small(&details["nonce"])?;
    let seconds = (now / 1000) as u64;
    if expiration <= seconds
        || expiration > seconds + 30 * 24 * 60 * 60 + 60
        || deadline <= seconds
        || deadline > seconds + 30 * 60 + 60
    {
        return Err(bad);
    }
    Ok(())
}

// Accept equivalent JSON decimal spellings without doing money arithmetic in f64.
fn scaled_decimal(value: &Value, places: usize) -> Result<u64> {
    let n = value
        .as_number()
        .ok_or(QuoteError::InvalidResponse)?
        .to_string();
    let (whole, fraction) = n.split_once('.').unwrap_or((&n, ""));
    let fraction = fraction.trim_end_matches('0');
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > places
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(QuoteError::InvalidResponse);
    }
    format!(
        "{}{}{}",
        whole,
        fraction,
        "0".repeat(places - fraction.len())
    )
    .parse()
    .map_err(|_| QuoteError::InvalidResponse)
}

#[cfg(test)]
pub(crate) use build::{execution_context, execution_fixture, local_service_fixture};

#[cfg(test)]
mod tests {
    use super::*;
    fn a(n: u8) -> String {
        format!("{:#x}", Address::repeat_byte(n))
    }
    fn config() -> SwapQuoteConfiguration {
        SwapQuoteConfiguration {
            provider: "uniswap",
            chain_id: "1".into(),
            router: a(4),
            permit2: a(5),
            router_version: ROUTER_VERSION,
            tokens: vec![
                SwapToken {
                    address: a(2),
                    symbol: "IN".into(),
                    decimals: 6,
                },
                SwapToken {
                    address: a(3),
                    symbol: "OUT".into(),
                    decimals: 18,
                },
            ],
            integrator_fees: vec![IntegratorFee {
                recipient: a(6),
                bps: 100,
            }],
            registry_revision: "fixture-v1".into(),
            fee_policy_revision: "fixture-fee-v1".into(),
            execution_available: false,
        }
    }
    #[test]
    fn zksync_cannot_configure_a_router_version_it_does_not_deploy() {
        let c = config();
        let redis = RedisStore::new(
            redis::Client::open("redis://127.0.0.1:1").unwrap(),
            "uniswap-version-test".into(),
            Duration::from_secs(1),
        );
        let result = UniswapQuotes::new(
            FileConfig {
                api_key: Zeroizing::new("public-fixture".into()),
                account_scope: "fixture".into(),
                interval_ms: 167,
                chain_id: 324,
                router: c.router,
                permit2: c.permit2,
                tokens: c.tokens,
                integrator_fees: c.integrator_fees,
                registry_revision: c.registry_revision,
                fee_policy_revision: c.fee_policy_revision,
            },
            324,
            redis,
            Arc::new(Metrics::default()),
        );
        assert!(matches!(result, Err(QuoteError::InvalidRequest)));
    }
    fn request() -> SwapQuoteRequest {
        SwapQuoteRequest {
            token_in: a(2),
            token_out: a(3),
            amount_raw: "1000000".into(),
            slippage_bps: 50,
        }
    }
    fn fixture() -> Value {
        json!({"routing":"CLASSIC","requestId":"fixture-request","permitData":null,"quote":{
            "tradeType":"EXACT_INPUT","chainId":1,"swapper":a(1),"slippage":0.5,"quoteId":"fixture-quote","blockNumber":"100","gasFee":"1200000000000","txFailureReasons":[],
            "input":{"token":a(2),"amount":"1000000"},"output":{"token":a(3),"amount":"2000000","recipient":a(1)},
            "aggregatedOutputs":[{"token":a(3),"amount":"1980000","recipient":a(1),"bps":9900,"minAmount":"1970100"},{"token":a(3),"amount":"20000","recipient":a(6),"bps":100,"minAmount":"19900","fee":"INTEGRATOR"}],
            "route":[[{"type":"v3-pool","address":a(7),"amountIn":"1000000","amountOut":"2000000","tokenIn":{"address":a(2),"chainId":1,"decimals":"6"},"tokenOut":{"address":a(3),"chainId":1,"decimals":"18"}}]]
        }})
    }
    fn permit(now: i64) -> Value {
        json!({"domain":{"name":"Permit2","chainId":1,"verifyingContract":a(5)},
            "types":{"PermitSingle":[{"name":"details","type":"PermitDetails"},{"name":"spender","type":"address"},{"name":"sigDeadline","type":"uint256"}],"PermitDetails":[{"name":"token","type":"address"},{"name":"amount","type":"uint160"},{"name":"expiration","type":"uint48"},{"name":"nonce","type":"uint48"}]},
            "values":{"details":{"token":a(2),"amount":"1000000","expiration":now/1000+3600,"nonce":0},"spender":a(4),"sigDeadline":(now/1000+600).to_string()}})
    }
    #[test]
    fn classic_quote_conserves_amounts_and_discloses_net_output() {
        let result = normalize(&config(), &a(1), &request(), &fixture(), now_ms()).unwrap();
        assert_eq!(result.gross_output_raw, "2000000");
        assert_eq!(result.net_output_raw, "1980000");
        assert_eq!(result.minimum_output_raw, "1970100");
        assert_eq!(result.fees[0].amount_raw, "20000");
        assert!(!result.execution_available);
        assert!(!result.approval_gas_included);
        // V4 route addresses are pool IDs in the official routing implementation,
        // despite the Trading OAS reusing its 20-byte contractAddress schema.
        let mut v = fixture();
        v["quote"]["route"][0][0]["type"] = json!("v4-pool");
        v["quote"]["route"][0][0]["address"] = json!(format!("0x{}", "aa".repeat(32)));
        v["quote"]["route"][0][0]["hooks"] = json!(format!("{:#x}", Address::ZERO));
        assert!(normalize(&config(), &a(1), &request(), &v, now_ms()).is_ok());
        v["quote"]
            .as_object_mut()
            .unwrap()
            .remove("txFailureReasons");
        assert!(normalize(&config(), &a(1), &request(), &v, now_ms()).is_ok());
    }
    #[test]
    fn rejects_identity_economic_route_and_simulation_substitution() {
        for (path, value) in [
            ("/routing", json!("DUTCH_V3")),
            ("/quote/tradeType", json!("EXACT_OUTPUT")),
            ("/quote/chainId", json!(10)),
            ("/quote/swapper", json!(a(8))),
            ("/quote/input/amount", json!("01")),
            ("/quote/input/token", json!(a(8))),
            ("/quote/output/recipient", json!(a(8))),
            ("/quote/output/amount", json!("2000001")),
            ("/quote/slippage", json!(5)),
            ("/quote/aggregatedOutputs/0/minAmount", json!("1970099")),
            ("/quote/aggregatedOutputs/0/amount", json!("2000000")),
            ("/quote/aggregatedOutputs/1/recipient", json!(a(8))),
            ("/quote/aggregatedOutputs/1/bps", json!(99)),
            ("/quote/aggregatedOutputs/1/fee", json!("UNKNOWN")),
            ("/quote/route/0/0/amountIn", json!("999999")),
            ("/quote/route/0/0/amountOut", json!("1999999")),
            ("/quote/route/0/0/tokenOut/decimals", json!("6")),
            ("/quote/route/0/0/tokenOut/address", json!(a(8))),
            ("/quote/route/0/0/tokenOut/chainId", json!(10)),
            ("/quote/txFailureReasons", json!(["TRANSFER_FROM_FAILED"])),
            ("/quote/gasFee", json!(1)),
            ("/permitData", json!({})),
            ("/quote/route", json!([])),
        ] {
            let mut v = fixture();
            *v.pointer_mut(path).unwrap() = value;
            assert!(
                normalize(&config(), &a(1), &request(), &v, now_ms()).is_err(),
                "{path}"
            );
        }
        let mut v = fixture();
        v["quote"]["portionAmount"] = json!("1");
        assert!(normalize(&config(), &a(1), &request(), &v, now_ms()).is_err());
        v = fixture();
        v["quote"]["route"][0][0]["tokenIn"]["sellFeeBps"] = json!(1);
        assert!(normalize(&config(), &a(1), &request(), &v, now_ms()).is_err());
    }
    #[test]
    fn permit_is_exact_scoped_and_time_bounded_without_signing() {
        let now = now_ms();
        let mut v = fixture();
        v["permitData"] = permit(now);
        assert!(
            normalize(&config(), &a(1), &request(), &v, now)
                .unwrap()
                .permit_required
        );
        for (path, value) in [
            ("/domain/chainId", json!(10)),
            ("/domain/name", json!("other")),
            ("/domain/verifyingContract", json!(a(8))),
            ("/values/spender", json!(a(8))),
            (
                "/values/details/amount",
                json!("1461501637330902918203684832716283019655932542975"),
            ),
            ("/values/details/token", json!(a(8))),
            ("/values/details/expiration", json!(now / 1000)),
            ("/values/details/nonce", json!(281474976710656u64)),
            (
                "/values/sigDeadline",
                json!((now / 1000 + 4000).to_string()),
            ),
            ("/types/PermitDetails/1/type", json!("uint256")),
        ] {
            let mut changed = v.clone();
            *changed["permitData"].pointer_mut(path).unwrap() = value;
            assert!(
                normalize(&config(), &a(1), &request(), &changed, now).is_err(),
                "{path}"
            );
        }
    }
    #[test]
    fn percentage_parsing_does_not_round_fractional_bps_or_accept_unknown_precision() {
        assert_eq!(scaled_decimal(&json!(0.5), 2).unwrap(), 50);
        assert_eq!(scaled_decimal(&json!(1.0), 2).unwrap(), 100);
        assert_eq!(scaled_decimal(&json!(100.0), 0).unwrap(), 100);
        assert!(scaled_decimal(&json!(0.001), 2).is_err());
        assert!(scaled_decimal(&json!(-1), 2).is_err());
    }
    #[tokio::test]
    #[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
    async fn credentials_stay_in_headers_and_replicas_share_admission_and_cooldown() {
        use axum::{Json, Router, extract::State, http::HeaderMap, routing::post};
        use std::sync::atomic::{AtomicUsize, Ordering};
        #[derive(Clone)]
        struct Mock {
            calls: Arc<AtomicUsize>,
            mode: Arc<AtomicUsize>,
        }
        async fn handler(
            State(s): State<Mock>,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> axum::response::Response {
            use axum::response::IntoResponse;
            s.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(headers["x-api-key"], "public-fixture");
            assert_eq!(headers["x-universal-router-version"], "2.1.2");
            assert_eq!(headers["x-permit2-disabled"], "false");
            assert_eq!(body["permitAmount"], "EXACT");
            assert_eq!(body["recipient"], a(1));
            assert_eq!(body["protocols"], json!(["V2", "V3", "V4"]));
            assert!(body.get("apiKey").is_none());
            match s.mode.load(Ordering::SeqCst) {
                1 => (
                    StatusCode::TEMPORARY_REDIRECT,
                    [("location", "http://127.0.0.1:1/credential-sink")],
                )
                    .into_response(),
                2 => (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "120")]).into_response(),
                3 => (StatusCode::OK, "x".repeat(MAX_BODY + 1)).into_response(),
                _ => Json(fixture()).into_response(),
            }
        }
        let namespace = format!("uniswap-test:{}", uuid::Uuid::new_v4().simple());
        let redis = RedisStore::new(
            redis::Client::open(std::env::var("TEST_REDIS_URL").unwrap()).unwrap(),
            namespace,
            Duration::from_secs(1),
        );
        let make = || {
            let c = config();
            UniswapQuotes::new(
                FileConfig {
                    api_key: Zeroizing::new("public-fixture".into()),
                    account_scope: "fixture".into(),
                    interval_ms: 167,
                    chain_id: 1,
                    router: c.router,
                    permit2: c.permit2,
                    tokens: c.tokens,
                    integrator_fees: c.integrator_fees,
                    registry_revision: c.registry_revision,
                    fee_policy_revision: c.fee_policy_revision,
                },
                1,
                redis.clone(),
                Arc::new(Metrics::default()),
            )
            .unwrap()
        };
        let state = Mock {
            calls: Arc::new(AtomicUsize::new(0)),
            mode: Arc::new(AtomicUsize::new(0)),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/quote", post(handler))
            .with_state(state.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut one = make();
        let mut two = make();
        // Permit2 reserves uint160::MAX for unlimited allowance, even with EXACT.
        let mut boundary = request();
        let unlimited = U256::from(1u8).wrapping_shl(160) - U256::from(1u8);
        boundary.amount_raw = unlimited.to_string();
        assert!(one.request(&a(1), &boundary).is_err());
        boundary.amount_raw = (unlimited - U256::from(1u8)).to_string();
        assert!(one.request(&a(1), &boundary).is_ok());
        one.origin = Some(origin.clone());
        two.origin = Some(origin);
        assert!(format!("{:?}", one.key).contains("Sensitive"));
        assert!(one.quote(&a(1), request()).await.is_ok());
        state.mode.store(1, Ordering::SeqCst);
        assert!(two.quote(&a(1), request()).await.is_err());
        state.mode.store(3, Ordering::SeqCst);
        assert!(one.quote(&a(1), request()).await.is_err());
        state.mode.store(2, Ordering::SeqCst);
        assert!(one.quote(&a(1), request()).await.is_err());
        let calls = state.calls.load(Ordering::SeqCst);
        state.mode.store(0, Ordering::SeqCst);
        assert!(two.quote(&a(1), request()).await.is_err());
        assert_eq!(state.calls.load(Ordering::SeqCst), calls);
        let _: i32 = redis
            .query(
                redis::cmd("DEL")
                    .arg(redis.key("rpc-budget-uniswap-fixture", "policy"))
                    .arg(redis.key("rpc-budget-uniswap-fixture", "next"))
                    .arg(redis.key("rpc-budget-uniswap-fixture", "cooldown")),
            )
            .await
            .unwrap();
        task.abort();
        let _ = task.await;
    }
}
