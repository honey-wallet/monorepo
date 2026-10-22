//! Clerk session tokens (Sign in with Apple / Google / email in the apps).
//!
//! Identity only. A verified token says which Clerk user is calling; it grants no
//! wallet authority and is unrelated to SIWE sessions. Keys and recovery phrases never
//! pass through Clerk or this module (see the custody model in `lib.rs`).
//!
//! Off unless `CLERK_JWKS_URL` and `CLERK_ISSUER` are both set. Tokens must be RS256,
//! signed by a key from the instance JWKS, issued by `CLERK_ISSUER`, inside `nbf..exp`,
//! not `sts: pending`, and (when the token names one) from an allowed `azp`.

use std::{
    collections::HashMap,
    env,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{FromRef, FromRequestParts},
    http::request::Parts,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::StreamExt;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};

use crate::{config::ConfigError, error::AppError};

const MAX_TOKEN_BYTES: usize = 8 * 1024;
const MAX_JWKS_BYTES: usize = 64 * 1024;
const MAX_KEYS: usize = 16;
const MAX_AUTHORIZED_PARTIES: usize = 16;
const CLOCK_LEEWAY_SECS: i64 = 5;
/// Fetched keys are used for this long before a background-free refresh on next use.
const KEYS_TTL: Duration = Duration::from_secs(10 * 60);
/// At most one JWKS fetch per interval, however many unknown `kid`s arrive.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

/// Where the instance's keys live and who issues its tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClerkConfig {
    /// `https://<frontend-api>/.well-known/jwks.json`
    pub jwks_url: String,
    /// The Frontend API URL, exactly as the `iss` claim carries it (no trailing slash).
    pub issuer: String,
    /// Allowed `azp` origins. Native apps send tokens without `azp`; those still pass.
    pub authorized_parties: Vec<String>,
}

impl ClerkConfig {
    /// `None` when Clerk isn't configured; an error when it's half configured.
    pub fn from_env() -> Result<Option<Self>, ConfigError> {
        let jwks_url = optional_var("CLERK_JWKS_URL")?;
        let issuer = optional_var("CLERK_ISSUER")?;
        let authorized_parties: Vec<String> = optional_var("CLERK_AUTHORIZED_PARTIES")?
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|party| !party.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        match (jwks_url, issuer) {
            (None, None) if authorized_parties.is_empty() => Ok(None),
            (Some(jwks_url), Some(issuer)) => Ok(Some(Self {
                jwks_url,
                issuer,
                authorized_parties,
            })),
            _ => Err(ConfigError::Invalid {
                name: "CLERK_JWKS_URL/CLERK_ISSUER",
            }),
        }
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        validate_url(&self.jwks_url, false).map_err(|()| ConfigError::Invalid {
            name: "CLERK_JWKS_URL",
        })?;
        validate_url(&self.issuer, true).map_err(|()| ConfigError::Invalid {
            name: "CLERK_ISSUER",
        })?;
        if self.authorized_parties.len() > MAX_AUTHORIZED_PARTIES
            || self
                .authorized_parties
                .iter()
                .any(|party| validate_url(party, true).is_err())
        {
            return Err(ConfigError::Invalid {
                name: "CLERK_AUTHORIZED_PARTIES",
            });
        }
        Ok(())
    }
}

fn optional_var(name: &'static str) -> Result<Option<String>, ConfigError> {
    match env::var(name) {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value.trim().to_owned())),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(_) => Err(ConfigError::Invalid { name }),
    }
}

