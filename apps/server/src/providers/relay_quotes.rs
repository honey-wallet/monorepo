//! Fixed-origin Relay preview quotes. Provider step payloads are validated but
//! deliberately never returned to clients or signing surfaces.

use crate::{error::AppError, redis_store::RedisStore};
use reqwest::{StatusCode, header};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

const ORIGIN: &str = "https://api.relay.link";
const MAX_BODY: usize = 256 * 1024;
const MAX_STEPS: usize = 16;
const MAX_ITEMS_PER_STEP: usize = 16;
const GATE: &str = include_str!("../scripts/provider_read_gate.lua");
const COOLDOWN: &str = include_str!("../scripts/provider_read_cooldown.lua");

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RelayQuoteError {
    #[error("Relay quote admission unavailable")]
    Busy,
    #[error("Relay quote temporarily unavailable")]
    Unavailable,
    #[error("Relay quote response failed validation")]
    InvalidResponse,
    #[error("Relay quote request is invalid")]
    InvalidRequest,
}

impl From<RelayQuoteError> for AppError {
    fn from(value: RelayQuoteError) -> Self {
        match value {
            RelayQuoteError::InvalidRequest => AppError::BadRequest(value.to_string()),
            _ => AppError::Busy,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayQuoteRequest {
    pub user: String,
    #[serde(
        default,
        deserialize_with = "optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub recipient: Option<String>,
    pub origin_chain_id: u64,
    pub destination_chain_id: u64,
    pub origin_currency: String,
    pub destination_currency: String,
    pub amount: String,
    pub trade_type: RelayTradeType,
}

fn optional_non_null_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RelayTradeType {
    ExactInput,
    ExactOutput,
    ExpectedOutput,
}

#[derive(Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayQuotePreview {
    pub provider: &'static str,
    pub request_id: String,
    pub execution_available: bool,
    pub steps: Vec<RelayStepPreview>,
}

#[derive(Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayStepPreview {
    pub index: usize,
    pub id: String,
    pub kind: &'static str,
    pub action: String,
    pub description: String,
    pub item_count: usize,
}

#[derive(Clone)]
pub struct RelayQuotes {
    inner: Arc<Inner>,
}

struct Inner {
    client: reqwest::Client,
    redis: RedisStore,
    api_key: Zeroizing<String>,
    permits: Semaphore,
    #[cfg(test)]
    test_origin: Option<String>,
}

impl RelayQuotes {
    pub fn new(api_key: String, redis: RedisStore) -> Result<Self, RelayQuoteError> {
        if api_key.trim().is_empty()
            || api_key.len() > 512
            || api_key.bytes().any(|b| b.is_ascii_control())
        {
            return Err(RelayQuoteError::InvalidRequest);
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(6))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(2)
            .user_agent("HoneyWallet/0.1 relay-preview")
            .build()
            .map_err(|_| RelayQuoteError::Unavailable)?;
        Ok(Self {
            inner: Arc::new(Inner {
                client,
                redis,
                api_key: Zeroizing::new(api_key),
                permits: Semaphore::new(4),
                #[cfg(test)]
                test_origin: None,
            }),
        })
    }

    #[tracing::instrument(name = "provider.relay_preview_quote", skip_all)]
    pub async fn quote(
        &self,
        input: &RelayQuoteRequest,
    ) -> Result<RelayQuotePreview, RelayQuoteError> {
        validate_request(input)?;
        let _permit = self
            .inner
            .permits
            .try_acquire()
            .map_err(|_| RelayQuoteError::Busy)?;
        tokio::time::timeout(Duration::from_secs(4), self.admit())
            .await
            .map_err(|_| RelayQuoteError::Busy)??;

        let payload = provider_payload(input)?;
        let origin = self.origin();
        let response = self
            .inner
            .client
            .post(format!("{origin}/quote/v2"))
            .header(header::ACCEPT, "application/json")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-api-key", self.inner.api_key.as_str())
            .json(&payload)
            .send()
            .await
            .map_err(|_| RelayQuoteError::Unavailable)?;
        let status = response.status();
        if !status.is_success() {
            if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                let delay = crate::providers::transport::retry_after_ms(
                    response
                        .headers()
                        .get(header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok()),
                    SystemTime::now(),
                );
                self.cooldown(delay).await?;
            }
            return Err(RelayQuoteError::Unavailable);
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err(RelayQuoteError::InvalidResponse);
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| RelayQuoteError::Unavailable)?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX_BODY {
                return Err(RelayQuoteError::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| RelayQuoteError::InvalidResponse)?;
        validate_response(&value)
    }

