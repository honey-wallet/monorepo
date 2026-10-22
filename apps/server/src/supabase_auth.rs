//! Supabase Auth access tokens (Sign in with Apple / Google / email in the apps).
//!
//! Identity only. A verified token says which Supabase user is calling; it grants no
//! wallet authority and is unrelated to SIWE sessions. Keys and recovery phrases never
//! pass through Supabase or this module (see the custody model in `lib.rs`).
//!
//! Off unless `SUPABASE_URL` is set. The issuer is `<SUPABASE_URL>/auth/v1` and the keys
//! come from `<issuer>/.well-known/jwks.json`, so the project must use asymmetric JWT
//! signing keys (ES256 or RS256). Tokens signed with the legacy shared secret (HS256)
//! are rejected: that secret is never published and this server never holds it.
//! Tokens must be issued by that issuer for `aud: authenticated`, be inside `nbf..exp`,
//! and belong to a signed-in, non-anonymous user (`role: authenticated`).

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
use ring::signature::{
    ECDSA_P256_SHA256_FIXED, RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents, UnparsedPublicKey,
};
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};

use crate::{config::ConfigError, error::AppError};

const MAX_TOKEN_BYTES: usize = 8 * 1024;
const MAX_JWKS_BYTES: usize = 64 * 1024;
const MAX_KEYS: usize = 16;
const CLOCK_LEEWAY_SECS: i64 = 5;
/// The audience and role of a signed-in user's access token.
const AUTHENTICATED: &str = "authenticated";
/// Fetched keys are used for this long before a refresh on next use. Supabase caches the
/// JWKS at its edge for 10 minutes, so a new standby key shows up within 20.
const KEYS_TTL: Duration = Duration::from_secs(10 * 60);
/// At most one JWKS fetch per interval, however many unknown `kid`s arrive.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

/// Where the project's keys live and who issues its tokens, from `SUPABASE_URL`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupabaseAuthConfig {
    /// `<project url>/auth/v1/.well-known/jwks.json`
    pub jwks_url: String,
    /// `<project url>/auth/v1`, exactly as the `iss` claim carries it.
    pub issuer: String,
}

impl SupabaseAuthConfig {
    /// From the project URL (`https://<ref>.supabase.co`, or a custom auth domain).
    pub fn from_project_url(url: &str) -> Result<Self, ConfigError> {
        let url = url.trim().trim_end_matches('/');
        validate_origin(url).map_err(|()| ConfigError::Invalid {
            name: "SUPABASE_URL",
        })?;
        let issuer = format!("{url}/auth/v1");
        Ok(Self {
            jwks_url: format!("{issuer}/.well-known/jwks.json"),
            issuer,
        })
    }

    /// `None` when Supabase Auth isn't configured.
    pub fn from_env() -> Result<Option<Self>, ConfigError> {
        match env::var("SUPABASE_URL") {
            Ok(value) if value.trim().is_empty() => Ok(None),
            Ok(value) => Self::from_project_url(&value).map(Some),
            Err(env::VarError::NotPresent) => Ok(None),
            Err(_) => Err(ConfigError::Invalid {
                name: "SUPABASE_URL",
            }),
        }
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        let derived = self
            .issuer
            .strip_suffix("/auth/v1")
            .map(Self::from_project_url);
        match derived {
            Some(Ok(derived)) if derived == *self => Ok(()),
            _ => Err(ConfigError::Invalid {
                name: "SUPABASE_URL",
            }),
        }
    }
}

