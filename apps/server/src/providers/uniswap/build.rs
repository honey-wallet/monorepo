//! Fixed-origin CLASSIC construction, preserving separately persisted authority.
//! A verified build is not a simulated, nonce-bound or signable PreparedEvm.
use super::*;
use crate::{
    identity::digest,
    preparation::canonical,
    providers::{
        permit2::PermitTerms,
        uniswap_economics::{FeeAuthority, RouterCall, SwapAuthority, validate_economics},
        uniswap_router::{self, Command},
    },
    swap_review::{SwapBuildContext, SwapReview},
};
use zeroize::Zeroize;

// Provider payloads can contain a live transferable permit. Never derive Debug.
struct SensitiveJson(Value);
impl Drop for SensitiveJson {
    fn drop(&mut self) {
        fn wipe(v: &mut Value) {
            match v {
                Value::String(s) => s.zeroize(),
                Value::Array(v) => v.iter_mut().for_each(wipe),
                Value::Object(v) => v.values_mut().for_each(wipe),
                _ => {}
            }
        }
        wipe(&mut self.0);
    }
}
/// Fresh validated provider artifact. Private fields prevent manufacturing this
/// type from client JSON; caller must still bind it to intent and chain evidence.
pub struct ValidatedSwapQuote {
    quote: SwapQuote,
    raw_quote: Zeroizing<Vec<u8>>,
    permit: Option<PermitTerms>,
    configuration: SwapQuoteConfiguration,
}
pub struct ReviewOptions {
    pub intent_hash: String,
    pub deadline: String,
    pub maximum_network_fee_raw: String,
    /// Explicit reviewed base-unit allowance. Never inferred from provider amounts.
    pub maximum_fee_rounding_raw: u8,
}
impl ValidatedSwapQuote {
    pub fn quote(&self) -> &SwapQuote {
        &self.quote
    }
    pub fn raw_quote(&self) -> &[u8] {
        &self.raw_quote
    }
    pub fn review(&self, options: ReviewOptions) -> Result<SwapReview> {
        self.review_at(options, now_ms())
    }
    fn review_at(&self, options: ReviewOptions, now: i64) -> Result<SwapReview> {
        if now < self.quote.received_at_ms
            || now >= self.quote.expires_at_ms
            || options.maximum_fee_rounding_raw > 1
        {
            return Err(QuoteError::InvalidRequest);
        }
        let expires = options
            .deadline
            .parse::<i64>()
            .ok()
            .and_then(|v| v.checked_mul(1000))
            .ok_or(QuoteError::InvalidRequest)?;
        let review = SwapReview {
            schema_version: 1,
            intent_hash: options.intent_hash,
            quote_id: self.quote.quote_id.clone(),
            provider_quote_hash: hex::encode(digest(&self.raw_quote)),
            registry_revision: self.configuration.registry_revision.clone(),
            fee_policy_revision: self.configuration.fee_policy_revision.clone(),
            authority: SwapAuthority {
                chain_id: self.quote.chain_id.clone(),
                owner: self.quote.signer.clone(),
                router: self.configuration.router.clone(),
                token_in: self.quote.token_in.clone(),
                token_out: self.quote.token_out.clone(),
                maximum_input_raw: self.quote.amount_in_raw.clone(),
                minimum_output_raw: self.quote.minimum_output_raw.clone(),
                deadline: options.deadline,
                fee_basis: "settlement_balance".into(),
                tokens: self
                    .configuration
                    .tokens
                    .iter()
                    .map(|t| t.address.clone())
                    .collect(),
                fees: self
                    .configuration
                    .integrator_fees
                    .iter()
                    .map(|f| FeeAuthority {
                        recipient: f.recipient.clone(),
                        maximum_bps: f.bps.to_string(),
                        maximum_rounding_raw: options.maximum_fee_rounding_raw.to_string(),
                    })
                    .collect(),
            },
            permit2: self.configuration.permit2.clone(),
            permit: self.permit.clone(),
            maximum_network_fee_raw: options.maximum_network_fee_raw,
            quote_observed_at_ms: self.quote.received_at_ms,
            reviewed_at_ms: now,
            expires_at_ms: expires,
        };
        review.validate().map_err(|_| QuoteError::InvalidRequest)?;
        Ok(review)
    }
}
/// Provider gas hints are checked for internal consistency and the reviewed cap,
/// but never replace local estimation, pending nonce discovery or simulation.
pub struct BuildGasEstimate {
    pub gas_limit: String,
    pub max_fee_per_gas: String,
    pub max_priority_fee_per_gas: String,
}
/// Sensitive calldata: no Debug/Serialize. Carries proof provenance, not execution
/// permission. A service must independently attest chain state before preparation.
pub struct VerifiedSwapBuild {
    request_id: String,
    source_block: String,
    quote_id: String,
    review_hash: String,
    call: RouterCall,
    gas_estimate: Option<BuildGasEstimate>,
}
impl VerifiedSwapBuild {
    pub fn source_block(&self) -> &str {
        &self.source_block
    }
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn quote_id(&self) -> &str {
        &self.quote_id
    }
    pub fn review_hash(&self) -> &str {
        &self.review_hash
    }
    pub fn call(&self) -> &RouterCall {
        &self.call
    }
    pub fn gas_estimate(&self) -> Option<&BuildGasEstimate> {
        self.gas_estimate.as_ref()
    }
}

