//! NEAR Intents 1Click previews. No deposit addresses or signing payloads leave this adapter.
use crate::{error::AppError, redis_store::RedisStore};
use reqwest::{StatusCode, header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

const ORIGIN: &str = "https://1click.chaindefuser.com/v0";
const MAX_BODY: usize = 2 * 1024 * 1024;
// Pinned to the official 1Click SDK's production manager key (quote-signature.ts).
const MANAGER_KEY: &str = "reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
const GATE: &str = include_str!("../scripts/provider_read_gate.lua");
const COOLDOWN: &str = include_str!("../scripts/provider_read_cooldown.lua");

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuoteRequest {
    pub origin_asset: String,
    pub destination_asset: String,
    pub amount: String,
    pub recipient: String,
    pub slippage_tolerance: u16,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub asset_id: String,
    pub blockchain: String,
    pub symbol: String,
    pub decimals: u8,
    pub contract_address: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotePreview {
    pub provider: &'static str,
    pub execution_available: bool,
    pub origin_asset: String,
    pub destination_asset: String,
    pub amount_in: String,
    pub amount_out: String,
    pub min_amount_out: String,
    pub quoted_at: String,
}

pub struct NearIntents {
    client: reqwest::Client,
    redis: RedisStore,
    api_key: Zeroizing<String>,
    permits: Semaphore,
}

impl NearIntents {
    pub fn new(api_key: String, redis: RedisStore) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !api_key.trim().is_empty()
                && api_key.len() <= 4096
                && api_key.bytes().all(|b| b.is_ascii_graphic()),
            "invalid NEAR Intents key"
        );
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(1))
                .timeout(Duration::from_secs(6))
                .redirect(reqwest::redirect::Policy::none())
                .pool_max_idle_per_host(2)
                .user_agent("HoneyWallet/0.1 near-intents-preview")
                .build()?,
            redis,
            api_key: Zeroizing::new(api_key),
            permits: Semaphore::new(4),
        })
    }

    async fn request(&self, payload: Option<&Value>) -> Result<Value, AppError> {
        let _permit = self.permits.try_acquire().map_err(|_| AppError::Busy)?;
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                let (status, wait): (i32, u64) = self
                    .redis
                    .query(
                        redis::cmd("EVAL")
                            .arg(GATE)
                            .arg(2)
                            .arg(self.redis.key("provider-read-near-intents", "next"))
                            .arg(self.redis.key("provider-read-near-intents", "cooldown")),
                    )
                    .await
                    .map_err(|_| AppError::Busy)?;
                match status {
                    1 => return Ok::<(), AppError>(()),
                    0 if wait <= 1000 => {
                        tokio::time::sleep(Duration::from_millis(wait.max(1))).await
                    }
                    _ => return Err(AppError::Busy),
                }
            }
        })
        .await
        .map_err(|_| AppError::Busy)??;
        let request = match payload {
            Some(body) => self.client.post(format!("{ORIGIN}/quote")).json(body),
            None => self.client.get(format!("{ORIGIN}/tokens")),
        };
        let mut response = request
            .header(header::ACCEPT, "application/json")
            .header("x-api-key", self.api_key.as_str())
            .send()
            .await
            .map_err(|_| AppError::Busy)?;
        if !response.status().is_success() {
            if response.status() == StatusCode::TOO_MANY_REQUESTS
                || response.status().is_server_error()
            {
                let delay = super::transport::retry_after_ms(
                    response
                        .headers()
                        .get(header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok()),
                    SystemTime::now(),
                );
                let _: i32 = self
                    .redis
                    .query(
                        redis::cmd("EVAL")
                            .arg(COOLDOWN)
                            .arg(1)
                            .arg(self.redis.key("provider-read-near-intents", "cooldown"))
                            .arg(
                                delay
                                    .map(|n| n.to_string())
                                    .unwrap_or_else(|| "hold".into()),
                            ),
                    )
                    .await
                    .map_err(|_| AppError::Busy)?;
            }
            return Err(AppError::Busy);
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err(AppError::Busy);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| AppError::Busy)? {
            if bytes.len().saturating_add(chunk.len()) > MAX_BODY {
                return Err(AppError::Busy);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| AppError::Busy)
    }

    pub async fn tokens(&self) -> Result<Vec<Token>, AppError> {
        let value = self.request(None).await?;
        let tokens: Vec<Token> = serde_json::from_value(value).map_err(|_| AppError::Busy)?;
        if tokens.is_empty() || tokens.len() > 4096 {
            return Err(AppError::Busy);
        }
        let mut ids = std::collections::HashSet::new();
        if tokens.iter().any(|t| {
            !safe_text(&t.asset_id, 256)
                || !safe_text(&t.blockchain, 32)
                || !safe_text(&t.symbol, 32)
                || t.decimals > 38
                || t.contract_address
                    .as_ref()
                    .is_some_and(|a| !safe_text(a, 256))
                || !ids.insert(t.asset_id.as_str())
        }) {
            return Err(AppError::Busy);
        }
        Ok(tokens)
    }

    pub async fn quote(
        &self,
        input: &QuoteRequest,
        owner: &str,
        chain: &str,
    ) -> Result<QuotePreview, AppError> {
        validate_input(input)?;
        let tokens = self.tokens().await?;
        validate_origin(&tokens, input, chain)?;
        let now = OffsetDateTime::now_utc();
        let payload = provider_payload(input, owner, now)?;
        let response = self.request(Some(&payload)).await?;
        validate_response(&response, &payload, now, MANAGER_KEY)
    }
}

