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
//! shared through Redis when configured. Each client IP may hold a limited number of live messages, so
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
    trusted_proxy_cidrs: Vec<crate::config::TrustedProxyCidr>,
    shared: Option<crate::pairing_store::PairingStore>,
}

impl Slot {
    fn as_str(self) -> &'static str {
        match self {
            Self::Commit => "commit",
            Self::Nonce => "nonce",
            Self::Reveal => "reveal",
            Self::Payload => "payload",
        }
    }

    fn max_data_len(self) -> usize {
        crate::pairing_store::slot_data_limit(self.as_str()).expect("known pairing slot")
    }
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

    /// Who to count a message against: the socket's IP, or behind a trusted proxy
    /// (`TRUST_PROXY_HEADERS=true`) and the TCP peer is in `TRUSTED_PROXY_CIDRS`, the
    /// last `X-Forwarded-For` entry across every header line, which the proxy appended.
    /// An untrusted socket peer is always keyed by its actual IP and cannot select a
    /// quota bucket by forging this header.
    fn client(&self, headers: &HeaderMap, extensions: &Extensions) -> Result<IpAddr, AppError> {
        let peer = extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map_or(IpAddr::from([0, 0, 0, 0]), |info| info.0.ip());
        let trust_forwarded = self.trust_proxy_headers
            && self
                .trusted_proxy_cidrs
                .iter()
                .any(|cidr| cidr.contains(peer));
        let ip = if trust_forwarded {
            headers
                .get_all("x-forwarded-for")
                .iter()
                .next_back()
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.rsplit(',').next()?.trim().parse().ok())
                .ok_or_else(|| AppError::BadRequest("missing client address".into()))?
        } else {
            peer
        };
        Ok(client_bucket(ip))
    }
}

/// IPv6 clients get a whole /64 (one subscriber's usual allocation), so rotating
/// addresses inside it doesn't buy more room. IPv4 addresses, including IPv4 clients
/// that a dual-stack socket reports as `::ffff:a.b.c.d`, count individually.
fn client_bucket(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) => {
            let mut segments = v6.segments();
            segments[4..].fill(0);
            IpAddr::from(segments)
        }
        v4 => v4,
    }
}

fn receive_quota_subject(client: IpAddr) -> String {
    hex::encode(Sha256::digest(client.to_string().as_bytes()))
}

pub fn router(trust_proxy_headers: bool) -> Router {
    router_with_proxies(trust_proxy_headers, vec![], None)
}

pub fn router_with_store(
    trust_proxy_headers: bool,
    shared: Option<crate::pairing_store::PairingStore>,
) -> Router {
    router_with_proxies(trust_proxy_headers, vec![], shared)
}

pub fn router_with_proxies(
    trust_proxy_headers: bool,
    trusted_proxy_cidrs: Vec<crate::config::TrustedProxyCidr>,
    shared: Option<crate::pairing_store::PairingStore>,
) -> Router {
    Router::new()
        .route("/pairing/{channel}/{slot}", put(send).get(receive))
        .with_state(Mailbox {
            entries: Arc::default(),
            trust_proxy_headers,
            trusted_proxy_cidrs,
            shared,
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
    if message.data.is_empty() || message.data.len() > slot.max_data_len() {
        return Err(AppError::BadRequest("message too large".into()));
    }
    let client = mailbox.client(&headers, &extensions)?;
    if let Some(shared) = &mailbox.shared {
        let subject = receive_quota_subject(client);
        shared
            .send(
                &channel.to_ascii_lowercase(),
                slot.as_str(),
                &subject,
                &message.data,
            )
            .await?;
        return Ok(StatusCode::NO_CONTENT);
    }
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
        let at = map
            .iter()
            .filter(|((id, _), _)| id == &key.0)
            .map(|(_, entry)| entry.at)
            .min()
            .unwrap_or_else(Instant::now);
        map.insert(
            key,
            Entry {
                at,
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
    extensions: Extensions,
) -> Result<Json<PairMessage>, AppError> {
    authorize(&channel, &headers)?;
    let client = mailbox.client(&headers, &extensions)?;
    if let Some(shared) = &mailbox.shared {
        // Poll quotas follow the resolved client IP, not the caller-controlled channel.
        // Otherwise a client can mint another valid token/channel for each fresh bucket.
        let subject = receive_quota_subject(client);
        shared.admit_receive(&subject).await?;
        return Ok(Json(PairMessage {
            data: shared
                .receive(&channel.to_ascii_lowercase(), slot.as_str())
                .await?,
        }));
    }
    mailbox
        .with(|map| {
            map.get_mut(&(channel.to_ascii_lowercase(), slot))
                .and_then(|entry| entry.data.take())
        })
        .map(|data| Json(PairMessage { data }))
        .ok_or(AppError::NotFound)
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;

    use super::{client_bucket, receive_quota_subject};

    #[test]
    fn keeps_ipv4_clients_apart_even_when_mapped_to_ipv6() {
        let a: IpAddr = "::ffff:198.51.100.1".parse().unwrap();
        let b: IpAddr = "::ffff:198.51.100.2".parse().unwrap();
        assert_ne!(client_bucket(a), client_bucket(b));
        assert_eq!(client_bucket(a), "198.51.100.1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn groups_ipv6_clients_by_64() {
        let a: IpAddr = "2001:db8:1:2::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:ffff::9".parse().unwrap();
        let c: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        assert_eq!(client_bucket(a), client_bucket(b));
        assert_ne!(client_bucket(a), client_bucket(c));
    }

    #[test]
    fn receive_quota_identity_is_stable_for_the_canonical_client_bucket() {
        let client: IpAddr = "192.0.2.10".parse().unwrap();
        assert_eq!(
            receive_quota_subject(client),
            receive_quota_subject("192.0.2.10".parse().unwrap())
        );
        assert_ne!(
            receive_quota_subject(client),
            receive_quota_subject("192.0.2.11".parse().unwrap())
        );
    }
}
