//! Mailbox for pairing a new device (the browser extension) with the phone.
//!
//! The two devices agree on a key with X25519 and compare a six-digit code on both
//! screens; everything that passes through here is either a public key (`hello`) or
//! ciphertext only they can open (`payload`). The server never sees a secret, in line
//! with the custody model in `lib.rs`.
//!
//! Each channel holds at most one message per slot, readable once, for five minutes.
//! Nothing is written to disk.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::put,
};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

const TTL: Duration = Duration::from_secs(5 * 60);
/// Base64url of the largest message the clients send, with room to spare.
const MAX_DATA_LEN: usize = 16 * 1024;
/// Caps memory use if someone floods the mailbox.
const MAX_MESSAGES: usize = 10_000;

/// Request and response body, mirrored as `PairMessage` in `packages/api-client/src/types.ts`.
#[derive(Serialize, Deserialize)]
pub struct PairMessage {
    /// Base64url: a public key for `hello`, ciphertext for `payload`.
    pub data: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Slot {
    /// The phone's public key, sent after it scans the extension's QR code.
    Hello,
    /// The encrypted wallet, sent once the codes match.
    Payload,
}

/// (channel, slot) → (when it arrived, data).
type Messages = HashMap<(String, Slot), (Instant, String)>;

#[derive(Clone, Default)]
struct Mailbox(Arc<Mutex<Messages>>);

impl Mailbox {
    fn with<T>(&self, f: impl FnOnce(&mut Messages) -> T) -> T {
        let mut map = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.retain(|_, (at, _)| at.elapsed() < TTL);
        f(&mut map)
    }
}

pub fn router() -> Router {
    Router::new()
        .route("/pairing/{channel}/{slot}", put(send).get(receive))
        .with_state(Mailbox::default())
}

/// Channel ids are 16+ random bytes from the extension, base64url-encoded.
fn check_channel(channel: &str) -> Result<(), AppError> {
    let ok = (16..=64).contains(&channel.len())
        && channel
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest("invalid pairing channel".into()))
    }
}

async fn send(
    State(mailbox): State<Mailbox>,
    Path((channel, slot)): Path<(String, Slot)>,
    Json(message): Json<PairMessage>,
) -> Result<StatusCode, AppError> {
    check_channel(&channel)?;
    if message.data.is_empty() || message.data.len() > MAX_DATA_LEN {
        return Err(AppError::BadRequest("message too large".into()));
    }
    mailbox.with(|map| {
        if map.len() >= MAX_MESSAGES {
            return Err(AppError::Busy);
        }
        // First writer wins: a second phone can't replace the one being paired.
        let key = (channel, slot);
        if map.contains_key(&key) {
            return Err(AppError::Conflict("already sent".into()));
        }
        map.insert(key, (Instant::now(), message.data));
        Ok(StatusCode::NO_CONTENT)
    })
}

/// Hands the message over once and forgets it. 404 until it arrives (clients poll).
async fn receive(
    State(mailbox): State<Mailbox>,
    Path((channel, slot)): Path<(String, Slot)>,
) -> Result<Json<PairMessage>, AppError> {
    check_channel(&channel)?;
    mailbox
        .with(|map| map.remove(&(channel, slot)))
        .map(|(_, data)| Json(PairMessage { data }))
        .ok_or(AppError::NotFound)
}