fn safe_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_graphic())
}
fn uint(s: &str) -> Option<alloy_primitives::U256> {
    if s.is_empty()
        || s.len() > 78
        || !s.bytes().all(|b| b.is_ascii_digit())
        || (s.len() > 1 && s.starts_with('0'))
    {
        return None;
    }
    alloy_primitives::U256::from_str_radix(s, 10)
        .ok()
        .filter(|n| !n.is_zero())
}
fn validate_input(input: &QuoteRequest) -> Result<(), AppError> {
    if !safe_text(&input.origin_asset, 256)
        || !safe_text(&input.destination_asset, 256)
        || input.origin_asset == input.destination_asset
        || !safe_text(&input.recipient, 128)
        || uint(&input.amount).is_none()
        || input.slippage_tolerance > 500
    {
        return Err(AppError::BadRequest(
            "invalid NEAR Intents quote request".into(),
        ));
    }
    Ok(())
}
fn validate_origin(tokens: &[Token], input: &QuoteRequest, chain: &str) -> Result<(), AppError> {
    // Authentication currently proves EVM ownership only. Catalog IDs are never parsed as chain IDs.
    let blockchain = match chain {
        "eip155:1" => "eth",
        "eip155:8453" => "base",
        "eip155:42161" => "arb",
        "eip155:10" => "op",
        "eip155:137" => "pol",
        "eip155:56" => "bsc",
        "eip155:43114" => "avax",
        "eip155:100" => "gnosis",
        _ => {
            return Err(AppError::Unsupported(
                "NEAR Intents previews require a supported EVM origin wallet".into(),
            ));
        }
    };
    if !tokens
        .iter()
        .any(|t| t.asset_id == input.origin_asset && t.blockchain == blockchain)
        || !tokens.iter().any(|t| t.asset_id == input.destination_asset)
    {
        return Err(AppError::BadRequest(
            "assets must be supported and origin must match the signed-in chain".into(),
        ));
    }
    Ok(())
}
fn provider_payload(
    input: &QuoteRequest,
    owner: &str,
    now: OffsetDateTime,
) -> Result<Value, AppError> {
    Ok(json!({
        "dry": true, "swapType": "EXACT_INPUT", "depositType": "ORIGIN_CHAIN",
        "recipientType": "DESTINATION_CHAIN", "refundType": "ORIGIN_CHAIN",
        "originAsset": input.origin_asset, "destinationAsset": input.destination_asset,
        "amount": input.amount, "recipient": input.recipient, "refundTo": owner,
        "slippageTolerance": input.slippage_tolerance,
        "deadline": (now.replace_nanosecond(0).map_err(|_| AppError::Busy)? + time::Duration::minutes(10)).format(&Rfc3339).map_err(|_| AppError::Busy)?
    }))
}