/// HTTPS (plain HTTP only on loopback), no credentials, query or fragment. An origin has
/// no path and no trailing slash, so it compares exactly with `iss` / `azp`.
fn validate_url(raw: &str, origin_only: bool) -> Result<(), ()> {
    let uri: axum::http::Uri = raw.parse().map_err(|_| ())?;
    let local = matches!(uri.host(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let scheme_ok =
        uri.scheme_str() == Some("https") || (local && uri.scheme_str() == Some("http"));
    if !scheme_ok
        || uri.host().is_none_or(str::is_empty)
        || raw.len() > 512
        || raw.contains(['@', '#'])
        || uri.query().is_some()
        || (origin_only && (uri.path() != "/" || raw.ends_with('/')))
        || (!origin_only && uri.path() == "/")
    {
        return Err(());
    }
    Ok(())
}

/// A verified Clerk session: the ids only. No profile data and nothing key-related.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClerkSession {
    pub user_id: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ClerkError {
    #[error("malformed token")]
    Malformed,
    #[error("unsupported token algorithm")]
    UnsupportedAlgorithm,
    #[error("unknown signing key")]
    UnknownKey,
    #[error("invalid signature")]
    BadSignature,
    #[error("wrong issuer")]
    WrongIssuer,
    #[error("token expired")]
    Expired,
    #[error("token not yet valid")]
    NotYetValid,
    #[error("unauthorized party")]
    UnauthorizedParty,
    #[error("session pending")]
    Pending,
    #[error("signing keys unavailable")]
    KeysUnavailable,
}

impl From<ClerkError> for AppError {
    fn from(error: ClerkError) -> Self {
        match error {
            // Our side (JWKS unreachable and nothing cached): retryable, not the caller's fault.
            ClerkError::KeysUnavailable => AppError::Busy,
            _ => AppError::Unauthorized,
        }
    }
}

type PublicKey = RsaPublicKeyComponents<Vec<u8>>;

#[derive(Default)]
struct KeySet {
    keys: HashMap<String, PublicKey>,
    fetched_at: Option<Instant>,
    attempted_at: Option<Instant>,
}

enum KeySource {
    Remote(reqwest::Client),
    /// A fixed key set (tests, or a networkless deployment): never refreshed.
    Static,
}

struct Inner {
    config: ClerkConfig,
    source: KeySource,
    keys: RwLock<KeySet>,
    refresh: Mutex<()>,
}

/// Verifies Clerk session tokens against the instance JWKS (fetched lazily, cached).
#[derive(Clone)]
pub struct ClerkVerifier {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for ClerkVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClerkVerifier")
            .field("issuer", &self.inner.config.issuer)
            .finish_non_exhaustive()
    }
}

impl ClerkVerifier {
    /// Fetches keys from `config.jwks_url` on first use. No network at construction.
    pub fn new(config: ClerkConfig) -> Result<Self, ConfigError> {
        config.validate()?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(2)
            .build()
            .map_err(|_| ConfigError::Invalid {
                name: "CLERK_JWKS_URL",
            })?;
        Ok(Self::with_source(
            config,
            KeySource::Remote(client),
            KeySet::default(),
        ))
    }

    /// Uses a fixed JWKS document and never fetches (tests and networkless setups).
    pub fn from_jwks(config: ClerkConfig, jwks: &[u8]) -> Result<Self, ClerkError> {
        let keys = parse_jwks(jwks)?;
        Ok(Self::with_source(
            config,
            KeySource::Static,
            KeySet {
                keys,
                fetched_at: Some(Instant::now()),
                attempted_at: None,
            },
        ))
    }

    fn with_source(config: ClerkConfig, source: KeySource, keys: KeySet) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                source,
                keys: RwLock::new(keys),
                refresh: Mutex::new(()),
            }),
        }
    }

    /// Optional verifier from the server configuration.
    pub fn from_config(config: &crate::Config) -> Result<Option<Self>, ConfigError> {
        config.clerk.clone().map(Self::new).transpose()
    }

    pub async fn verify(&self, token: &str) -> Result<ClerkSession, ClerkError> {
        let parsed = ParsedToken::parse(token)?;
        let key = self.key(&parsed.kid).await?;
        parsed.verify(&key, &self.inner.config, unix_now())
    }

    async fn key(&self, kid: &str) -> Result<PublicKey, ClerkError> {
        {
            let set = self.inner.keys.read().await;
            if let Some(key) = set.keys.get(kid)
                && (fresh(&set) || matches!(self.inner.source, KeySource::Static))
            {
                return Ok(key.clone());
            }
        }
        let KeySource::Remote(client) = &self.inner.source else {
            return Err(ClerkError::UnknownKey);
        };
        // One fetch at a time; waiters re-check what it brought.
        let _refreshing = self.inner.refresh.lock().await;
        let due = {
            let set = self.inner.keys.read().await;
            if let Some(key) = set.keys.get(kid)
                && fresh(&set)
            {
                return Ok(key.clone());
            }
            set.attempted_at
                .is_none_or(|at| at.elapsed() >= MIN_REFRESH_INTERVAL)
        };
        if due {
            let fetched = fetch_jwks(client, &self.inner.config.jwks_url).await;
            let mut set = self.inner.keys.write().await;
            set.attempted_at = Some(Instant::now());
            match fetched {
                Ok(keys) => {
                    set.keys = keys;
                    set.fetched_at = Some(Instant::now());
                }
                // Keep serving the last good keys; Clerk rotates rarely.
                Err(error) => tracing::warn!(%error, "Clerk JWKS refresh failed"),
            }
        }
        let set = self.inner.keys.read().await;
        match set.keys.get(kid) {
            Some(key) => Ok(key.clone()),
            None if set.keys.is_empty() => Err(ClerkError::KeysUnavailable),
            None => Err(ClerkError::UnknownKey),
        }
    }
}

