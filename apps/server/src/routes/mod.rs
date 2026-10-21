pub mod aave;
pub mod accounts;
pub mod capabilities;
pub mod chains;
pub mod health;
pub mod identity;
pub mod monitoring;
pub mod near_intents;
pub mod operations;
pub mod pairing;
pub mod prices;
pub mod relay;
pub mod relay_quotes;
pub mod session_signatures;
pub mod v1;
pub mod waitlist;

pub mod earn;

pub mod morpho;
pub mod swaps;

pub mod bridges;

pub mod hyperliquid;
pub mod polymarket;

pub(crate) fn idempotency_key(
    headers: &axum::http::HeaderMap,
) -> Result<&str, crate::error::AppError> {
    let mut values = headers.get_all("idempotency-key").iter();
    let value = values
        .next()
        .and_then(|header| header.to_str().ok())
        .ok_or(crate::error::AppError::BadRequest(
            "valid Idempotency-Key required".into(),
        ))?;
    if values.next().is_some()
        || value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(crate::error::AppError::BadRequest(
            "valid Idempotency-Key required".into(),
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::idempotency_key;
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn operation_idempotency_keys_are_single_bounded_ascii_graphics() {
        let mut headers = HeaderMap::new();
        headers.insert("idempotency-key", HeaderValue::from_static("request-1"));
        assert_eq!(idempotency_key(&headers).unwrap(), "request-1");

        for invalid in [String::new(), "key with spaces".into(), "x".repeat(129)] {
            headers.insert("idempotency-key", HeaderValue::try_from(invalid).unwrap());
            assert!(idempotency_key(&headers).is_err());
        }
        headers.clear();
        headers.append("idempotency-key", HeaderValue::from_static("first"));
        headers.append("idempotency-key", HeaderValue::from_static("second"));
        assert!(idempotency_key(&headers).is_err());
    }
}