/// HTTPS (plain HTTP only on loopback), no credentials, path, query or fragment.
fn validate_origin(raw: &str) -> Result<(), ()> {
    let uri: axum::http::Uri = raw.parse().map_err(|_| ())?;
    let local = matches!(uri.host(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let scheme_ok =
        uri.scheme_str() == Some("https") || (local && uri.scheme_str() == Some("http"));
    if !scheme_ok
        || uri.host().is_none_or(str::is_empty)
        || raw.len() > 256
        || raw.contains(['@', '#', '?'])
        || uri.path() != "/"
        || raw.ends_with('/')
    {
        return Err(());
    }
    Ok(())
}

/// A verified Supabase session: the ids only. No profile data and nothing key-related.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupabaseSession {
    pub user_id: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SupabaseAuthError {
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
    #[error("wrong audience")]
    WrongAudience,
    #[error("not a signed-in user")]
    NotAUser,
    #[error("token expired")]
    Expired,
    #[error("token not yet valid")]
    NotYetValid,
    #[error("signing keys unavailable")]
    KeysUnavailable,
}

impl From<SupabaseAuthError> for AppError {
    fn from(error: SupabaseAuthError) -> Self {
        match error {
            // Our side (JWKS unreachable and nothing cached): retryable, not the caller's fault.
            SupabaseAuthError::KeysUnavailable => AppError::Busy,
            _ => AppError::Unauthorized,
        }
    }
}

/// A public signing key, tied to the one algorithm it may verify.
#[derive(Clone)]
enum PublicKey {
    /// RS256
    Rsa(RsaPublicKeyComponents<Vec<u8>>),
    /// ES256: the uncompressed P-256 point (`04 || x || y`).
    P256(Vec<u8>),
}

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
    config: SupabaseAuthConfig,
    source: KeySource,
    keys: RwLock<KeySet>,
    refresh: Mutex<()>,
}

/// Verifies Supabase access tokens against the project JWKS (fetched lazily, cached).
#[derive(Clone)]
pub struct SupabaseVerifier {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for SupabaseVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SupabaseVerifier")
            .field("issuer", &self.inner.config.issuer)
            .finish_non_exhaustive()
    }
}

impl SupabaseVerifier {
    /// Fetches keys from `config.jwks_url` on first use. No network at construction.
    pub fn new(config: SupabaseAuthConfig) -> Result<Self, ConfigError> {
        config.validate()?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(2)
            .build()
            .map_err(|_| ConfigError::Invalid {
                name: "SUPABASE_URL",
            })?;
        Ok(Self::with_source(
            config,
            KeySource::Remote(client),
            KeySet::default(),
        ))
    }

    /// Uses a fixed JWKS document and never fetches (tests and networkless setups).
    pub fn from_jwks(config: SupabaseAuthConfig, jwks: &[u8]) -> Result<Self, SupabaseAuthError> {
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

    fn with_source(config: SupabaseAuthConfig, source: KeySource, keys: KeySet) -> Self {
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
        config.supabase_auth.clone().map(Self::new).transpose()
    }

    pub async fn verify(&self, token: &str) -> Result<SupabaseSession, SupabaseAuthError> {
        let parsed = ParsedToken::parse(token)?;
        let key = self.key(&parsed.kid).await?;
        parsed.verify(&key, &self.inner.config, unix_now())
    }

    async fn key(&self, kid: &str) -> Result<PublicKey, SupabaseAuthError> {
        {
            let set = self.inner.keys.read().await;
            if let Some(key) = set.keys.get(kid)
                && (fresh(&set) || matches!(self.inner.source, KeySource::Static))
            {
                return Ok(key.clone());
            }
        }
        let KeySource::Remote(client) = &self.inner.source else {
            return Err(SupabaseAuthError::UnknownKey);
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
                // Keep serving the last good keys; rotation keeps old keys valid for a while.
                Err(error) => tracing::warn!(%error, "Supabase JWKS refresh failed"),
            }
        }
        let set = self.inner.keys.read().await;
        match set.keys.get(kid) {
            Some(key) => Ok(key.clone()),
            None if set.keys.is_empty() => Err(SupabaseAuthError::KeysUnavailable),
            None => Err(SupabaseAuthError::UnknownKey),
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
) -> Result<HashMap<String, PublicKey>, SupabaseAuthError> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| SupabaseAuthError::KeysUnavailable)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_JWKS_BYTES as u64)
    {
        return Err(SupabaseAuthError::KeysUnavailable);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| SupabaseAuthError::KeysUnavailable)?;
        if body.len() + chunk.len() > MAX_JWKS_BYTES {
            return Err(SupabaseAuthError::KeysUnavailable);
        }
        body.extend_from_slice(&chunk);
    }
    parse_jwks(&body).map_err(|_| SupabaseAuthError::KeysUnavailable)
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
    // RSA
    n: Option<String>,
    e: Option<String>,
    // EC
    crv: Option<String>,
    x: Option<String>,
    y: Option<String>,
}

