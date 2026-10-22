//! Server-issued SIWE challenges and opaque, short-lived EOA sessions.
//!
//! No client-supplied message/domain is verified, no private keys enter this module,
//! and an address alone never establishes ownership. Contract-wallet proofs require
//! a separate chain-aware verifier; the initial method is explicitly EOA-only.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{config::AuthConfig, error::AppError};

type RefreshFamilyRow = (
    Uuid,
    Uuid,
    Uuid,
    Uuid,
    OffsetDateTime,
    Option<OffsetDateTime>,
    bool,
);

pub const SIGN_IN_STATEMENT: &str =
    "Sign in to Honey Wallet. This does not authorize transactions.";
const LINK_WALLET_STATEMENT: &str =
    "Link this wallet to my Honey Wallet account. This does not authorize transactions.";
const MAX_LINKED_WALLETS: i64 = 64;

#[derive(Clone)]
pub struct Identity {
    pool: PgPool,
    policy: AuthConfig,
    redis: Option<crate::redis_store::RedisStore>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChallengeRequest {
    pub address: String,
    pub chain_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkWalletChallengeRequest {
    pub address: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[derive(Clone)]
pub struct LinkWalletRequest {
    pub challenge_id: Uuid,
    pub signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub id: Uuid,
    pub message: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyRequest {
    pub challenge_id: Uuid,
    pub signature: String,
    /// Random identifier paired with this refresh family; not hardware attestation.
    pub device_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshRequest {
    pub refresh_token: String,
    pub device_id: Uuid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletIdentity {
    pub id: Uuid,
    pub chain_id: String,
    pub address: String,
    pub account_kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub user_id: Uuid,
    /// Only the wallet proven for this session; not inferred multichain ownership.
    pub wallet: WalletIdentity,
}

// Deliberately no Debug: this response contains a bearer credential.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedSession {
    pub access_token: String,
    pub token_type: &'static str,
    pub expires_at: String,
    pub refresh_token: Option<String>,
    pub refresh_expires_at: Option<String>,
    pub device_id: Uuid,
    pub profile: Profile,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfiguration {
    pub enabled: bool,
    pub method: Option<&'static str>,
    pub origin: Option<String>,
    pub chain_id: Option<String>,
    pub session_ttl_seconds: u32,
}

impl Identity {
    pub fn configuration(
        identity: Option<&Self>,
        request_origin: Option<&str>,
    ) -> Result<AuthConfiguration, AppError> {
        if let (Some(identity), Some(origin)) = (identity, request_origin)
            && !identity.policy.allows_origin(origin)
        {
            return Err(AppError::Unauthorized);
        }
        Ok(AuthConfiguration {
            enabled: identity.is_some(),
            method: identity.map(|_| "siwe_eoa"),
            origin: identity.map(|i| request_origin.unwrap_or(&i.policy.origin).to_owned()),
            chain_id: identity.map(|i| format!("eip155:{}", i.policy.chain_id)),
            session_ttl_seconds: 900,
        })
    }
    /// Shared identity database pool, for small public write paths such as the waitlist.
    pub(crate) fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub fn new(pool: PgPool, policy: AuthConfig) -> Result<Self, crate::config::ConfigError> {
        policy.domain()?;
        Ok(Self {
            pool,
            policy,
            redis: None,
        })
    }

    /// Attach shared admission storage in the production router. Standalone
    /// identity fixtures retain the PostgreSQL limiter for deterministic tests.
    pub fn with_redis(mut self, redis: Option<crate::redis_store::RedisStore>) -> Self {
        self.redis = redis;
        self
    }

    pub async fn wallets(&self, token: &str) -> Result<Vec<WalletIdentity>, AppError> {
        validate_token(token)?;
        let user_id: Uuid = sqlx::query_scalar(
            "SELECT user_id FROM auth_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > clock_timestamp()",
        )
        .bind(digest(token.as_bytes()))
        .fetch_optional(&self.pool)
        .await
        .map_err(unavailable)?
        .ok_or(AppError::Unauthorized)?;
        self.rate_profile_read(user_id).await?;
        let rows: Vec<(Uuid, i64, Vec<u8>)> = sqlx::query_as(
            "SELECT id, chain_id, address FROM wallet_memberships WHERE user_id=$1 ORDER BY created_at, id LIMIT $2",
        )
        .bind(user_id)
        .bind(MAX_LINKED_WALLETS)
        .fetch_all(&self.pool)
        .await
        .map_err(unavailable)?;
        rows.into_iter()
            .map(|(id, chain, address)| {
                let wallet = profile(user_id, id, chain, &address)?.wallet;
                Ok(wallet)
            })
            .collect()
    }

    pub async fn link_wallet_challenge(
        &self,
        token: &str,
        input: LinkWalletChallengeRequest,
        request_origin: Option<&str>,
    ) -> Result<Challenge, AppError> {
        validate_token(token)?;
        let origin = match request_origin {
            Some(origin) if self.policy.allows_origin(origin) => origin,
            Some(_) => return Err(AppError::Unauthorized),
            None => &self.policy.origin,
        };
        let domain = self
            .policy
            .domain_for_origin(origin)
            .map_err(|_| AppError::Unauthorized)?;
        let address = parse_address(&input.address)?;
        let session_hash = digest(token.as_bytes());
        let user_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM auth_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > clock_timestamp()",
        )
        .bind(&session_hash)
        .fetch_optional(&self.pool)
        .await
        .map_err(unavailable)?;
        let user_id = user_id.ok_or(AppError::Unauthorized)?;
        self.rate_limit_scoped(
            "identity-link-wallet",
            &format!("{}:{}", user_id, hex::encode(address)),
            5,
        )
        .await?;
        let (now, expiry): (OffsetDateTime, OffsetDateTime) = sqlx::query_as(
            "SELECT statement_timestamp(), statement_timestamp() + interval '5 minutes'",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(unavailable)?;
        let id = Uuid::new_v4();
        let message = siwe::Message {
            domain: domain.parse().map_err(|_| AppError::Busy)?,
            address,
            statement: Some(LINK_WALLET_STATEMENT.to_owned()),
            uri: origin.parse().map_err(|_| AppError::Busy)?,
            version: siwe::Version::V1,
            chain_id: self.policy.chain_id as u64,
            nonce: Uuid::new_v4().simple().to_string(),
            issued_at: now.into(),
            expiration_time: Some(expiry.into()),
            not_before: None,
            request_id: Some(id.to_string()),
            resources: vec![],
        }
        .to_string();
        sqlx::query("INSERT INTO wallet_link_challenges(id,user_id,session_hash,message,expires_at) VALUES($1,$2,$3,$4,$5)")
            .bind(id).bind(user_id).bind(session_hash).bind(&message).bind(expiry)
            .execute(&self.pool).await.map_err(unavailable)?;
        Ok(Challenge {
            id,
            message,
            expires_at: timestamp(expiry)?,
        })
    }

    pub async fn link_wallet(
        &self,
        token: &str,
        input: LinkWalletRequest,
        request_origin: Option<&str>,
    ) -> Result<WalletIdentity, AppError> {
        validate_token(token)?;
        let signature = parse_signature(&input.signature)?;
        let message_text: Option<String> = sqlx::query_scalar(
            "SELECT c.message FROM wallet_link_challenges c JOIN auth_sessions s ON s.token_hash=c.session_hash AND s.user_id=c.user_id WHERE c.id=$1 AND c.session_hash=$2 AND c.consumed_at IS NULL AND c.expires_at > clock_timestamp() AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()",
        )
        .bind(input.challenge_id)
        .bind(digest(token.as_bytes()))
        .fetch_optional(&self.pool)
        .await
        .map_err(unavailable)?;
        let message: siwe::Message = message_text
            .ok_or(AppError::Unauthorized)?
            .parse()
            .map_err(|_| AppError::Unauthorized)?;
        let origin = request_origin.unwrap_or(&self.policy.origin);
        let domain = self
            .policy
            .domain_for_origin(origin)
            .map_err(|_| AppError::Unauthorized)?;
        if !self.policy.allows_origin(origin)
            || message.uri.as_str() != origin
            || message.domain.as_str() != domain
            || message.statement.as_deref() != Some(LINK_WALLET_STATEMENT)
            || message.chain_id != self.policy.chain_id as u64
            || message.request_id.as_deref() != Some(input.challenge_id.to_string().as_str())
        {
            return Err(AppError::Unauthorized);
        }
        message
            .verify_eip191(&signature)
            .map_err(|_| AppError::Unauthorized)?;
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let live_session: Option<Uuid> = sqlx::query_scalar(
            "SELECT s.user_id FROM auth_sessions s JOIN wallet_link_challenges c ON c.session_hash=s.token_hash AND c.user_id=s.user_id WHERE c.id=$1 AND c.session_hash=$2 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() FOR UPDATE OF s",
        )
        .bind(input.challenge_id)
        .bind(digest(token.as_bytes()))
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if live_session.is_none() {
            return Err(AppError::Unauthorized);
        }
        let user_id: Option<Uuid> = sqlx::query_scalar(
            "UPDATE wallet_link_challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND session_hash=$2 AND consumed_at IS NULL AND expires_at > clock_timestamp() RETURNING user_id",
        )
        .bind(input.challenge_id)
        .bind(digest(token.as_bytes()))
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        let user_id = user_id.ok_or(AppError::Unauthorized)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))")
            .bind(user_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        let lock_key = format!("{}:{}", self.policy.chain_id, hex::encode(message.address));
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(lock_key)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        let existing: Option<(Uuid, Uuid)> = sqlx::query_as(
            "SELECT user_id,id FROM wallet_memberships WHERE chain_id=$1 AND address=$2",
        )
        .bind(self.policy.chain_id)
        .bind(message.address.as_slice())
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        let newly_linked = existing.is_none();
        let wallet_id = match existing {
            Some((owner, id)) if owner == user_id => id,
            Some(_) => {
                tx.commit().await.map_err(unavailable)?;
                return Err(AppError::Conflict(
                    "wallet already belongs to another account".into(),
                ));
            }
            None => {
                let count: i64 =
                    sqlx::query_scalar("SELECT count(*) FROM wallet_memberships WHERE user_id=$1")
                        .bind(user_id)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(unavailable)?;
                if count >= MAX_LINKED_WALLETS {
                    tx.commit().await.map_err(unavailable)?;
                    return Err(AppError::Conflict("wallet limit reached".into()));
                }
                let id = Uuid::new_v4();
                sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES($1,$2,$3,$4,'eoa')")
                    .bind(id).bind(user_id).bind(self.policy.chain_id).bind(message.address.as_slice())
                    .execute(&mut *tx).await.map_err(unavailable)?;
                id
            }
        };
        if newly_linked {
            sqlx::query(
                "INSERT INTO identity_events(id,user_id,kind) VALUES($1,$2,'wallet_linked')",
            )
            .bind(Uuid::new_v4())
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(profile(user_id, wallet_id, self.policy.chain_id, &message.address)?.wallet)
    }

    /// PostgreSQL compatibility limiter for isolated tests and local fixtures. Public
    /// runtime auth quotas use Redis-backed methods below when configured.
    #[tracing::instrument(name = "identity.rate_limit", skip_all)]
    pub async fn rate_limit(&self, subject: &str, limit: i32) -> Result<(), AppError> {
        let accepted: Option<i32> = sqlx::query_scalar(
            "INSERT INTO auth_rate_limits(subject_hash, window_start, attempts)
             VALUES ($1, date_trunc('minute', clock_timestamp()), 1)
             ON CONFLICT(subject_hash, window_start) DO UPDATE
             SET attempts = auth_rate_limits.attempts + 1
             WHERE auth_rate_limits.attempts < $2 RETURNING attempts",
        )
        .bind(digest(subject.as_bytes()))
        .bind(limit)
        .fetch_optional(&self.pool)
        .await
        .map_err(unavailable)?;
        accepted.map(|_| ()).ok_or(AppError::TooManyRequests)
    }

    /// Applies one fixed-minute subject quota. Runtime identities use Redis with
    /// expiring keys; standalone identity fixtures retain the PostgreSQL fallback.
    pub async fn rate_limit_scoped(
        &self,
        domain: &'static str,
        subject: &str,
        limit: i32,
    ) -> Result<(), AppError> {
        if let Some(redis) = &self.redis {
            return redis.rate_limit_subject(domain, subject, limit).await;
        }
        self.rate_limit(&format!("{domain}:{subject}"), limit).await
    }

    /// Applies the global and subject limits as one admission decision. Redis
    /// executes the pair atomically; the disposable-fixture PostgreSQL fallback
    /// rolls the global increment back when the subject limit is exhausted.
    pub async fn rate_limit_pair(
        &self,
        domain: &'static str,
        subject: &str,
        global_limit: i32,
        subject_limit: i32,
    ) -> Result<(), AppError> {
        if global_limit <= 0 || subject_limit <= 0 {
            return Err(AppError::BadRequest("invalid quota configuration".into()));
        }
        if let Some(redis) = &self.redis {
            return redis
                .rate_limit_pair(domain, subject, global_limit, subject_limit)
                .await;
        }

        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let window: OffsetDateTime =
            sqlx::query_scalar("SELECT date_trunc('minute', clock_timestamp())")
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
        for (key, limit) in [
            (format!("{domain}:global"), global_limit),
            (format!("{domain}:{subject}"), subject_limit),
        ] {
            let accepted: Option<i32> = sqlx::query_scalar(
                "INSERT INTO auth_rate_limits(subject_hash, window_start, attempts)
                 VALUES ($1, $2, 1)
                 ON CONFLICT(subject_hash, window_start) DO UPDATE
                 SET attempts = auth_rate_limits.attempts + 1
                 WHERE auth_rate_limits.attempts < $3 RETURNING attempts",
            )
            .bind(digest(key.as_bytes()))
            .bind(window)
            .bind(limit)
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?;
            if accepted.is_none() {
                tx.rollback().await.map_err(unavailable)?;
                return Err(AppError::TooManyRequests);
            }
        }
        tx.commit().await.map_err(unavailable)
    }

    /// Provider quote admission is high-volume shared coordination, not identity
    /// state. Use Redis when configured so each quote does not serialize two SQL
    /// writes through the identity database. PostgreSQL remains a compatibility
    /// fallback for isolated route fixtures; configured provider services require
    /// Redis in production infrastructure construction.
    pub async fn rate_limit_shared(
        &self,
        domain: &'static str,
        subject: &str,
        global_limit: i32,
        subject_limit: i32,
    ) -> Result<(), AppError> {
        if let Some(redis) = &self.redis {
            return redis
                .rate_limit_pair(domain, subject, global_limit, subject_limit)
                .await;
        }
        self.rate_limit_pair(domain, subject, global_limit, subject_limit)
            .await
    }

    #[tracing::instrument(name = "identity.challenge", skip_all)]
    pub async fn challenge(&self, input: ChallengeRequest) -> Result<Challenge, AppError> {
        self.challenge_for_origin(input, None).await
    }

    pub async fn challenge_for_origin(
        &self,
        input: ChallengeRequest,
        request_origin: Option<&str>,
    ) -> Result<Challenge, AppError> {
        if input.chain_id != format!("eip155:{}", self.policy.chain_id) {
            return Err(AppError::Unsupported(
                "authentication chain not enabled".into(),
            ));
        }
        let origin = match request_origin {
            Some(origin) if self.policy.allows_origin(origin) => origin,
            Some(_) => return Err(AppError::Unauthorized),
            None => &self.policy.origin,
        };
        let domain = self
            .policy
            .domain_for_origin(origin)
            .map_err(|_| AppError::Unauthorized)?;
        let address = parse_address(&input.address)?;
        // The public route applies peer/global proof admission. An unproven address
        // must never be a hard quota subject: anyone could exhaust another owner's
        // allowance before that owner has had a chance to prove possession.
        let (now, expiry): (OffsetDateTime, OffsetDateTime) = sqlx::query_as(
            "SELECT statement_timestamp(), statement_timestamp() + interval '5 minutes'",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(unavailable)?;
        let id = Uuid::new_v4();
        let message = siwe::Message {
            domain: domain.parse().map_err(|_| AppError::Busy)?,
            address,
            statement: Some(SIGN_IN_STATEMENT.to_owned()),
            uri: origin.parse().map_err(|_| AppError::Busy)?,
            version: siwe::Version::V1,
            chain_id: self.policy.chain_id as u64,
            nonce: Uuid::new_v4().simple().to_string(),
            issued_at: now.into(),
            expiration_time: Some(expiry.into()),
            not_before: None,
            request_id: Some(id.to_string()),
            resources: vec![],
        }
        .to_string();
        sqlx::query("INSERT INTO auth_challenges(id, message, expires_at) VALUES ($1, $2, $3)")
            .bind(id)
            .bind(&message)
            .bind(expiry)
            .execute(&self.pool)
            .await
            .map_err(unavailable)?;
        Ok(Challenge {
            id,
            message,
            expires_at: timestamp(expiry)?,
        })
    }

    #[tracing::instrument(name = "identity.verify", skip_all)]
    pub async fn verify(
        &self,
        input: VerifyRequest,
        allow_refresh: bool,
    ) -> Result<AuthenticatedSession, AppError> {
        self.verify_for_origin(input, allow_refresh, None).await
    }

    pub async fn verify_for_origin(
        &self,
        input: VerifyRequest,
        allow_refresh: bool,
        request_origin: Option<&str>,
    ) -> Result<AuthenticatedSession, AppError> {
        // Reject oversized/alternate encodings before crypto or database work.
        let signature = parse_signature(&input.signature)?;
        let stored: Option<String> = sqlx::query_scalar(
            "SELECT message FROM auth_challenges WHERE id = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()",
        ).bind(input.challenge_id).fetch_optional(&self.pool).await.map_err(unavailable)?;
        let message: siwe::Message = stored
            .ok_or(AppError::Unauthorized)?
            .parse()
            .map_err(|_| AppError::Unauthorized)?;
        let message_origin = message.uri.as_str();
        let expected_domain = self
            .policy
            .domain_for_origin(message_origin)
            .map_err(|_| AppError::Unauthorized)?;
        let expected_origin = request_origin.unwrap_or(&self.policy.origin);
        if message_origin != expected_origin
            || message.domain.as_str() != expected_domain
            || message.chain_id != self.policy.chain_id as u64
            || message.request_id.as_deref() != Some(input.challenge_id.to_string().as_str())
        {
            return Err(AppError::Unauthorized);
        }
        // Pure EIP-191 verification has no network calls and never invokes 1271/6492.
        message
            .verify_eip191(&signature)
            .map_err(|_| AppError::Unauthorized)?;

        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let consumed = sqlx::query(
            "UPDATE auth_challenges SET consumed_at = clock_timestamp()
             WHERE id = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()",
        )
        .bind(input.challenge_id)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?
        .rows_affected();
        if consumed != 1 {
            return Err(AppError::Unauthorized);
        }

        // Serialize creation for this exact chain/address. Hash collisions only
        // serialize unrelated sign-ins, never change the unique ownership constraint.
        let key = format!("{}:{}", self.policy.chain_id, hex::encode(message.address));
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(key)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        let existing: Option<(Uuid, Uuid)> = sqlx::query_as(
            "SELECT user_id, id FROM wallet_memberships WHERE chain_id = $1 AND address = $2",
        )
        .bind(self.policy.chain_id)
        .bind(message.address.as_slice())
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        let (user_id, wallet_id) = match existing {
            Some(identity) => identity,
            None => {
                let user_id = Uuid::new_v4();
                let wallet_id = Uuid::new_v4();
                sqlx::query("INSERT INTO users(id) VALUES ($1)")
                    .bind(user_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(unavailable)?;
                sqlx::query("INSERT INTO wallet_memberships(id, user_id, chain_id, address, account_kind) VALUES ($1, $2, $3, $4, 'eoa')")
                    .bind(wallet_id).bind(user_id).bind(self.policy.chain_id).bind(message.address.as_slice())
                    .execute(&mut *tx).await.map_err(unavailable)?;
                (user_id, wallet_id)
            }
        };
        let refresh = if allow_refresh {
            let family_id = Uuid::new_v4();
            let refresh_token = new_token();
            let refresh_expires: OffsetDateTime = sqlx::query_scalar(
                "INSERT INTO auth_refresh_families(id, user_id, wallet_id, device_id, expires_at)
                 VALUES ($1, $2, $3, $4, clock_timestamp() + interval '30 days') RETURNING expires_at",
            )
            .bind(family_id)
            .bind(user_id)
            .bind(wallet_id)
            .bind(input.device_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
            sqlx::query("INSERT INTO auth_refresh_tokens(token_hash, family_id) VALUES ($1, $2)")
                .bind(digest(refresh_token.as_bytes()))
                .bind(family_id)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
            Some((family_id, refresh_token, timestamp(refresh_expires)?))
        } else {
            None
        };
        let (refresh_family_id, refresh_token, refresh_expires_at) = match refresh {
            Some((family_id, token, expires)) => (Some(family_id), Some(token), Some(expires)),
            None => (None, None, None),
        };
        // Two independent UUID v4s provide 244 random bits from the platform CSPRNG.
        let token = new_token();
        let expires: OffsetDateTime = sqlx::query_scalar(
            "INSERT INTO auth_sessions(token_hash, user_id, wallet_id, refresh_family_id, expires_at)
             VALUES ($1, $2, $3, $4, clock_timestamp() + interval '15 minutes') RETURNING expires_at",
        )
        .bind(digest(token.as_bytes()))
        .bind(user_id)
        .bind(wallet_id)
        .bind(refresh_family_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        sqlx::query("INSERT INTO identity_events(id, user_id, kind) VALUES ($1, $2, 'signed_in')")
            .bind(Uuid::new_v4())
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(AuthenticatedSession {
            access_token: token,
            token_type: "Bearer",
            expires_at: timestamp(expires)?,
            refresh_token,
            refresh_expires_at,
            device_id: input.device_id,
            profile: profile(user_id, wallet_id, self.policy.chain_id, &message.address)?,
        })
    }

    /// Atomic token-family rotation. Reuse of any already-spent credential revokes
    /// both the family and every access token minted from it.
    #[tracing::instrument(name = "identity.refresh", skip_all)]
    pub async fn refresh(&self, input: RefreshRequest) -> Result<AuthenticatedSession, AppError> {
        validate_token(&input.refresh_token)?;
        let old_hash = digest(input.refresh_token.as_bytes());
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let family: Option<RefreshFamilyRow> = sqlx::query_as(
            "SELECT f.id, f.user_id, f.wallet_id, f.device_id, f.expires_at, f.revoked_at,
                        f.expires_at > clock_timestamp()
                 FROM auth_refresh_tokens t JOIN auth_refresh_families f ON f.id=t.family_id
                 WHERE t.token_hash=$1 FOR UPDATE OF f",
        )
        .bind(&old_hash)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        let Some((family_id, user_id, wallet_id, device_id, family_expiry, revoked_at, active)) =
            family
        else {
            return Err(AppError::Unauthorized);
        };
        if device_id != input.device_id || revoked_at.is_some() || !active {
            return Err(AppError::Unauthorized);
        }
        let used: Option<OffsetDateTime> = sqlx::query_scalar(
            "UPDATE auth_refresh_tokens SET used_at=clock_timestamp()
             WHERE token_hash=$1 AND family_id=$2 AND used_at IS NULL
             RETURNING used_at",
        )
        .bind(&old_hash)
        .bind(family_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if used.is_none() {
            sqlx::query("UPDATE auth_refresh_families SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL")
                .bind(family_id).execute(&mut *tx).await.map_err(unavailable)?;
            sqlx::query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE refresh_family_id=$1 AND revoked_at IS NULL")
                .bind(family_id).execute(&mut *tx).await.map_err(unavailable)?;
            tx.commit().await.map_err(unavailable)?;
            return Err(AppError::Unauthorized);
        }
        let refresh_token = new_token();
        sqlx::query("INSERT INTO auth_refresh_tokens(token_hash, family_id) VALUES ($1,$2)")
            .bind(digest(refresh_token.as_bytes()))
            .bind(family_id)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        sqlx::query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE refresh_family_id=$1 AND revoked_at IS NULL")
            .bind(family_id).execute(&mut *tx).await.map_err(unavailable)?;
        let access_token = new_token();
        let expires: OffsetDateTime = sqlx::query_scalar(
            "INSERT INTO auth_sessions(token_hash,user_id,wallet_id,refresh_family_id,expires_at)
             VALUES ($1,$2,$3,$4,clock_timestamp()+interval '15 minutes') RETURNING expires_at",
        )
        .bind(digest(access_token.as_bytes()))
        .bind(user_id)
        .bind(wallet_id)
        .bind(family_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        let (chain, address): (i64, Vec<u8>) = sqlx::query_as(
            "SELECT chain_id,address FROM wallet_memberships WHERE id=$1 AND user_id=$2",
        )
        .bind(wallet_id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(AuthenticatedSession {
            access_token,
            token_type: "Bearer",
            expires_at: timestamp(expires)?,
            refresh_token: Some(refresh_token),
            refresh_expires_at: Some(timestamp(family_expiry)?),
            device_id,
            profile: profile(user_id, wallet_id, chain, &address)?,
        })
    }

    #[tracing::instrument(name = "identity.authenticate", skip_all)]
    pub async fn authenticate(&self, token: &str) -> Result<Profile, AppError> {
        validate_token(token)?;
        let row: Option<(Uuid, Uuid, i64, Vec<u8>)> = sqlx::query_as(
            "SELECT s.user_id, w.id, w.chain_id, w.address FROM auth_sessions s
             JOIN wallet_memberships w ON w.id = s.wallet_id AND w.user_id = s.user_id
             WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()",
        )
        .bind(digest(token.as_bytes()))
        .fetch_optional(&self.pool)
        .await
        .map_err(unavailable)?;
        let (user, wallet, chain, address) = row.ok_or(AppError::Unauthorized)?;
        profile(user, wallet, chain, &address)
    }

    pub async fn rate_profile_read(&self, user_id: Uuid) -> Result<(), AppError> {
        self.rate_limit_scoped("identity-profile-user", &user_id.to_string(), 600)
            .await
    }

    #[tracing::instrument(name = "identity.logout", skip_all)]
    pub async fn logout(&self, token: &str) -> Result<(), AppError> {
        validate_token(token)?;
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let user: Option<Uuid> = sqlx::query_scalar(
            "UPDATE auth_sessions SET revoked_at = clock_timestamp()
             WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id",
        )
        .bind(digest(token.as_bytes()))
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if let Some(user) = user {
            sqlx::query("UPDATE auth_refresh_families SET revoked_at=clock_timestamp() WHERE id=(SELECT refresh_family_id FROM auth_sessions WHERE token_hash=$1) AND revoked_at IS NULL")
                .bind(digest(token.as_bytes())).execute(&mut *tx).await.map_err(unavailable)?;
            sqlx::query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE refresh_family_id=(SELECT refresh_family_id FROM auth_sessions WHERE token_hash=$1) AND revoked_at IS NULL")
                .bind(digest(token.as_bytes())).execute(&mut *tx).await.map_err(unavailable)?;
            sqlx::query(
                "INSERT INTO identity_events(id, user_id, kind) VALUES ($1, $2, 'signed_out')",
            )
            .bind(Uuid::new_v4())
            .bind(user)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(())
    }
}

fn new_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn parse_signature(value: &str) -> Result<[u8; 65], AppError> {
    let signature: [u8; 65] = value
        .strip_prefix("0x")
        .filter(|s| s.len() == 130)
        .and_then(|s| hex::decode(s).ok())
        .and_then(|s| s.try_into().ok())
        .ok_or(AppError::Unauthorized)?;
    if !matches!(signature[64], 0 | 1 | 27 | 28) {
        return Err(AppError::Unauthorized);
    }
    Ok(signature)
}

fn profile(user_id: Uuid, id: Uuid, chain: i64, bytes: &[u8]) -> Result<Profile, AppError> {
    let address: [u8; 20] = bytes.try_into().map_err(|_| AppError::Busy)?;
    Ok(Profile {
        user_id,
        wallet: WalletIdentity {
            id,
            chain_id: format!("eip155:{chain}"),
            address: siwe::eip55(&address),
            account_kind: "eoa",
        },
    })
}

fn validate_token(token: &str) -> Result<(), AppError> {
    if token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

fn parse_address(value: &str) -> Result<[u8; 20], AppError> {
    value
        .strip_prefix("0x")
        .filter(|s| s.len() == 40)
        .and_then(|s| hex::decode(s).ok())
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| AppError::BadRequest("invalid EVM address".into()))
}

pub(crate) fn digest(value: &[u8]) -> Vec<u8> {
    Sha256::digest(value).to_vec()
}

fn timestamp(value: OffsetDateTime) -> Result<String, AppError> {
    value.format(&Rfc3339).map_err(|_| AppError::Busy)
}

pub(crate) fn unavailable(error: sqlx::Error) -> AppError {
    // No driver error text: it may include parameters, credentials or signed data.
    let category = match &error {
        sqlx::Error::PoolTimedOut => "pool_timeout",
        sqlx::Error::PoolClosed => "pool_closed",
        sqlx::Error::Database(_) => "database",
        sqlx::Error::Io(_) | sqlx::Error::Tls(_) => "transport",
        _ => "query_contract",
    };
    // PostgreSQL SQLSTATE is a bounded machine code, never an arbitrary error chain.
    let code = error.as_database_error().and_then(|e| e.code());
    let code = code
        .as_deref()
        .filter(|s| {
            s.len() == 5
                && s.bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        })
        .unwrap_or("none");
    tracing::warn!(
        error_code = "database_unavailable",
        category,
        sqlstate = code,
        "database operation failed"
    );
    AppError::Busy
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn unproven_challenge_addresses_never_consume_shared_subject_quotas() {
        use super::*;
        use std::{io::ErrorKind, time::Duration};

        // A closed pool stops at issuance without a database service. An occupied
        // Redis socket witnesses any pre-auth quota access without running Redis.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://test:test@127.0.0.1:1/test")
            .unwrap();
        pool.close().await;
        let identity = Identity::new(
            pool,
            AuthConfig {
                origin: "http://localhost:5173".into(),
                additional_origins: vec![],
                chain_id: 1,
            },
        )
        .unwrap()
        .with_redis(Some(crate::redis_store::RedisStore::new(
            redis::Client::open(format!("redis://{}", listener.local_addr().unwrap())).unwrap(),
            "challenge-quota-regression".into(),
            Duration::from_millis(50),
        )));
        for n in 0..6 {
            let address = if n % 2 == 0 {
                "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
            } else {
                "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
            };
            assert!(matches!(
                identity
                    .challenge(ChallengeRequest {
                        address: address.into(),
                        chain_id: "eip155:1".into(),
                    })
                    .await,
                Err(AppError::Busy)
            ));
        }
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            ErrorKind::WouldBlock,
            "an unproven victim address must not consume Redis quota"
        );
        // Positive control: the same transport does witness real quota access.
        assert!(
            identity
                .rate_limit_scoped("control", "subject", 5)
                .await
                .is_err()
        );
        assert!(listener.accept().is_ok());
    }

    #[test]
    fn siwe_parser_accepts_the_exact_chrome_extension_origin() {
        let id = "abcdefghijklmnopabcdefghijklmnop";
        let raw = format!(
            "{id} wants you to sign in with your Ethereum account:\n\
             0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf\n\n\
             Sign in to Honey Wallet. This does not authorize transactions.\n\n\
             URI: chrome-extension://{id}\nVersion: 1\nChain ID: 1\n\
             Nonce: 00000000000040008000000000000001\n\
             Issued At: 2026-10-18T12:00:00Z\n\
             Expiration Time: 2026-10-18T12:05:00Z\n\
             Request ID: 00000000-0000-4000-8000-000000000001"
        );
        let message: siwe::Message = raw.parse().expect("valid extension SIWE message");
        assert_eq!(message.domain.to_string(), id);
        assert_eq!(message.uri.to_string(), format!("chrome-extension://{id}"));
        assert_eq!(message.to_string(), raw);
    }

    #[test]
    fn verifies_an_independent_noble_personal_sign_fixture() {
        // Generated with the existing JS keyring's noble 2.4.0 dependencies and
        // public test key 1. This pins UTF-8 prefix length, Keccak and r/s/v layout.
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/siwe-noble.json")).unwrap();
        let message: siwe::Message = fixture["message"].as_str().unwrap().parse().unwrap();
        assert_eq!(
            hex::encode(message.eip191_hash().unwrap()),
            fixture["hash"].as_str().unwrap()
        );
        let signature: [u8; 65] = hex::decode(fixture["signature"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert!(message.verify_eip191(&signature).is_ok());
        let mut altered = message.clone();
        altered.statement = Some("Authorize a transfer".into());
        assert!(altered.verify_eip191(&signature).is_err());
    }
}