fn fresh(set: &KeySet) -> bool {
    set.fetched_at.is_some_and(|at| at.elapsed() < KEYS_TTL)
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
        })
}

async fn fetch_jwks(
    client: &reqwest::Client,
    url: &str,
) -> Result<HashMap<String, PublicKey>, ClerkError> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| ClerkError::KeysUnavailable)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_JWKS_BYTES as u64)
    {
        return Err(ClerkError::KeysUnavailable);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ClerkError::KeysUnavailable)?;
        if body.len() + chunk.len() > MAX_JWKS_BYTES {
            return Err(ClerkError::KeysUnavailable);
        }
        body.extend_from_slice(&chunk);
    }
    parse_jwks(&body).map_err(|_| ClerkError::KeysUnavailable)
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kty: String,
    kid: Option<String>,
    alg: Option<String>,
    #[serde(rename = "use")]
    usage: Option<String>,
    n: Option<String>,
    e: Option<String>,
}

/// RSA signing keys by `kid`. Other key types and non-RS256 keys are ignored.
fn parse_jwks(bytes: &[u8]) -> Result<HashMap<String, PublicKey>, ClerkError> {
    let jwks: Jwks = serde_json::from_slice(bytes).map_err(|_| ClerkError::Malformed)?;
    let mut keys = HashMap::new();
    for jwk in jwks.keys {
        let usable = jwk.kty == "RSA"
            && jwk.alg.as_deref().is_none_or(|alg| alg == "RS256")
            && jwk.usage.as_deref().is_none_or(|usage| usage == "sig");
        let (Some(kid), Some(n), Some(e), true) = (jwk.kid, jwk.n, jwk.e, usable) else {
            continue;
        };
        if kid.is_empty() || kid.len() > 128 || keys.len() >= MAX_KEYS {
            continue;
        }
        let (Ok(n), Ok(e)) = (URL_SAFE_NO_PAD.decode(n), URL_SAFE_NO_PAD.decode(e)) else {
            continue;
        };
        keys.insert(
            kid,
            PublicKey {
                n: strip_leading_zeros(n),
                e: strip_leading_zeros(e),
            },
        );
    }
    if keys.is_empty() {
        return Err(ClerkError::Malformed);
    }
    Ok(keys)
}

fn strip_leading_zeros(mut bytes: Vec<u8>) -> Vec<u8> {
    let zeros = bytes.iter().take_while(|byte| **byte == 0).count();
    bytes.drain(..zeros);
    bytes
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: Option<String>,
    crit: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    sub: String,
    exp: i64,
    nbf: Option<i64>,
    sid: Option<String>,
    azp: Option<String>,
    sts: Option<String>,
}

struct ParsedToken<'a> {
    kid: String,
    signing_input: &'a [u8],
    signature: Vec<u8>,
    payload: Vec<u8>,
}