fn validate_response(
    value: &Value,
    payload: &Value,
    now: OffsetDateTime,
    key: &str,
) -> Result<QuotePreview, AppError> {
    let request = value["quoteRequest"].as_object().ok_or(AppError::Busy)?;
    let mut signed = std::collections::BTreeMap::new();
    for (field, expected) in payload.as_object().ok_or(AppError::Busy)? {
        if request.get(field) != Some(expected) {
            return Err(AppError::Busy);
        }
        signed.insert(field.clone(), expected.clone());
    }
    // Match the SDK's optional signed routing fields; reject unexpected overrides.
    for field in [
        "quoteWaitingTimeMs",
        "referral",
        "virtualChainRecipient",
        "virtualChainRefundRecipient",
        "customRecipientMsg",
    ] {
        if request
            .get(field)
            .is_some_and(|v| !v.is_null() && v != "" && v != 0)
        {
            return Err(AppError::Busy);
        }
    }
    let quote = &value["quote"];
    if [
        "depositAddress",
        "depositMemo",
        "chainDepositAddresses",
        "deadline",
        "timeWhenInactive",
    ]
    .iter()
    .any(|field| quote.get(field).is_some_and(|v| !v.is_null()))
    {
        return Err(AppError::Busy);
    }
    for field in [
        "amountIn",
        "amountInFormatted",
        "amountInUsd",
        "minAmountIn",
        "amountOut",
        "amountOutFormatted",
        "amountOutUsd",
        "minAmountOut",
    ] {
        let item = quote[field]
            .as_str()
            .filter(|s| safe_text(s, 128))
            .ok_or(AppError::Busy)?;
        signed.insert(field.into(), json!(item));
    }
    let timestamp = value["timestamp"].as_str().ok_or(AppError::Busy)?;
    let quoted_at = OffsetDateTime::parse(timestamp, &Rfc3339).map_err(|_| AppError::Busy)?;
    if quoted_at < now - time::Duration::seconds(60)
        || quoted_at > now + time::Duration::seconds(15)
    {
        return Err(AppError::Busy);
    }
    signed.insert("timestamp".into(), json!(timestamp));
    let bytes = serde_json::to_vec(&signed).map_err(|_| AppError::Busy)?;
    let hash = bs58::encode(Sha256::digest(bytes)).into_string();
    let signature = value["signature"]
        .as_str()
        .filter(|s| s.len() <= 128)
        .ok_or(AppError::Busy)?;
    let signature = bs58::decode(signature.strip_prefix("ed25519:").unwrap_or(signature))
        .into_vec()
        .map_err(|_| AppError::Busy)?;
    let key = bs58::decode(key).into_vec().map_err(|_| AppError::Busy)?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(hash.as_bytes(), &signature)
        .map_err(|_| AppError::Busy)?;
    let amount_in = quote["amountIn"].as_str().ok_or(AppError::Busy)?;
    let amount_out = quote["amountOut"].as_str().ok_or(AppError::Busy)?;
    let min_out = quote["minAmountOut"].as_str().ok_or(AppError::Busy)?;
    let output = uint(amount_out).ok_or(AppError::Busy)?;
    let minimum = uint(min_out).ok_or(AppError::Busy)?;
    let bps = payload["slippageTolerance"]
        .as_u64()
        .filter(|n| *n <= 500)
        .ok_or(AppError::Busy)?;
    let denominator = alloy_primitives::U256::from(10_000);
    let numerator = alloy_primitives::U256::from(10_000 - bps);
    // Divide before multiplying to support the entire uint256 range without overflow.
    let floor =
        (output / denominator) * numerator + ((output % denominator) * numerator) / denominator;
    if amount_in != payload["amount"].as_str().ok_or(AppError::Busy)?
        || quote["minAmountIn"].as_str() != Some(amount_in)
        || minimum > output
        || minimum < floor
    {
        return Err(AppError::Busy);
    }
    Ok(QuotePreview {
        provider: "near_intents",
        execution_available: false,
        origin_asset: payload["originAsset"]
            .as_str()
            .ok_or(AppError::Busy)?
            .into(),
        destination_asset: payload["destinationAsset"]
            .as_str()
            .ok_or(AppError::Busy)?
            .into(),
        amount_in: amount_in.into(),
        amount_out: amount_out.into(),
        min_amount_out: min_out.into(),
        quoted_at: timestamp.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Value, Value, OffsetDateTime) {
        // Official SDK staging vector: src/__tests__/quote-signature.test.ts.
        let response: Value =
            serde_json::from_str(include_str!("near_intents/dry-quote.fixture.json")).unwrap();
        let mut payload = response["quoteRequest"].clone();
        for field in [
            "depositMode",
            "confidentiality",
            "quoteWaitingTimeMs",
            "appFees",
        ] {
            payload.as_object_mut().unwrap().remove(field);
        }
        let now = OffsetDateTime::parse(response["timestamp"].as_str().unwrap(), &Rfc3339).unwrap();
        (response, payload, now)
    }
    const STAGING_KEY: &str = "5J5tkaxyPoR3Q9S8LXfo5bWnXK5Z2bctJ4mB9gENh7co";

    #[test]
    fn official_signature_vector_matches_and_execution_fields_never_escape() {
        let (response, payload, now) = fixture();
        let preview = validate_response(&response, &payload, now, STAGING_KEY).unwrap();
        let value = serde_json::to_value(preview).unwrap();
        assert_eq!(value["provider"], "near_intents");
        assert_eq!(value["executionAvailable"], false);
        assert_eq!(value["amountOut"], "5935024");
        assert!(value.get("depositAddress").is_none());
        // Staging signatures must never be trusted by the production adapter.
        assert!(validate_response(&response, &payload, now, MANAGER_KEY).is_err());
    }

    #[test]
    fn tampering_wrong_request_stale_and_executable_quotes_fail_closed() {
        let (response, payload, now) = fixture();
        for (field, value) in [
            ("amountOut", json!("99999999")),
            ("depositAddress", json!("attacker")),
        ] {
            let mut tampered = response.clone();
            tampered["quote"][field] = value;
            assert!(validate_response(&tampered, &payload, now, STAGING_KEY).is_err());
        }
        let mut changed = payload.clone();
        changed["refundTo"] = json!("attacker");
        assert!(validate_response(&response, &changed, now, STAGING_KEY).is_err());
        assert!(
            validate_response(
                &response,
                &payload,
                now + time::Duration::seconds(61),
                STAGING_KEY
            )
            .is_err()
        );
        assert!(
            validate_response(
                &response,
                &payload,
                now - time::Duration::seconds(16),
                STAGING_KEY
            )
            .is_err()
        );
        let mut unsigned = response.clone();
        unsigned["signature"] = json!("");
        assert!(validate_response(&unsigned, &payload, now, STAGING_KEY).is_err());
    }

    fn input() -> QuoteRequest {
        QuoteRequest {
            origin_asset: "nep141:eth.omft.near".into(),
            destination_asset: "nep141:wrap.near".into(),
            amount: "1000".into(),
            recipient: "receiver.near".into(),
            slippage_tolerance: 100,
        }
    }

    #[test]
    fn caller_cannot_override_dry_mode_or_refund_wallet() {
        let request = input();
        let payload = provider_payload(&request, "owner", OffsetDateTime::UNIX_EPOCH).unwrap();
        assert_eq!(payload["dry"], true);
        assert_eq!(payload["refundTo"], "owner");
        for field in ["dry", "refundTo", "appFees", "depositType", "deadline"] {
            let mut body = serde_json::to_value(&request).unwrap();
            body[field] = json!(false);
            assert!(serde_json::from_value::<QuoteRequest>(body).is_err());
        }
        for amount in ["0", "01", "-1", "1.1", "1e9"] {
            let mut invalid = input();
            invalid.amount = amount.into();
            assert!(validate_input(&invalid).is_err());
        }
    }

    #[test]
    fn catalog_must_bind_origin_to_authenticated_chain() {
        let tokens = vec![
            Token {
                asset_id: "nep141:eth.omft.near".into(),
                blockchain: "eth".into(),
                symbol: "ETH".into(),
                decimals: 18,
                contract_address: None,
            },
            Token {
                asset_id: "nep141:wrap.near".into(),
                blockchain: "near".into(),
                symbol: "NEAR".into(),
                decimals: 24,
                contract_address: None,
            },
        ];
        assert!(validate_origin(&tokens, &input(), "eip155:1").is_ok());
        for chain in ["eip155:8453", "near:mainnet", "eip155:31337"] {
            assert!(validate_origin(&tokens, &input(), chain).is_err());
        }
    }
}