impl Jwk {
    fn public_key(self) -> Option<(String, PublicKey)> {
        let kid = self.kid.filter(|kid| !kid.is_empty() && kid.len() <= 128)?;
        if self.usage.as_deref().is_some_and(|usage| usage != "sig") {
            return None;
        }
        let decode = |part: Option<String>| URL_SAFE_NO_PAD.decode(part?).ok();
        let key = match (self.kty.as_str(), self.alg.as_deref()) {
            ("RSA", None | Some("RS256")) => PublicKey::Rsa(RsaPublicKeyComponents {
                n: strip_leading_zeros(decode(self.n)?),
                e: strip_leading_zeros(decode(self.e)?),
            }),
            ("EC", None | Some("ES256")) if self.crv.as_deref() == Some("P-256") => {
                let (x, y) = (decode(self.x)?, decode(self.y)?);
                if x.len() != 32 || y.len() != 32 {
                    return None;
                }
                PublicKey::P256([&[4][..], &x, &y].concat())
            }
            _ => return None,
        };
        Some((kid, key))
    }
}

/// Signing keys by `kid`: RSA (RS256) and P-256 (ES256). Anything else is ignored.
fn parse_jwks(bytes: &[u8]) -> Result<HashMap<String, PublicKey>, SupabaseAuthError> {
    let jwks: Jwks = serde_json::from_slice(bytes).map_err(|_| SupabaseAuthError::Malformed)?;
    let keys: HashMap<_, _> = jwks
        .keys
        .into_iter()
        .filter_map(Jwk::public_key)
        .take(MAX_KEYS)
        .collect();
    if keys.is_empty() {
        return Err(SupabaseAuthError::Malformed);
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
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

impl Audience {
    fn contains(&self, wanted: &str) -> bool {
        match self {
            Self::One(aud) => aud == wanted,
            Self::Many(auds) => auds.iter().any(|aud| aud == wanted),
        }
    }
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    sub: String,
    aud: Audience,
    exp: i64,
    nbf: Option<i64>,
    role: Option<String>,
    session_id: Option<String>,
    #[serde(default)]
    is_anonymous: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Algorithm {
    Rs256,
    Es256,
}

struct ParsedToken<'a> {
    alg: Algorithm,
    kid: String,
    signing_input: &'a [u8],
    signature: Vec<u8>,
    payload: Vec<u8>,
}

impl<'a> ParsedToken<'a> {
    fn parse(token: &'a str) -> Result<Self, SupabaseAuthError> {
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
            return Err(SupabaseAuthError::Malformed);
        }
        let mut parts = token.split('.');
        let (Some(header), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(SupabaseAuthError::Malformed);
        };
        let decode = |part: &str| {
            URL_SAFE_NO_PAD
                .decode(part)
                .map_err(|_| SupabaseAuthError::Malformed)
        };
        let header: Header =
            serde_json::from_slice(&decode(header)?).map_err(|_| SupabaseAuthError::Malformed)?;
        // Only the asymmetric algorithms Supabase signs with. Never `none`, never HMAC.
        let alg = match header.alg.as_str() {
            "RS256" => Algorithm::Rs256,
            "ES256" => Algorithm::Es256,
            _ => return Err(SupabaseAuthError::UnsupportedAlgorithm),
        };
        if header.crit.is_some() {
            return Err(SupabaseAuthError::UnsupportedAlgorithm);
        }
        let kid = header
            .kid
            .filter(|kid| !kid.is_empty())
            .ok_or(SupabaseAuthError::Malformed)?;
        let signing_input_len = token.len() - signature.len() - 1;
        Ok(Self {
            alg,
            kid,
            signing_input: &token.as_bytes()[..signing_input_len],
            signature: decode(signature)?,
            payload: decode(payload)?,
        })
    }

    fn verify(
        &self,
        key: &PublicKey,
        config: &SupabaseAuthConfig,
        now: i64,
    ) -> Result<SupabaseSession, SupabaseAuthError> {
        // The header's algorithm must be the one the key is for.
        let verified = match (self.alg, key) {
            (Algorithm::Rs256, PublicKey::Rsa(key)) => key.verify(
                &RSA_PKCS1_2048_8192_SHA256,
                self.signing_input,
                &self.signature,
            ),
            (Algorithm::Es256, PublicKey::P256(point)) => {
                UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, point)
                    .verify(self.signing_input, &self.signature)
            }
            _ => return Err(SupabaseAuthError::UnsupportedAlgorithm),
        };
        verified.map_err(|_| SupabaseAuthError::BadSignature)?;
        let claims: Claims =
            serde_json::from_slice(&self.payload).map_err(|_| SupabaseAuthError::Malformed)?;
        if claims.iss != config.issuer {
            return Err(SupabaseAuthError::WrongIssuer);
        }
        if !claims.aud.contains(AUTHENTICATED) {
            return Err(SupabaseAuthError::WrongAudience);
        }
        if now >= claims.exp.saturating_add(CLOCK_LEEWAY_SECS) {
            return Err(SupabaseAuthError::Expired);
        }
        if claims
            .nbf
            .is_some_and(|nbf| now < nbf.saturating_sub(CLOCK_LEEWAY_SECS))
        {
            return Err(SupabaseAuthError::NotYetValid);
        }
        // Anon and service-role keys are JWTs too; only a signed-in person's token counts.
        if claims.role.as_deref() != Some(AUTHENTICATED) || claims.is_anonymous {
            return Err(SupabaseAuthError::NotAUser);
        }
        let user_id = uuid::Uuid::try_parse(&claims.sub)
            .map_err(|_| SupabaseAuthError::Malformed)?
            .hyphenated()
            .to_string();
        Ok(SupabaseSession {
            user_id,
            session_id: claims
                .session_id
                .filter(|id| !id.is_empty() && id.len() <= 128),
        })
    }
}