impl<'a> ParsedToken<'a> {
    fn parse(token: &'a str) -> Result<Self, ClerkError> {
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
            return Err(ClerkError::Malformed);
        }
        let mut parts = token.split('.');
        let (Some(header), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(ClerkError::Malformed);
        };
        let decode = |part: &str| {
            URL_SAFE_NO_PAD
                .decode(part)
                .map_err(|_| ClerkError::Malformed)
        };
        let header: Header =
            serde_json::from_slice(&decode(header)?).map_err(|_| ClerkError::Malformed)?;
        // Only what Clerk issues. Never `none`, never HMAC with a public key.
        if header.alg != "RS256" || header.crit.is_some() {
            return Err(ClerkError::UnsupportedAlgorithm);
        }
        let kid = header
            .kid
            .filter(|kid| !kid.is_empty())
            .ok_or(ClerkError::Malformed)?;
        let signing_input_len = token.len() - signature.len() - 1;
        Ok(Self {
            kid,
            signing_input: &token.as_bytes()[..signing_input_len],
            signature: decode(signature)?,
            payload: decode(payload)?,
        })
    }

    fn verify(
        &self,
        key: &PublicKey,
        config: &ClerkConfig,
        now: i64,
    ) -> Result<ClerkSession, ClerkError> {
        key.verify(
            &RSA_PKCS1_2048_8192_SHA256,
            self.signing_input,
            &self.signature,
        )
        .map_err(|_| ClerkError::BadSignature)?;
        let claims: Claims =
            serde_json::from_slice(&self.payload).map_err(|_| ClerkError::Malformed)?;
        if claims.iss != config.issuer {
            return Err(ClerkError::WrongIssuer);
        }
        if now >= claims.exp.saturating_add(CLOCK_LEEWAY_SECS) {
            return Err(ClerkError::Expired);
        }
        if claims
            .nbf
            .is_some_and(|nbf| now < nbf.saturating_sub(CLOCK_LEEWAY_SECS))
        {
            return Err(ClerkError::NotYetValid);
        }
        if let Some(azp) = &claims.azp
            && !config.authorized_parties.is_empty()
            && !config.authorized_parties.contains(azp)
        {
            return Err(ClerkError::UnauthorizedParty);
        }
        if claims.sts.as_deref() == Some("pending") {
            return Err(ClerkError::Pending);
        }
        if claims.sub.is_empty() || claims.sub.len() > 128 {
            return Err(ClerkError::Malformed);
        }
        Ok(ClerkSession {
            user_id: claims.sub,
            session_id: claims.sid,
        })
    }
}

/// `Authorization: Bearer <Clerk session token>`, verified. Use it in any handler whose
/// router state provides `Option<ClerkVerifier>`; with Clerk off it rejects with
/// `unsupported`, and a bad or expired token with `unauthorized`.
#[derive(Debug, Clone)]
pub struct ClerkUser(pub ClerkSession);