fn small(v: &Value) -> Result<String> {
    let n = if let Some(n) = v.as_u64() {
        U256::from(n)
    } else {
        number(v)?
    };
    if n >= U256::from(1).wrapping_shl(48) {
        return Err(QuoteError::InvalidResponse);
    }
    Ok(n.to_string())
}
fn permit_terms(
    c: &SwapQuoteConfiguration,
    owner: &str,
    permit: &Value,
) -> Result<Option<PermitTerms>> {
    if permit.is_null() {
        return Ok(None);
    }
    let v = &permit["values"];
    Ok(Some(PermitTerms {
        chain_id: c.chain_id.clone(),
        permit2: c.permit2.clone(),
        owner: owner.into(),
        token: format!("{:#x}", addr(&v["details"]["token"])?),
        amount_raw: number(&v["details"]["amount"])?.to_string(),
        spender: format!("{:#x}", addr(&v["spender"])?),
        nonce: small(&v["details"]["nonce"])?,
        expiration: small(&v["details"]["expiration"])?,
        sig_deadline: small(&v["sigDeadline"])?,
    }))
}
/// Fixed EIP-712 schema; never reuse arbitrary provider/client type definitions.
fn permit_data(p: &PermitTerms) -> Result<Value> {
    let chain = p
        .chain_id
        .parse::<u64>()
        .map_err(|_| QuoteError::InvalidRequest)?;
    Ok(
        json!({"domain":{"name":"Permit2","chainId":chain,"verifyingContract":p.permit2},
        "types":{"PermitSingle":[{"name":"details","type":"PermitDetails"},{"name":"spender","type":"address"},{"name":"sigDeadline","type":"uint256"}],"PermitDetails":[{"name":"token","type":"address"},{"name":"amount","type":"uint160"},{"name":"expiration","type":"uint48"},{"name":"nonce","type":"uint48"}]},
        "values":{"details":{"token":p.token,"amount":p.amount_raw,"expiration":p.expiration,"nonce":p.nonce},"spender":p.spender,"sigDeadline":p.sig_deadline}}),
    )
}
fn artifact(
    c: &SwapQuoteConfiguration,
    signer: &str,
    r: &SwapQuoteRequest,
    response: &Value,
    now: i64,
) -> Result<ValidatedSwapQuote> {
    let quote = normalize(c, signer, r, response, now)?;
    let raw = canonical(&response["quote"]).map_err(|_| QuoteError::InvalidResponse)?;
    let permit = permit_terms(c, &quote.signer, &response["permitData"])?;
    Ok(ValidatedSwapQuote {
        quote,
        raw_quote: Zeroizing::new(raw.as_bytes().to_vec()),
        permit,
        configuration: c.clone(),
    })
}
fn build_request(
    c: &SwapQuoteConfiguration,
    context: &SwapBuildContext,
    now: i64,
) -> Result<SensitiveJson> {
    let bad = QuoteError::InvalidRequest;
    let review = &context.review;
    review.validate().map_err(|_| bad)?;
    if now < review.reviewed_at_ms
        || now >= review.expires_at_ms
        || context.provider_quote.len() > MAX_BODY
        || review.registry_revision != c.registry_revision
        || review.fee_policy_revision != c.fee_policy_revision
        || review.authority.chain_id != c.chain_id
        || review.authority.router != c.router
        || review.permit2 != c.permit2
        || review.authority.tokens
            != c.tokens
                .iter()
                .map(|t| t.address.clone())
                .collect::<Vec<_>>()
        || review.authority.fees.len() != c.integrator_fees.len()
        || review
            .authority
            .fees
            .iter()
            .zip(&c.integrator_fees)
            .any(|(a, b)| a.recipient != b.recipient || a.maximum_bps != b.bps.to_string())
    {
        return Err(bad);
    }
    let q = SensitiveJson(serde_json::from_slice(&context.provider_quote).map_err(|_| bad)?);
    if canonical(&q.0).map_err(|_| bad)?.as_bytes() != context.provider_quote.as_slice() {
        return Err(bad);
    }
    review.bind_quote(&q.0).map_err(|_| bad)?;
    let request = SwapQuoteRequest {
        token_in: review.authority.token_in.clone(),
        token_out: review.authority.token_out.clone(),
        amount_raw: review.authority.maximum_input_raw.clone(),
        slippage_bps: scaled_decimal(&q.0["slippage"], 2)?
            .try_into()
            .map_err(|_| bad)?,
    };
    if request.slippage_bps > 1000 {
        return Err(bad);
    }
    // Revalidate exact raw quote under current config. The original observation
    // clock is preserved; this does not create a fresh quote or extend its lifetime.
    let permit = review.permit.as_ref().map(permit_data).transpose()?;
    let response = SensitiveJson(
        json!({"routing":"CLASSIC","requestId":review.quote_id,"quote":q.0,"permitData":permit}),
    );
    let normalized = normalize(
        c,
        &review.authority.owner,
        &request,
        &response.0,
        review.reviewed_at_ms,
    )?;
    if normalized.minimum_output_raw != review.authority.minimum_output_raw {
        return Err(bad);
    }
    match (&review.permit, &context.signature) {
        (Some(p), Some(signature)) => {
            p.verify_signature(signature, (now / 1000) as u64)
                .map_err(|_| bad)?;
        }
        (None, None) => {}
        _ => return Err(bad),
    }
    // SAFE adds a native sweep outside the current ERC20 vocabulary. This path
    // independently requires zero native value and rejects wrap/native routes.
    // A provider single-call simulation cannot include not-yet-mined approvals.
    // The service must locally simulate the entire approval/action sequence.
    let mut body = SensitiveJson(
        json!({"quote":q.0,"deadline":review.expires_at_ms/1000,"simulateTransaction":false,"refreshGasPrice":true,"urgency":"normal","swapSource":"WALLET"}),
    );
    if let Some(signature) = &context.signature {
        body.0["signature"] = Value::String(signature.to_string());
        body.0["permitData"] = permit.ok_or(bad)?;
    }
    // Worst-case request includes quote, permit and signature, slightly larger
    // than the accepted provider quote/response bound. Explicitly bound it too.
    if canonical(&body.0).map_err(|_| bad)?.len() > MAX_BODY + 4096 {
        return Err(bad);
    }
    Ok(body)
}
fn build_response(
    context: &SwapBuildContext,
    response: &Value,
    now: i64,
) -> Result<VerifiedSwapBuild> {
    let bad = QuoteError::InvalidResponse;
    let review = &context.review;
    if now < review.reviewed_at_ms || now >= review.expires_at_ms {
        return Err(bad);
    }
    let swap = &response["swap"];
    let fields = swap.as_object().ok_or(bad)?;
    if fields.keys().any(|k| {
        ![
            "to",
            "from",
            "data",
            "value",
            "chainId",
            "gasLimit",
            "maxFeePerGas",
            "maxPriorityFeePerGas",
            "gasPrice",
        ]
        .contains(&k.as_str())
    }) || swap.get("gasPrice").is_some_and(|v| !v.is_null())
        || !matches!(swap["value"].as_str(), Some("0" | "0x0" | "0x00"))
        || swap["chainId"].as_u64().map(|v| v.to_string())
            != Some(review.authority.chain_id.clone())
    {
        return Err(bad);
    }
    let call = RouterCall {
        chain_id: review.authority.chain_id.clone(),
        from: format!("{:#x}", addr(&swap["from"])?),
        to: format!("{:#x}", addr(&swap["to"])?),
        value_raw: "0".into(),
        data: Zeroizing::new(swap["data"].as_str().ok_or(bad)?.into()),
    };
    let execution = uniswap_router::decode(&call.data).map_err(|_| bad)?;
    execution
        .verify_embedded_permit(review.permit.as_ref(), (now / 1000) as u64)
        .map_err(|_| bad)?;
    if let Some(expected) = &context.signature {
        match execution.commands.first() {
            Some(Command::PermitSingle { signature, .. })
                if signature.as_str() == expected.as_str() => {}
            _ => return Err(bad),
        }
    }
    validate_economics(&review.authority, &call, (now / 1000) as u64).map_err(|error| {
        tracing::warn!(reason = ?error, "Uniswap build economic proof rejected");
        bad
    })?;
    let gas_estimate = match (
        swap.get("gasLimit"),
        swap.get("maxFeePerGas"),
        swap.get("maxPriorityFeePerGas"),
    ) {
        (None, None, None) => None,
        (Some(g), Some(m), Some(p)) => {
            let (gas, max, priority) = (number(g)?, number(m)?, number(p)?);
            if gas < U256::from(21000)
                || gas > U256::from(2_000_000)
                || max == U256::ZERO
                || max > U256::from(u128::MAX)
                || priority > max
                || gas.checked_mul(max).ok_or(bad)? > uint(&review.maximum_network_fee_raw)?
            {
                return Err(bad);
            }
            Some(BuildGasEstimate {
                gas_limit: gas.to_string(),
                max_fee_per_gas: max.to_string(),
                max_priority_fee_per_gas: priority.to_string(),
            })
        }
        _ => return Err(bad),
    };
    if response.get("gasFee").is_some_and(|v| {
        number(v).ok().is_none_or(|n| {
            uint(&review.maximum_network_fee_raw)
                .ok()
                .is_none_or(|cap| n > cap)
        })
    }) {
        return Err(bad);
    }
    let quote = SensitiveJson(serde_json::from_slice(&context.provider_quote).map_err(|_| bad)?);
    let source_block = number(&quote.0["blockNumber"])?;
    if source_block > U256::from(u64::MAX) {
        return Err(bad);
    }
    Ok(VerifiedSwapBuild {
        source_block: source_block.to_string(),
        request_id: bounded_id(&response["requestId"])?,
        quote_id: review.quote_id.clone(),
        review_hash: review.integrity_hash().map_err(|_| bad)?,
        call,
        gas_estimate,
    })
}
impl UniswapQuotes {
    /// Internal execution artifact; the public quote response still contains no
    /// arbitrary provider JSON or signature request. Shares account quota with builds.
    #[tracing::instrument(name = "provider.uniswap_quote_for_review", skip_all)]
    pub async fn quote_for_review(
        &self,
        signer: &str,
        request: SwapQuoteRequest,
    ) -> Result<ValidatedSwapQuote> {
        let body = self.request(signer, &request)?;
        let start = Instant::now();
        let result = async {
            let bytes = self.fetch(Endpoint::Quote, &body).await?;
            let response = SensitiveJson(
                serde_json::from_slice(&bytes).map_err(|_| QuoteError::InvalidResponse)?,
            );
            artifact(&self.configuration, signer, &request, &response.0, now_ms())
        }
        .await;
        self.metrics.swap_quote(
            result.as_ref().err().map(|e| e.code()).unwrap_or("ok"),
            start.elapsed().as_secs_f64(),
        );
        result
    }
    /// Revalidate the exact saved call for pre-send simulation without obtaining
    /// replacement calldata or another provider quote. The caller authenticates
    /// the durable review/preparation before invoking this method.
    pub(crate) fn restore_build(
        &self,
        context: &SwapBuildContext,
        prepared: &crate::providers::evm_prepare::PreparedEvm,
        request_id: &str,
    ) -> Result<VerifiedSwapBuild> {
        build_request(&self.configuration, context, now_ms())?;
        let call = prepared
            .plan
            .steps
            .last()
            .ok_or(QuoteError::InvalidRequest)?;
        let response = SensitiveJson(json!({"requestId":request_id,"swap":{
            "chainId":self.chain,"from":prepared.plan.signer,"to":call.to,"value":call.value_raw,"data":call.data
        }}));
        build_response(context, &response.0, now_ms())
    }
    /// Constructs calldata only. Never sends an Ethereum transaction, stores a
    /// private key or accepts provider simulation as local execution admission.
    #[tracing::instrument(name = "provider.uniswap_build", skip_all)]
    pub async fn build_swap(&self, context: &SwapBuildContext) -> Result<VerifiedSwapBuild> {
        let start = Instant::now();
        let result = async {
            let body = build_request(&self.configuration, context, now_ms())?;
            let remaining = context.review.expires_at_ms - now_ms();
            if remaining <= 0 {
                return Err(QuoteError::InvalidRequest);
            }
            let bytes = tokio::time::timeout(
                Duration::from_millis((remaining as u64).min(10_000)),
                self.fetch(
                    Endpoint::Swap {
                        expires_at_ms: context.review.expires_at_ms,
                    },
                    &body.0,
                ),
            )
            .await
            .map_err(|_| QuoteError::Unavailable)??;
            let response = SensitiveJson(
                serde_json::from_slice(&bytes).map_err(|_| QuoteError::InvalidResponse)?,
            );
            build_response(context, &response.0, now_ms())
        }
        .await;
        self.metrics.swap_build(
            result.as_ref().err().map(|e| e.code()).unwrap_or("ok"),
            start.elapsed().as_secs_f64(),
        );
        result
    }
}