/// `Authorization: Bearer <Supabase access token>`, verified. Use it in any handler whose
/// router state provides `Option<SupabaseVerifier>`; with Supabase Auth off it rejects
/// with `unsupported`, and a bad or expired token with `unauthorized`.
#[derive(Debug, Clone)]
pub struct SupabaseUser(pub SupabaseSession);

impl<S> FromRequestParts<S> for SupabaseUser
where
    S: Send + Sync,
    Option<SupabaseVerifier>: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let verifier = Option::<SupabaseVerifier>::from_ref(state)
            .ok_or_else(|| AppError::Unsupported("Account sign-in not configured".into()))?;
        let token = crate::routes::identity::bearer(&parts.headers)?;
        match verifier.verify(token).await {
            Ok(session) => Ok(Self(session)),
            Err(error) => {
                tracing::debug!(%error, "Supabase access token rejected");
                Err(error.into())
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::OnceLock;

    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::{
        rand::SystemRandom,
        signature::{
            ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair, RSA_PKCS1_SHA256, RsaKeyPair,
            RsaPublicKeyComponents,
        },
    };

    use super::SupabaseAuthConfig;

    /// A 2048-bit key generated locally for these tests only (never a Supabase key).
    const TEST_RSA_KEY: &[u8] = include_bytes!("../tests/fixtures/supabase-test-rsa2048.pk8");
    pub const RSA_KID: &str = "rsa-test-key";
    pub const EC_KID: &str = "ec-test-key";
    pub const PROJECT_URL: &str = "https://honeytest.supabase.co";
    pub const ISSUER: &str = "https://honeytest.supabase.co/auth/v1";
    pub const USER_ID: &str = "8d0f8c9e-2b7a-4e55-9a51-3f0f6b2c9d11";

    pub fn config() -> SupabaseAuthConfig {
        SupabaseAuthConfig::from_project_url(PROJECT_URL).unwrap()
    }

    fn rsa() -> RsaKeyPair {
        RsaKeyPair::from_pkcs8(TEST_RSA_KEY).expect("test key")
    }

    /// A P-256 key generated in-process, once per test binary.
    fn ec() -> &'static EcdsaKeyPair {
        static KEY: OnceLock<EcdsaKeyPair> = OnceLock::new();
        KEY.get_or_init(|| {
            let rng = SystemRandom::new();
            let pkcs8 =
                EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                .unwrap()
        })
    }

    pub fn jwks() -> Vec<u8> {
        let public: RsaPublicKeyComponents<Vec<u8>> = rsa().public().into();
        let point = ec().public_key().as_ref();
        serde_json::to_vec(&serde_json::json!({
            "keys": [
                {
                    "kty": "EC",
                    "crv": "P-256",
                    "alg": "ES256",
                    "use": "sig",
                    "kid": EC_KID,
                    "key_ops": ["verify"],
                    "ext": true,
                    "x": URL_SAFE_NO_PAD.encode(&point[1..33]),
                    "y": URL_SAFE_NO_PAD.encode(&point[33..65]),
                },
                {
                    "kty": "RSA",
                    "alg": "RS256",
                    "use": "sig",
                    "kid": RSA_KID,
                    "n": URL_SAFE_NO_PAD.encode(public.n),
                    "e": URL_SAFE_NO_PAD.encode(public.e),
                },
            ]
        }))
        .unwrap()
    }

    /// Signs with the key the header names: ES256 with the P-256 key, else RS256.
    pub fn sign_with(header: &serde_json::Value, claims: &serde_json::Value) -> String {
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(header).unwrap()),
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap()),
        );
        let rng = SystemRandom::new();
        let signature = if header["alg"] == "ES256" {
            ec().sign(&rng, input.as_bytes()).unwrap().as_ref().to_vec()
        } else {
            let key = rsa();
            let mut signature = vec![0; key.public().modulus_len()];
            key.sign(&RSA_PKCS1_SHA256, &rng, input.as_bytes(), &mut signature)
                .unwrap();
            signature
        };
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    /// ES256, as Supabase signs by default with asymmetric keys.
    pub fn sign(claims: &serde_json::Value) -> String {
        sign_with(
            &serde_json::json!({ "alg": "ES256", "kid": EC_KID, "typ": "JWT" }),
            claims,
        )
    }

    pub fn sign_rs256(claims: &serde_json::Value) -> String {
        sign_with(
            &serde_json::json!({ "alg": "RS256", "kid": RSA_KID, "typ": "JWT" }),
            claims,
        )
    }

    /// The claims of a Supabase access token for a signed-in user.
    pub fn claims(now: i64) -> serde_json::Value {
        serde_json::json!({
            "iss": ISSUER,
            "sub": USER_ID,
            "aud": "authenticated",
            "exp": now + 60,
            "iat": now - 10,
            "email": "maya@example.com",
            "phone": "",
            "role": "authenticated",
            "aal": "aal1",
            "amr": [{ "method": "otp", "timestamp": now - 10 }],
            "session_id": "0b3c1f4e-7d1a-4c2b-8e6f-5a4d3c2b1a09",
            "is_anonymous": false,
        })
    }
}

