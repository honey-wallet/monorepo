//! Ephemeral encrypted pairing mailboxes, shared by all API replicas.
//!
//! The caller must authenticate the channel token before entering this repository.
//! Redis must use noeviction; storage loss requires restarting the pairing exchange.

use crate::{error::AppError, redis_store::RedisStore};

const MAX_COMMIT_LEN: usize = 43;
const MAX_NONCE_LEN: usize = 22;
const MAX_REVEAL_LEN: usize = 64;
const MAX_PAYLOAD_LEN: usize = 16 * 1024;

pub(crate) fn slot_data_limit(slot: &str) -> Option<usize> {
    match slot {
        "commit" => Some(MAX_COMMIT_LEN),
        "nonce" => Some(MAX_NONCE_LEN),
        "reveal" => Some(MAX_REVEAL_LEN),
        "payload" => Some(MAX_PAYLOAD_LEN),
        _ => None,
    }
}

fn validate_slot_data(slot: &str, data: &str) -> Result<(), AppError> {
    let limit =
        slot_data_limit(slot).ok_or_else(|| AppError::BadRequest("invalid pairing slot".into()))?;
    if data.is_empty() || data.len() > limit {
        return Err(AppError::BadRequest("invalid pairing message size".into()));
    }
    Ok(())
}

#[derive(Clone)]
pub struct PairingStore {
    redis: RedisStore,
}

const SEND: &str = include_str!("scripts/pair_send.lua");
const RECEIVE: &str = include_str!("scripts/pair_receive.lua");

impl PairingStore {
    pub fn new(redis: RedisStore) -> Self {
        Self { redis }
    }

    pub async fn send(
        &self,
        channel: &str,
        slot: &str,
        subject: &str,
        data: &str,
    ) -> Result<(), AppError> {
        validate_slot_data(slot, data)?;
        let code: i32 = self
            .redis
            .query(
                redis::cmd("EVAL")
                    .arg(SEND)
                    .arg(5)
                    .arg(self.redis.key("pairing", &format!("channel:{channel}")))
                    .arg(self.redis.key("pairing", "global"))
                    .arg(self.redis.key("pairing", &format!("client:{subject}")))
                    .arg(self.redis.key("pairing", "reservation_bytes"))
                    .arg(self.redis.key("pairing", "global_bytes"))
                    .arg(slot)
                    .arg(format!("{channel}:{slot}"))
                    .arg(data),
            )
            .await?;
        match code {
            0 => Ok(()),
            1 => Err(AppError::Conflict("already sent".into())),
            2 => Err(AppError::TooManyRequests),
            4 => Err(AppError::BadRequest("invalid pairing message size".into())),
            _ => Err(AppError::Busy),
        }
    }

    pub async fn receive(&self, channel: &str, slot: &str) -> Result<String, AppError> {
        let data: Option<String> = self
            .redis
            .query(
                redis::cmd("EVAL")
                    .arg(RECEIVE)
                    .arg(1)
                    .arg(self.redis.key("pairing", &format!("channel:{channel}")))
                    .arg(slot),
            )
            .await?;
        data.filter(|v| !v.is_empty()).ok_or(AppError::NotFound)
    }

    pub async fn admit_receive(&self, subject: &str) -> Result<(), AppError> {
        // Polls are expected while the other device is pairing, but a leaked valid
        // channel token must not let one client amplify Redis traffic without bound.
        self.redis
            .rate_limit_pair("pairing_poll", subject, 30_000, 120)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::{slot_data_limit, validate_slot_data};

    #[test]
    fn pairing_slots_have_protocol_specific_bounds() {
        assert_eq!(slot_data_limit("commit"), Some(43));
        assert_eq!(slot_data_limit("nonce"), Some(22));
        assert_eq!(slot_data_limit("reveal"), Some(64));
        assert_eq!(slot_data_limit("payload"), Some(16 * 1024));
        assert_eq!(slot_data_limit("other"), None);
    }

    #[test]
    fn slot_sizes_accept_boundary_and_reject_one_byte_over() {
        for (slot, limit) in [
            ("commit", 43),
            ("nonce", 22),
            ("reveal", 64),
            ("payload", 16 * 1024),
        ] {
            assert!(validate_slot_data(slot, &"x".repeat(limit)).is_ok());
            assert!(validate_slot_data(slot, &"x".repeat(limit + 1)).is_err());
        }
        assert!(validate_slot_data("commit", "").is_err());
        assert!(validate_slot_data("unknown", "x").is_err());
    }
}