#[cfg(test)]
pub(crate) fn execution_fixture(now: i64, route: Option<&str>) -> (SwapReview, VerifiedSwapBuild) {
    let (context, build) = execution_context(now, route, None);
    (context.review, build)
}
#[cfg(test)]
pub(crate) fn execution_context(
    now: i64,
    route: Option<&str>,
    intent: Option<&str>,
) -> (SwapBuildContext, VerifiedSwapBuild) {
    let (_, mut context, mut response) = tests::fixture(now);
    if let Some(name) = route {
        let source: Value = serde_json::from_str(include_str!(
            "../../../../../packages/api-client/src/fixtures/uniswap-economics.json"
        ))
        .unwrap();
        let item = source["valid"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == name)
            .unwrap();
        let old_deadline = item["policy"]["deadline"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let deadline = context.review.authority.deadline.clone();
        context.review.authority = serde_json::from_value(item["policy"].clone()).unwrap();
        context.review.authority.deadline = deadline.clone();
        context.review.permit = None;
        context.signature = None;
        for field in ["from", "to", "data"] {
            response["swap"][field] = item["call"][field].clone();
        }
        response["swap"]["data"] =
            Value::String(response["swap"]["data"].as_str().unwrap().replace(
                &format!("{old_deadline:064x}"),
                &format!("{:064x}", deadline.parse::<u64>().unwrap()),
            ));
    }
    if let Some(intent) = intent {
        context.review.intent_hash = intent.into();
    }
    // Route fixture authority may use a different owner. Bind the synthetic raw
    // quote for storage tests; this is not a live quote-normalization acceptance.
    if route.is_some() {
        let mut quote: Value = serde_json::from_slice(&context.provider_quote).unwrap();
        quote["swapper"] = json!(context.review.authority.owner);
        quote["input"]["token"] = json!(context.review.authority.token_in);
        quote["output"]["token"] = json!(context.review.authority.token_out);
        context.provider_quote = Zeroizing::new(canonical(&quote).unwrap().as_bytes().to_vec());
        context.review.provider_quote_hash = hex::encode(digest(&context.provider_quote));
    }
    let build = build_response(&context, &response, now).unwrap();
    (context, build)
}

#[cfg(test)]
pub(crate) fn local_service_fixture(
    now: i64,
) -> (SwapQuoteConfiguration, SwapBuildContext, Value, Value) {
    let (c, context, build) = tests::fixture_chain(now, 31337);
    let quote = json!({"requestId":"local-quote","routing":"CLASSIC","quote":serde_json::from_slice::<Value>(&context.provider_quote).unwrap(),"permitData":permit_data(context.review.permit.as_ref().unwrap()).unwrap()});
    (c, context, quote, build)
}
#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;
    fn source() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/sealed-swap-viem.json"
        ))
        .unwrap()
    }
    pub(super) fn fixture(now: i64) -> (SwapQuoteConfiguration, SwapBuildContext, Value) {
        fixture_chain(now, 1)
    }
    pub(super) fn fixture_chain(
        now: i64,
        chain: u64,
    ) -> (SwapQuoteConfiguration, SwapBuildContext, Value) {
        let original = source();
        let mut terms: PermitTerms = serde_json::from_value(original["terms"].clone()).unwrap();
        terms.chain_id = chain.to_string();
        let deadline = (now / 1000 + 600).to_string();
        terms.sig_deadline = deadline.clone();
        terms.expiration = deadline.clone();
        let c = SwapQuoteConfiguration {
            provider: "uniswap",
            chain_id: chain.to_string(),
            router: terms.spender.clone(),
            permit2: terms.permit2.clone(),
            router_version: ROUTER_VERSION,
            tokens: vec![
                SwapToken {
                    address: terms.token.clone(),
                    symbol: "IN".into(),
                    decimals: 6,
                },
                SwapToken {
                    address: format!("0x{:040x}", 30),
                    symbol: "OUT".into(),
                    decimals: 6,
                },
            ],
            integrator_fees: vec![],
            registry_revision: "synthetic-test-only".into(),
            fee_policy_revision: "synthetic-zero-fees".into(),
            execution_available: false,
        };
        let out = c.tokens[1].address.clone();
        let quote = json!({"quoteId":"synthetic-quote","tradeType":"EXACT_INPUT","chainId":chain,"swapper":terms.owner,"slippage":5,"blockNumber":"10","gasFee":"1000000000000000","txFailureReasons":[],
            "input":{"token":terms.token,"amount":"1000"},"output":{"token":out,"amount":"2000","recipient":terms.owner},"aggregatedOutputs":[{"token":out,"amount":"2000","minAmount":"1900","recipient":terms.owner}],
            "route":[[{"type":"v3-pool","address":format!("0x{:040x}",50),"amountIn":"1000","amountOut":"2000","tokenIn":{"address":terms.token,"chainId":chain,"decimals":"6"},"tokenOut":{"address":out,"chainId":chain,"decimals":"6"}}]]});
        let response = json!({"requestId":"fixture-quote","routing":"CLASSIC","quote":quote,"permitData":permit_data(&terms).unwrap()});
        let req = SwapQuoteRequest {
            token_in: terms.token.clone(),
            token_out: out,
            amount_raw: "1000".into(),
            slippage_bps: 500,
        };
        let artifact = artifact(&c, &terms.owner, &req, &response, now).unwrap();
        let review = artifact
            .review_at(
                ReviewOptions {
                    intent_hash: "a".repeat(64),
                    deadline: deadline.clone(),
                    maximum_network_fee_raw: "1000000000000000".into(),
                    maximum_fee_rounding_raw: 0,
                },
                now,
            )
            .unwrap();
        // Public fixture scalar 1. This function never contacts a live chain.
        let mut secret = [0; 32];
        secret[31] = 1;
        let (sig, rec) = SigningKey::from_bytes((&secret).into())
            .unwrap()
            .sign_prehash_recoverable(terms.digest((now / 1000) as u64).unwrap().as_slice())
            .unwrap();
        let signature = format!(
            "0x{}{:02x}",
            hex::encode(sig.to_bytes()),
            rec.to_byte() + 27
        );
        let data = original["prepared"]["plan"]["steps"][0]["data"]
            .as_str()
            .unwrap()
            .replace(
                &format!("{:064x}", 1900000600u64),
                &format!("{:064x}", deadline.parse::<u64>().unwrap()),
            )
            .replace(
                &original["signature"].as_str().unwrap()[2..],
                &signature[2..],
            );
        let build = json!({"requestId":"fixture-build","swap":{"to":terms.spender,"from":terms.owner,"chainId":chain,"value":"0x00","data":data,"gasLimit":"500000","maxFeePerGas":"2000000000","maxPriorityFeePerGas":"1000000000"},"gasFee":"1000000000000000"});
        (
            c,
            SwapBuildContext {
                review,
                provider_quote: artifact.raw_quote,
                signature: Some(Zeroizing::new(signature)),
            },
            build,
        )
    }
    #[test]
    fn artifact_review_and_exact_build_preserve_authority_and_permit() {
        let now = 1_900_000_000_000;
        let (c, context, response) = fixture(now);
        let request = build_request(&c, &context, now).unwrap();
        assert_eq!(request.0["deadline"], 1900000600u64);
        assert_eq!(
            request.0["quote"],
            serde_json::from_slice::<Value>(&context.provider_quote).unwrap()
        );
        assert_eq!(
            request.0["signature"],
            context.signature.as_ref().unwrap().as_str()
        );
        assert_eq!(request.0["permitData"]["values"]["details"]["nonce"], "7");
        assert_eq!(request.0["simulateTransaction"], false);
        assert_eq!(request.0["refreshGasPrice"], true);
        assert!(request.0.get("safetyMode").is_none());
        assert_eq!(request.0["swapSource"], "WALLET");
        assert!(request.0.get("enforceExactIn").is_none());
        let build = build_response(&context, &response, now).unwrap();
        assert_eq!(
            build.review_hash(),
            context.review.integrity_hash().unwrap()
        );
        assert_eq!(build.gas_estimate().unwrap().gas_limit, "500000");
        assert_eq!(build.call().value_raw, "0");
        let mut hints = response.clone();
        for field in ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"] {
            hints["swap"].as_object_mut().unwrap().remove(field);
        }
        assert!(
            build_response(&context, &hints, now)
                .unwrap()
                .gas_estimate()
                .is_none()
        );
    }
    #[test]
    fn all_supported_no_permit_route_shapes_pass_the_build_response_boundary() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../../packages/api-client/src/fixtures/uniswap-economics.json"
        ))
        .unwrap();
        let now = cases["now"].as_i64().unwrap() * 1000;
        for fixture in cases["valid"].as_array().unwrap() {
            let (_, mut context, mut response) = self::fixture(now);
            context.review.authority = serde_json::from_value(fixture["policy"].clone()).unwrap();
            context.review.expires_at_ms =
                context.review.authority.deadline.parse::<i64>().unwrap() * 1000;
            context.review.permit = None;
            context.signature = None;
            let call = &fixture["call"];
            for field in ["from", "to", "data"] {
                response["swap"][field] = call[field].clone();
            }
            assert!(
                build_response(&context, &response, now).is_ok(),
                "{}",
                fixture["name"]
            );
        }
    }

    #[test]
    fn response_mutations_reject_identity_deadline_economics_signature_and_fee_drift() {
        let now = 1_900_000_000_000;
        let (_, context, response) = fixture(now);
        for (field, value) in [
            ("to", json!(format!("0x{:040x}", 41))),
            ("from", json!(format!("0x{:040x}", 41))),
            ("value", json!("1")),
            ("chainId", json!(10)),
            ("gasLimit", json!("500001")),
            ("maxFeePerGas", json!("2000000001")),
            ("maxPriorityFeePerGas", json!("2000000001")),
            ("gasPrice", json!("1")),
            ("nonce", json!("7")),
            ("data", json!("0x00")),
        ] {
            let mut v = response.clone();
            v["swap"][field] = value;
            assert!(build_response(&context, &v, now).is_err(), "{field}");
        }
        let data = response["swap"]["data"].as_str().unwrap();
        for (from, to) in [
            (
                format!("{:064x}", 1900000600u64),
                format!("{:064x}", 1900000601u64),
            ),
            (format!("{:064x}", 1900), format!("{:064x}", 1899)),
            (format!("{:064x}", 1000), format!("{:064x}", 1001)),
            (
                context.signature.as_ref().unwrap()[2..].into(),
                "00".repeat(65),
            ),
        ] {
            let mut v = response.clone();
            let changed = data.replace(&from, &to);
            assert_ne!(data, changed);
            v["swap"]["data"] = json!(changed);
            assert!(build_response(&context, &v, now).is_err());
        }
        assert!(build_response(&context, &response, context.review.expires_at_ms).is_err());
        for value in [json!(1), json!("1000000000000001"), json!("01")] {
            let mut v = response.clone();
            v["gasFee"] = value;
            assert!(build_response(&context, &v, now).is_err());
        }
    }
    #[test]
    fn stale_or_changed_review_configuration_and_missing_signature_fail_before_transport() {
        let now = 1_900_000_000_000;
        for mutation in 0..8 {
            let (mut c, mut context, _) = fixture(now);
            match mutation {
                0 => c.registry_revision = "changed".into(),
                1 => c.fee_policy_revision = "changed".into(),
                2 => context.signature = None,
                3 => context.provider_quote.push(b' '),
                4 => context.review.authority.minimum_output_raw = "1".into(),
                5 => context.review.authority.router = format!("0x{:040x}", 41),
                6 => context.review.authority.tokens.reverse(),
                _ => context.review.permit.as_mut().unwrap().nonce = "8".into(),
            };
            assert!(build_request(&c, &context, now).is_err(), "{mutation}");
        }
        let (c, context, _) = fixture(now);
        assert!(build_request(&c, &context, context.review.expires_at_ms).is_err());
        // No-permit is an explicit branch; the build request must omit both fields.
        let mut context = context;
        context.review.permit = None;
        context.signature = None;
        let body = build_request(&c, &context, now).unwrap();
        assert!(body.0.get("signature").is_none());
        assert!(body.0.get("permitData").is_none());
        let (_, _, response) = fixture(now);
        assert!(build_response(&context, &response, now).is_err());
    }
    #[test]
    fn artifact_refuses_late_review_and_preserves_provider_case_without_changing_hash() {
        let now = 1_900_000_000_000;
        let (c, context, _) = fixture(now);
        let mut quote: Value = serde_json::from_slice(&context.provider_quote).unwrap();
        quote["swapper"] = json!(
            address(&context.review.authority.owner)
                .unwrap()
                .to_checksum(None)
        );
        let response = json!({"requestId":"fixture","routing":"CLASSIC","quote":quote,"permitData":permit_data(context.review.permit.as_ref().unwrap()).unwrap()});
        let req = SwapQuoteRequest {
            token_in: context.review.authority.token_in.clone(),
            token_out: context.review.authority.token_out.clone(),
            amount_raw: "1000".into(),
            slippage_bps: 500,
        };
        let a = artifact(&c, &context.review.authority.owner, &req, &response, now).unwrap();
        let opts = || ReviewOptions {
            intent_hash: "a".repeat(64),
            deadline: "1900000600".into(),
            maximum_network_fee_raw: "1000000000000000".into(),
            maximum_fee_rounding_raw: 0,
        };
        assert!(a.review_at(opts(), now + 30000).is_err());
        let r = a.review_at(opts(), now).unwrap();
        r.bind_quote(&quote).unwrap();
        assert_eq!(r.provider_quote_hash, hex::encode(digest(&a.raw_quote)));
    }

    #[tokio::test]
    #[ignore = "requires isolated TEST_REDIS_URL and loopback listener"]
    async fn build_transport_pins_headers_bounds_payloads_and_shares_quote_cooldown() {
        use axum::{
            Json, Router,
            extract::State,
            http::HeaderMap,
            response::{IntoResponse, Response},
            routing::post,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        #[derive(Clone)]
        struct Mock {
            response: Value,
            mode: Arc<AtomicUsize>,
            calls: Arc<AtomicUsize>,
        }
        async fn handler(
            State(s): State<Mock>,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> Response {
            s.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(headers["x-api-key"], "public-fixture");
            assert_eq!(headers["x-universal-router-version"], ROUTER_VERSION);
            assert_eq!(headers["x-permit2-disabled"], "false");
            assert!(body.get("safetyMode").is_none());
            assert_eq!(body["simulateTransaction"], false);
            assert_eq!(
                body["deadline"],
                body["permitData"]["values"]["sigDeadline"]
                    .as_str()
                    .unwrap()
                    .parse::<i64>()
                    .unwrap()
            );
            assert!(body.get("apiKey").is_none());
            match s.mode.load(Ordering::SeqCst) {
                1 => (
                    StatusCode::TEMPORARY_REDIRECT,
                    [("location", "http://127.0.0.1:1/credential-sink")],
                )
                    .into_response(),
                2 => (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "120")]).into_response(),
                3 => (
                    [("x-universal-router-version", ROUTER_VERSION)],
                    "x".repeat(MAX_BODY + 1),
                )
                    .into_response(),
                4 => ([("x-universal-router-version", "2.0")], Json(s.response)).into_response(),
                5 => Json(s.response).into_response(),
                6 => {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    (
                        [("x-universal-router-version", ROUTER_VERSION)],
                        Json(s.response),
                    )
                        .into_response()
                }
                _ => (
                    [("x-universal-router-version", ROUTER_VERSION)],
                    Json(s.response),
                )
                    .into_response(),
            }
        }
        let (c, context, response) = fixture(now_ms());
        let redis = RedisStore::new(
            redis::Client::open(std::env::var("TEST_REDIS_URL").unwrap()).unwrap(),
            format!("uniswap-build-test:{}", uuid::Uuid::new_v4().simple()),
            Duration::from_secs(1),
        );
        let make = || {
            UniswapQuotes::new(
                FileConfig {
                    api_key: Zeroizing::new("public-fixture".into()),
                    account_scope: "fixture".into(),
                    interval_ms: 167,
                    chain_id: 1,
                    router: c.router.clone(),
                    permit2: c.permit2.clone(),
                    tokens: c.tokens.clone(),
                    integrator_fees: c.integrator_fees.clone(),
                    registry_revision: c.registry_revision.clone(),
                    fee_policy_revision: c.fee_policy_revision.clone(),
                },
                1,
                redis.clone(),
                Arc::new(Metrics::default()),
            )
            .unwrap()
        };
        let state = Mock {
            response,
            mode: Arc::new(AtomicUsize::new(0)),
            calls: Arc::new(AtomicUsize::new(0)),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/swap", post(handler))
            .with_state(state.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut one = make();
        one.origin = Some(origin.clone());
        let mut two = make();
        two.origin = Some(origin);
        assert!(one.build_swap(&context).await.is_ok());
        // Expiry bounds the complete quota wait + request + response read.
        state.mode.store(6, Ordering::SeqCst);
        let (_, short, _) = fixture(now_ms() - 598_000);
        let started = Instant::now();
        assert!(one.build_swap(&short).await.is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
        for mode in [1, 3, 4, 5, 2] {
            state.mode.store(mode, Ordering::SeqCst);
            assert!(two.build_swap(&context).await.is_err(), "{mode}");
        }
        let rendered = one.metrics.encode().unwrap();
        assert!(rendered.contains("operation=\"build\""));
        assert!(!rendered.contains(context.signature.as_ref().unwrap().as_str()));
        assert!(!rendered.contains("public-fixture"));
        let calls = state.calls.load(Ordering::SeqCst);
        let req = SwapQuoteRequest {
            token_in: context.review.authority.token_in.clone(),
            token_out: context.review.authority.token_out.clone(),
            amount_raw: "1000".into(),
            slippage_bps: 500,
        };
        assert!(
            one.quote(&context.review.authority.owner, req)
                .await
                .is_err()
        );
        assert!(one.build_swap(&context).await.is_err());
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