#[cfg(test)]
mod tests {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde_json::json;

    use super::{test_support::*, *};

    fn verifier() -> SupabaseVerifier {
        SupabaseVerifier::from_jwks(config(), &jwks()).unwrap()
    }

    #[tokio::test]
    async fn accepts_es256_and_rs256_access_tokens() {
        let expected = SupabaseSession {
            user_id: USER_ID.into(),
            session_id: Some("0b3c1f4e-7d1a-4c2b-8e6f-5a4d3c2b1a09".into()),
        };
        let now = unix_now();
        assert_eq!(
            verifier().verify(&sign(&claims(now))).await,
            Ok(expected.clone())
        );
        assert_eq!(
            verifier().verify(&sign_rs256(&claims(now))).await,
            Ok(expected.clone())
        );
        let mut listed = claims(now);
        listed["aud"] = json!(["authenticated", "other"]);
        assert_eq!(verifier().verify(&sign(&listed)).await, Ok(expected));
    }

    #[tokio::test]
    async fn rejects_tampered_expired_and_foreign_tokens() {
        let now = unix_now();
        let verifier = verifier();

        let token = sign(&claims(now));
        let (input, _) = token.rsplit_once('.').unwrap();
        let (header, _) = input.split_once('.').unwrap();
        let mut forged = claims(now);
        forged["sub"] = json!("00000000-0000-4000-8000-000000000000");
        let forged = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap());
        let tampered = format!("{header}.{forged}.{}", token.rsplit_once('.').unwrap().1);
        assert_eq!(
            verifier.verify(&tampered).await,
            Err(SupabaseAuthError::BadSignature)
        );

