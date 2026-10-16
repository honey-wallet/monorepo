//! Mailbox for pairing a new device (the browser extension) with the phone.
//!
//! The protocol lives in `packages/keyring/src/pairing.ts`. What passes through here is
//! public keys, nonces, a hash commitment and ciphertext only the two devices can open;
//! the server never sees a secret it could use, in line with the custody model in
//! `lib.rs`.
//!
//! Access: the extension's QR code carries a random token, and the channel is
//! `sha256(token)` in hex. Every request must present the token in `X-Pair-Token`, so
//! knowing a channel id (from logs, say) isn't enough to read or write it, and the
//! token itself never appears in a URL.
//!
//! Each slot is write-once for the life of the channel (five minutes), even after it
//! has been read, so nobody can slip in a second message. Messages are read once and
//! kept in memory only. Each client IP may hold a limited number of live messages, so
//! one sender can't fill the mailbox for everyone.

use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, State},
    http::{Extensions, HeaderMap, StatusCode},
    routing::put,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;

const TTL: Duration = Duration::from_secs(5 * 60);
/// Base64url of the largest message the clients send, with room to spare.
const MAX_DATA_LEN: usize = 16 * 1024;
/// A backstop for the whole mailbox.
const MAX_MESSAGES: usize = 10_000;
/// Live messages one client IP may hold. A pairing writes four, so this allows a few
/// retries while keeping any one sender to a sliver of `MAX_MESSAGES`.
const MAX_PER_CLIENT: usize = 24;

pub const TOKEN_HEADER: &str = "x-pair-token";

/// Request and response body, mirrored as `PairMessage` in `packages/api-client/src/types.ts`.
#[derive(Serialize, Deserialize)]
pub struct PairMessage {
    /// Base64url: a commitment, nonce, public key or ciphertext, depending on the slot.
    pub data: String,
}

/// In protocol order. The phone writes `commit`, `reveal` and `payload`; the
/// extension writes `nonce`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Slot {
    Commit,
    Nonce,
    Reveal,
    Payload,
}

struct Entry {
    at: Instant,
    client: IpAddr,
    /// `None` once read: the slot stays taken until the channel expires.
    data: Option<String>,
}

type Entries = HashMap<(String, Slot), Entry>;

#[derive(Clone)]
struct Mailbox {
    entries: Arc<Mutex<Entries>>,
    trust_proxy_headers: bool,
}

impl Mailbox {
    fn with<T>(&self, f: impl FnOnce(&mut Entries) -> T) -> T {
        let mut map = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.retain(|_, entry| entry.at.elapsed() < TTL);
        f(&mut map)
    }

    /// The caller's IP: the socket's, or the first `X-Forwarded-For` hop when the server
    /// sits behind a proxy that sets it (`TRUST_PROXY_HEADERS=true`).
    fn client(&self, headers: &HeaderMap, extensions: &Extensions) -> IpAddr {
        let forwarded = self
            .trust_proxy_headers
            .then(|| headers.get("x-forwarded-for")?.to_str().ok())
            .flatten()
            .and_then(|value| value.split(',').next()?.trim().parse().ok());
        forwarded
            .or_else(|| {
                extensions
                    .get::<ConnectInfo<SocketAddr>>()
                    .map(|info| info.0.ip())
            })
            .unwrap_or(IpAddr::from([0, 0, 0, 0]))
    }
}

pub fn router(trust_proxy_headers: bool) -> Router {
    Router::new()
        .route("/pairing/{channel}/{slot}", put(send).get(receive))
        .with_state(Mailbox {
            entries: Arc::default(),
            trust_proxy_headers,
        })
}

/// The channel must be 64 hex characters and equal `sha256(token)`.
fn authorize(channel: &str, headers: &HeaderMap) -> Result<(), AppError> {
    if channel.len() != 64 || !channel.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("invalid pairing channel".into()));
    }
    let token = headers
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|t| (16..=128).contains(&t.len()))
        .ok_or(AppError::Forbidden)?;
    let digest = Sha256::digest(token.as_bytes());
    let expected: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if expected.eq_ignore_ascii_case(channel) {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

async fn send(
    State(mailbox): State<Mailbox>,
    Path((channel, slot)): Path<(String, Slot)>,
    headers: HeaderMap,
    extensions: Extensions,
    Json(message): Json<PairMessage>,
) -> Result<StatusCode, AppError> {
    authorize(&channel, &headers)?;
    if message.data.is_empty() || message.data.len() > MAX_DATA_LEN {
        return Err(AppError::BadRequest("message too large".into()));
    }
    let client = mailbox.client(&headers, &extensions);
    mailbox.with(|map| {
        let key = (channel.to_ascii_lowercase(), slot);
        // Write-once, even after it's been read.
        if map.contains_key(&key) {
            return Err(AppError::Conflict("already sent".into()));
        }
        if map.values().filter(|e| e.client == client).count() >= MAX_PER_CLIENT {
            return Err(AppError::TooManyRequests);
        }
        if map.len() >= MAX_MESSAGES {
            return Err(AppError::Busy);
        }
        map.insert(
            key,
            Entry {
                at: Instant::now(),
                client,
                data: Some(message.data),
            },
        );
        Ok(StatusCode::NO_CONTENT)
    })
}

/// Hands the message over once. 404 until it arrives (clients poll), and after.
async fn receive(
    State(mailbox): State<Mailbox>,
    Path((channel, slot)): Path<(String, Slot)>,
    headers: HeaderMap,
) -> Result<Json<PairMessage>, AppError> {
    authorize(&channel, &headers)?;
    mailbox
        .with(|map| {
            map.get_mut(&(channel.to_ascii_lowercase(), slot))
                .and_then(|entry| entry.data.take())
        })
        .map(|data| Json(PairMessage { data }))
        .ok_or(AppError::NotFound)
}