impl<S> FromRequestParts<S> for ClerkUser
where
    S: Send + Sync,
    Option<ClerkVerifier>: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let verifier = Option::<ClerkVerifier>::from_ref(state)
            .ok_or_else(|| AppError::Unsupported("Clerk sign-in not configured".into()))?;
        let token = crate::routes::identity::bearer(&parts.headers)?;
        match verifier.verify(token).await {
            Ok(session) => Ok(Self(session)),
            Err(error) => {
                tracing::debug!(%error, "Clerk session rejected");
                Err(error.into())
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::{
        rand::SystemRandom,
        signature::{RSA_PKCS1_SHA256, RsaKeyPair, RsaPublicKeyComponents},
    };

    use super::ClerkConfig;

    /// A 2048-bit key generated locally for these tests only (never a Clerk key).
    const TEST_KEY: &[u8] = include_bytes!("../tests/fixtures/clerk-test-rsa2048.pk8");
    pub const KID: &str = "ins_test_key";
    pub const ISSUER: &str = "https://clerk.honey.test";

    pub fn config() -> ClerkConfig {
        ClerkConfig {
            jwks_url: "https://clerk.honey.test/.well-known/jwks.json".into(),
            issuer: ISSUER.into(),
            authorized_parties: vec![],
        }
    }

    fn key() -> RsaKeyPair {
        RsaKeyPair::from_pkcs8(TEST_KEY).expect("test key")
    }

    pub fn jwks() -> Vec<u8> {
        let public: RsaPublicKeyComponents<Vec<u8>> = key().public().into();
        serde_json::to_vec(&serde_json::json!({
            "keys": [{
                "kty": "RSA",
                "use": "sig",
                "alg": "RS256",
                "kid": KID,
                "n": URL_SAFE_NO_PAD.encode(public.n),
                "e": URL_SAFE_NO_PAD.encode(public.e),
            }]
        }))
        .unwrap()
    }

    pub fn sign_with(header: &serde_json::Value, claims: &serde_json::Value) -> String {
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(header).unwrap()),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap()),
        );
        let key = key();
        let mut signature = vec![0; key.public().modulus_len()];
        key.sign(
            &RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            input.as_bytes(),
            &mut signature,
        )
        .unwrap();
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    pub fn sign(claims: &serde_json::Value) -> String {
        sign_with(
            &serde_json::json!({ "alg": "RS256", "kid": KID, "typ": "JWT" }),
            claims,
        )
    }

    pub fn claims(now: i64) -> serde_json::Value {
        serde_json::json!({
            "iss": ISSUER,
            "sub": "user_2abc",
            "sid": "sess_2abc",
            "iat": now - 10,
            "nbf": now - 10,
            "exp": now + 60,
        })
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde_json::json;

    use super::{test_support::*, *};

    fn verifier(config: ClerkConfig) -> ClerkVerifier {
        ClerkVerifier::from_jwks(config, &jwks()).unwrap()
    }

    #[tokio::test]
    async fn accepts_a_valid_session_token() {
        let session = verifier(config())
            .verify(&sign(&claims(unix_now())))
            .await
            .unwrap();
        assert_eq!(
            session,
            ClerkSession {
                user_id: "user_2abc".into(),
                session_id: Some("sess_2abc".into()),
            }
        );
    }

    #[tokio::test]
    async fn rejects_tampered_expired_and_foreign_tokens() {
        let now = unix_now();
        let verifier = verifier(config());

        let token = sign(&claims(now));
        let (input, _) = token.rsplit_once('.').unwrap();
        let (header, _) = input.split_once('.').unwrap();
        let forged = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({ "iss": ISSUER, "sub": "user_x", "exp": now + 60 }))
                .unwrap(),
        );
        let tampered = format!("{header}.{forged}.{}", token.rsplit_once('.').unwrap().1);
        assert_eq!(
            verifier.verify(&tampered).await,
            Err(ClerkError::BadSignature)
        );

        let mut expired = claims(now);
        expired["exp"] = json!(now - 60);
        assert_eq!(
            verifier.verify(&sign(&expired)).await,
            Err(ClerkError::Expired)
        );

        let mut early = claims(now);
        early["nbf"] = json!(now + 120);
        assert_eq!(
            verifier.verify(&sign(&early)).await,
            Err(ClerkError::NotYetValid)
        );

        let mut other_issuer = claims(now);
        other_issuer["iss"] = json!("https://evil.example");
        assert_eq!(
            verifier.verify(&sign(&other_issuer)).await,
            Err(ClerkError::WrongIssuer)
        );

        let mut pending = claims(now);
        pending["sts"] = json!("pending");
        assert_eq!(
            verifier.verify(&sign(&pending)).await,
            Err(ClerkError::Pending)
        );

        let unknown = sign_with(&json!({ "alg": "RS256", "kid": "other" }), &claims(now));
        assert_eq!(verifier.verify(&unknown).await, Err(ClerkError::UnknownKey));

        for alg in ["none", "HS256", "RS512", "ES256"] {
            let token = sign_with(&json!({ "alg": alg, "kid": KID }), &claims(now));
            assert_eq!(
                verifier.verify(&token).await,
                Err(ClerkError::UnsupportedAlgorithm),
                "{alg}"
            );
        }
        let critical = sign_with(
            &json!({ "alg": "RS256", "kid": KID, "crit": ["exp"] }),
            &claims(now),
        );
        assert_eq!(
            verifier.verify(&critical).await,
            Err(ClerkError::UnsupportedAlgorithm)
        );

        for malformed in [
            "",
            "a.b",
            "a.b.c.d",
            "!!.!!.!!",
            &"a".repeat(MAX_TOKEN_BYTES + 1),
        ] {
            assert_eq!(verifier.verify(malformed).await, Err(ClerkError::Malformed));
        }
    }

    #[tokio::test]
    async fn checks_authorized_parties_only_when_the_token_names_one() {
        let now = unix_now();
        let verifier = verifier(ClerkConfig {
            authorized_parties: vec!["https://wallet.honey.test".into()],
            ..config()
        });
        let mut web = claims(now);
        web["azp"] = json!("https://wallet.honey.test");
        assert!(verifier.verify(&sign(&web)).await.is_ok());
        web["azp"] = json!("https://evil.example");
        assert_eq!(
            verifier.verify(&sign(&web)).await,
            Err(ClerkError::UnauthorizedParty)
        );
        // Native apps have no origin, so their tokens carry no azp.
        assert!(verifier.verify(&sign(&claims(now))).await.is_ok());
    }

    /// The remote path against a loopback JWKS server: fetched once, cached, and an
    /// unknown `kid` can't trigger another fetch inside the refresh interval.
    #[tokio::test]
    async fn fetches_jwks_once_and_rate_limits_unknown_keys() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fetches = Arc::new(AtomicUsize::new(0));
        let counter = fetches.clone();
        let app = axum::Router::new().route(
            "/.well-known/jwks.json",
            axum::routing::get(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                async { jwks() }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let verifier = ClerkVerifier::new(ClerkConfig {
            jwks_url: format!("http://{address}/.well-known/jwks.json"),
            ..config()
        })
        .unwrap();

        let now = unix_now();
        assert!(verifier.verify(&sign(&claims(now))).await.is_ok());
        assert!(verifier.verify(&sign(&claims(now))).await.is_ok());
        let unknown = sign_with(&json!({ "alg": "RS256", "kid": "rotated" }), &claims(now));
        assert_eq!(verifier.verify(&unknown).await, Err(ClerkError::UnknownKey));
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        server.abort();

        // Nothing cached and nothing reachable: retryable on our side, not a 401.
        let offline = ClerkVerifier::new(ClerkConfig {
            jwks_url: format!("http://{address}/.well-known/jwks.json"),
            ..config()
        })
        .unwrap();
        let _ = server.await;
        assert_eq!(
            offline.verify(&sign(&claims(now))).await,
            Err(ClerkError::KeysUnavailable)
        );
    }

    #[test]
    fn jwks_keeps_only_rs256_signing_keys() {
        assert_eq!(parse_jwks(&jwks()).unwrap().len(), 1);
        let others = json!({ "keys": [
            { "kty": "EC", "kid": "ec", "crv": "P-256", "x": "AA", "y": "AA" },
            { "kty": "RSA", "kid": "enc", "use": "enc", "n": "AQAB", "e": "AQAB" },
            { "kty": "RSA", "kid": "ps", "alg": "PS256", "n": "AQAB", "e": "AQAB" },
        ]});
        assert_eq!(
            parse_jwks(&serde_json::to_vec(&others).unwrap()).err(),
            Some(ClerkError::Malformed)
        );
        assert_eq!(parse_jwks(b"not json").err(), Some(ClerkError::Malformed));
    }

    #[test]
    fn configuration_requires_https_and_exact_origins() {
        assert!(config().validate().is_ok());
        let local = ClerkConfig {
            jwks_url: "http://127.0.0.1:3000/.well-known/jwks.json".into(),
            issuer: "http://localhost:3000".into(),
            authorized_parties: vec![],
        };
        assert!(local.validate().is_ok());
        for bad in [
            ClerkConfig {
                jwks_url: "http://clerk.honey.test/.well-known/jwks.json".into(),
                ..config()
            },
            ClerkConfig {
                jwks_url: "https://clerk.honey.test".into(),
                ..config()
            },
            ClerkConfig {
                issuer: "https://clerk.honey.test/".into(),
                ..config()
            },
            ClerkConfig {
                issuer: "https://user@clerk.honey.test".into(),
                ..config()
            },
            ClerkConfig {
                authorized_parties: vec!["https://wallet.honey.test/app".into()],
                ..config()
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
    }
}