        let cases = [
            ("exp", json!(now - 60), SupabaseAuthError::Expired),
            ("nbf", json!(now + 120), SupabaseAuthError::NotYetValid),
            (
                "iss",
                json!("https://other.supabase.co/auth/v1"),
                SupabaseAuthError::WrongIssuer,
            ),
            ("aud", json!("anon"), SupabaseAuthError::WrongAudience),
            ("role", json!("service_role"), SupabaseAuthError::NotAUser),
            ("role", json!("anon"), SupabaseAuthError::NotAUser),
            ("is_anonymous", json!(true), SupabaseAuthError::NotAUser),
            ("sub", json!("not-a-uuid"), SupabaseAuthError::Malformed),
        ];
        for (claim, value, error) in cases {
            let mut changed = claims(now);
            changed[claim] = value;
            assert_eq!(
                verifier.verify(&sign(&changed)).await,
                Err(error),
                "{claim}"
            );
        }
        let mut no_role = claims(now);
        no_role.as_object_mut().unwrap().remove("role");
        assert_eq!(
            verifier.verify(&sign(&no_role)).await,
            Err(SupabaseAuthError::NotAUser)
        );

        let unknown = sign_with(&json!({ "alg": "ES256", "kid": "other" }), &claims(now));
        assert_eq!(
            verifier.verify(&unknown).await,
            Err(SupabaseAuthError::UnknownKey)
        );

        // HS256 (the legacy shared secret), `none` and anything else never verify.
        for alg in ["none", "HS256", "RS512", "ES384", "EdDSA"] {
            let token = sign_with(&json!({ "alg": alg, "kid": EC_KID }), &claims(now));
            assert_eq!(
                verifier.verify(&token).await,
                Err(SupabaseAuthError::UnsupportedAlgorithm),
                "{alg}"
            );
        }
        // A key is only good for its own algorithm.
        let confused = sign_with(&json!({ "alg": "RS256", "kid": EC_KID }), &claims(now));
        assert_eq!(
            verifier.verify(&confused).await,
            Err(SupabaseAuthError::UnsupportedAlgorithm)
        );
        let critical = sign_with(
            &json!({ "alg": "ES256", "kid": EC_KID, "crit": ["exp"] }),
            &claims(now),
        );
        assert_eq!(
            verifier.verify(&critical).await,
            Err(SupabaseAuthError::UnsupportedAlgorithm)
        );