    fn origin(&self) -> &str {
        #[cfg(test)]
        if let Some(origin) = self.inner.test_origin.as_deref() {
            return origin;
        }
        ORIGIN
    }

    async fn admit(&self) -> Result<(), RelayQuoteError> {
        loop {
            let (status, wait): (i32, u64) = self
                .inner
                .redis
                .query(
                    redis::cmd("EVAL")
                        .arg(GATE)
                        .arg(2)
                        .arg(self.inner.redis.key("provider-read-relay", "next"))
                        .arg(self.inner.redis.key("provider-read-relay", "cooldown")),
                )
                .await
                .map_err(|_| RelayQuoteError::Busy)?;
            match status {
                1 => return Ok(()),
                2 => return Err(RelayQuoteError::Unavailable),
                0 if wait <= 1000 => tokio::time::sleep(Duration::from_millis(wait.max(1))).await,
                _ => return Err(RelayQuoteError::Busy),
            }
        }
    }

    async fn cooldown(&self, ms: Option<u64>) -> Result<(), RelayQuoteError> {
        let _: i32 = self
            .inner
            .redis
            .query(
                redis::cmd("EVAL")
                    .arg(COOLDOWN)
                    .arg(1)
                    .arg(self.inner.redis.key("provider-read-relay", "cooldown"))
                    .arg(ms.map(|n| n.to_string()).unwrap_or_else(|| "hold".into())),
            )
            .await
            .map_err(|_| RelayQuoteError::Busy)?;
        Ok(())
    }
}

fn validate_request(input: &RelayQuoteRequest) -> Result<(), RelayQuoteError> {
    let address = |s: &str| {
        s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
    };
    let uint = !input.amount.is_empty()
        && input.amount.len() <= 78
        && input.amount.bytes().all(|b| b.is_ascii_digit())
        && (input.amount.len() == 1 || !input.amount.starts_with('0'))
        && alloy_primitives::U256::from_str_radix(&input.amount, 10).is_ok();
    if !address(&input.user)
        || input.recipient.as_deref().is_some_and(|a| !address(a))
        || input.origin_chain_id == 0
        || input.destination_chain_id == 0
        || input.origin_chain_id > 9_007_199_254_740_991
        || input.destination_chain_id > 9_007_199_254_740_991
        || !address(&input.origin_currency)
        || !address(&input.destination_currency)
        || !uint
        || input.amount.bytes().all(|b| b == b'0')
    {
        return Err(RelayQuoteError::InvalidRequest);
    }
    Ok(())
}

fn provider_payload(input: &RelayQuoteRequest) -> Result<Value, RelayQuoteError> {
    let mut payload = serde_json::to_value(input).map_err(|_| RelayQuoteError::InvalidRequest)?;
    // Relay documents this flag as returning an inexecutable preview. It is a
    // server-owned policy and cannot be set or overridden by the caller.
    payload["indicativeQuote"] = Value::Bool(true);
    Ok(payload)
}

fn safe_text(value: &Value, max: usize) -> Option<String> {
    let text = value.as_str()?;
    if text.is_empty() || text.len() > max || text.chars().any(char::is_control) {
        return None;
    }
    Some(text.to_owned())
}

fn validate_response(value: &Value) -> Result<RelayQuotePreview, RelayQuoteError> {
    let invalid = || RelayQuoteError::InvalidResponse;
    let request_id = safe_text(&value["requestId"], 128).ok_or_else(invalid)?;
    let steps = value["steps"].as_array().ok_or_else(invalid)?;
    if steps.is_empty() || steps.len() > MAX_STEPS {
        return Err(invalid());
    }
    let mut ids = HashSet::with_capacity(steps.len());
    let mut safe_steps = Vec::with_capacity(steps.len());
    for (index, step) in steps.iter().enumerate() {
        let id = safe_text(&step["id"], 64).ok_or_else(invalid)?;
        if !ids.insert(id.clone()) {
            return Err(invalid());
        }
        let kind = match step["kind"].as_str() {
            Some("transaction") => "transaction",
            Some("signature") => "signature",
            _ => return Err(invalid()),
        };
        let action = safe_text(&step["action"], 160).ok_or_else(invalid)?;
        let description = safe_text(&step["description"], 256).ok_or_else(invalid)?;
        let items = match step.get("items") {
            None => &[][..],
            Some(value) => value.as_array().ok_or_else(invalid)?.as_slice(),
        };
        if items.len() > MAX_ITEMS_PER_STEP {
            return Err(invalid());
        }
        for item in items {
            if !matches!(item["status"].as_str(), Some("incomplete" | "complete")) {
                return Err(invalid());
            }
            if item
                .get("data")
                .is_some_and(|data| !(data.is_object() || data.is_string()))
            {
                return Err(invalid());
            }
            if item.get("check").is_some_and(|check| !check.is_object()) {
                return Err(invalid());
            }
        }
        safe_steps.push(RelayStepPreview {
            index,
            id,
            kind,
            action,
            description,
            item_count: items.len(),
        });
    }
    Ok(RelayQuotePreview {
        provider: "relay",
        request_id,
        execution_available: false,
        steps: safe_steps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_response() -> Value {
        json!({"requestId":"relay-quote-id","steps":[
            {"id":"approve","action":"Approve token","description":"Approval required","kind":"transaction","items":[{"status":"incomplete","data":{"to":"0x0000000000000000000000000000000000000001","data":"0xdeadbeef","value":"0"}}]},
            {"id":"deposit","action":"Submit deposit","description":"Deposit funds","kind":"transaction","items":[{"status":"incomplete","data":{"to":"0x0000000000000000000000000000000000000002","data":"0xfeed"}}]}
        ], "details":{"amount":"999"}})
    }

    #[test]
    fn quote_summary_keeps_order_and_never_serializes_executable_data() {
        let summary = validate_response(&valid_response()).unwrap();
        assert_eq!(
            summary
                .steps
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["approve", "deposit"]
        );
        assert!(!summary.execution_available);
        let encoded = serde_json::to_string(&summary).unwrap();
        assert!(!encoded.contains("deadbeef"));
        assert!(!encoded.contains("feed"));
        assert!(!encoded.contains("\"to\""));
    }

    #[test]
    fn request_rejects_noncanonical_amounts_and_unsafe_chain_ids() {
        let mut request = RelayQuoteRequest {
            user: "0x0000000000000000000000000000000000000001".into(),
            recipient: None,
            origin_chain_id: 1,
            destination_chain_id: 10,
            origin_currency: "0x0000000000000000000000000000000000000000".into(),
            destination_currency: "0x0000000000000000000000000000000000000000".into(),
            amount: "1".into(),
            trade_type: RelayTradeType::ExactInput,
        };
        assert!(validate_request(&request).is_ok());
        request.amount = "01".into();
        assert!(matches!(
            validate_request(&request),
            Err(RelayQuoteError::InvalidRequest)
        ));
        request.amount = "1".into();
        request.origin_chain_id = 9_007_199_254_740_992;
        assert!(matches!(
            validate_request(&request),
            Err(RelayQuoteError::InvalidRequest)
        ));
    }

    #[test]
    fn provider_projection_omits_absent_recipient_and_forces_preview_mode() {
        let request: RelayQuoteRequest = serde_json::from_value(json!({
            "user":"0x0000000000000000000000000000000000000001",
            "originChainId":1,
            "destinationChainId":10,
            "originCurrency":"0x0000000000000000000000000000000000000000",
            "destinationCurrency":"0x0000000000000000000000000000000000000000",
            "amount":"5",
            "tradeType":"EXACT_INPUT"
        }))
        .unwrap();
        let projection = provider_payload(&request).unwrap();
        assert_eq!(projection["indicativeQuote"], true);
        assert!(projection.get("recipient").is_none());
        assert_eq!(projection.as_object().unwrap().len(), 8);
        assert!(
            serde_json::from_value::<RelayQuoteRequest>(json!({
                "user":"0x0000000000000000000000000000000000000001",
                "recipient":null,
                "originChainId":1,
                "destinationChainId":10,
                "originCurrency":"0x0000000000000000000000000000000000000000",
                "destinationCurrency":"0x0000000000000000000000000000000000000000",
                "amount":"5",
                "tradeType":"EXACT_INPUT"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<RelayQuoteRequest>(json!({
                "user":"0x0000000000000000000000000000000000000001",
                "originChainId":1,
                "destinationChainId":10,
                "originCurrency":"0x0000000000000000000000000000000000000000",
                "destinationCurrency":"0x0000000000000000000000000000000000000000",
                "amount":"5",
                "tradeType":"EXACT_INPUT",
                "data":"0xdeadbeef"
            }))
            .is_err()
        );
    }

    #[test]
    fn malformed_steps_and_duplicate_ids_are_rejected() {
        let mut value = valid_response();
        value["steps"][1]["id"] = json!("approve");
        assert!(matches!(
            validate_response(&value),
            Err(RelayQuoteError::InvalidResponse)
        ));
        let mut value = valid_response();
        value["steps"][0]["kind"] = json!("future-executable");
        assert!(matches!(
            validate_response(&value),
            Err(RelayQuoteError::InvalidResponse)
        ));
    }
}