        for malformed in [
            "",
            "a.b",
            "a.b.c.d",
            "!!.!!.!!",
            &"a".repeat(MAX_TOKEN_BYTES + 1),
        ] {
            assert_eq!(
                verifier.verify(malformed).await,
                Err(SupabaseAuthError::Malformed)
            );
        }
    }

    /// The remote path against a loopback JWKS server: fetched once, cached, and an
    /// unknown `kid` can't trigger another fetch inside the refresh interval.
    #[tokio::test]
    async fn fetches_jwks_once_and_rate_limits_unknown_keys() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let fetches = Arc::new(AtomicUsize::new(0));
        let counter = fetches.clone();
        let app = axum::Router::new().route(
            "/auth/v1/.well-known/jwks.json",
            axum::routing::get(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                async { jwks() }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let local = SupabaseAuthConfig::from_project_url(&format!("http://{address}")).unwrap();
        let verifier = SupabaseVerifier::new(local.clone()).unwrap();

        let now = unix_now();
        let mut local_claims = claims(now);
        local_claims["iss"] = json!(local.issuer);
        assert!(verifier.verify(&sign(&local_claims)).await.is_ok());
        assert!(verifier.verify(&sign_rs256(&local_claims)).await.is_ok());
        let unknown = sign_with(&json!({ "alg": "ES256", "kid": "rotated" }), &local_claims);
        assert_eq!(
            verifier.verify(&unknown).await,
            Err(SupabaseAuthError::UnknownKey)
        );
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        server.abort();

        // Nothing cached and nothing reachable: retryable on our side, not a 401.
        let offline = SupabaseVerifier::new(local).unwrap();
        let _ = server.await;
        assert_eq!(
            offline.verify(&sign(&local_claims)).await,
            Err(SupabaseAuthError::KeysUnavailable)
        );
    }

    #[test]
    fn jwks_keeps_only_rs256_and_es256_signing_keys() {
        assert_eq!(parse_jwks(&jwks()).unwrap().len(), 2);
        let others = json!({ "keys": [
            { "kty": "oct", "kid": "hs", "alg": "HS256", "k": "c2VjcmV0" },
            { "kty": "EC", "kid": "p384", "crv": "P-384", "x": "AA", "y": "AA" },
            { "kty": "EC", "kid": "short", "crv": "P-256", "x": "AA", "y": "AA" },
            { "kty": "OKP", "kid": "ed", "crv": "Ed25519", "x": "AA" },
            { "kty": "RSA", "kid": "enc", "use": "enc", "n": "AQAB", "e": "AQAB" },
            { "kty": "RSA", "kid": "ps", "alg": "PS256", "n": "AQAB", "e": "AQAB" },
        ]});
        assert_eq!(
            parse_jwks(&serde_json::to_vec(&others).unwrap()).err(),
            Some(SupabaseAuthError::Malformed)
        );
        assert_eq!(
            parse_jwks(b"not json").err(),
            Some(SupabaseAuthError::Malformed)
        );
    }

    #[test]
    fn derives_issuer_and_jwks_from_the_project_url() {
        assert_eq!(
            SupabaseAuthConfig::from_project_url("https://abc.supabase.co/").unwrap(),
            SupabaseAuthConfig {
                issuer: "https://abc.supabase.co/auth/v1".into(),
                jwks_url: "https://abc.supabase.co/auth/v1/.well-known/jwks.json".into(),
            }
        );
        assert!(config().validate().is_ok());
        assert!(SupabaseAuthConfig::from_project_url("http://127.0.0.1:54321").is_ok());
        for bad in [
            "http://abc.supabase.co",
            "https://abc.supabase.co/auth/v1",
            "https://user@abc.supabase.co",
            "https://abc.supabase.co?x=1",
            "abc.supabase.co",
        ] {
            assert!(SupabaseAuthConfig::from_project_url(bad).is_err(), "{bad}");
        }
        let tampered = SupabaseAuthConfig {
            jwks_url: "https://evil.example/auth/v1/.well-known/jwks.json".into(),
            ..config()
        };
        assert!(tampered.validate().is_err());
    }
}
