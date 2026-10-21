//! Bounded shared Redis transport. Errors never include URLs, commands or values.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use redis::{
    FromRedisValue,
    aio::{ConnectionManager, ConnectionManagerConfig},
};
use sha2::{Digest, Sha256};
use tokio::sync::{OnceCell, Semaphore};

use crate::error::AppError;

const DUAL_QUOTA: &str = include_str!("scripts/dual_quota.lua");
const SINGLE_QUOTA: &str = include_str!("scripts/single_quota.lua");

#[derive(Clone)]
pub struct RedisStore {
    inner: Arc<Inner>,
}

struct Inner {
    client: redis::Client,
    connection: OnceCell<ConnectionManager>,
    permits: Semaphore,
    timeout: Duration,
    namespace: String,
    metrics: Arc<crate::metrics::Metrics>,
}

impl RedisStore {
    pub fn new(client: redis::Client, namespace: String, timeout: Duration) -> Self {
        Self::with_metrics(
            client,
            namespace,
            timeout,
            Arc::new(crate::metrics::Metrics::default()),
        )
    }

    pub fn with_metrics(
        client: redis::Client,
        namespace: String,
        timeout: Duration,
        metrics: Arc<crate::metrics::Metrics>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                client,
                metrics,
                connection: OnceCell::new(),
                permits: Semaphore::new(128),
                timeout,
                namespace,
            }),
        }
    }

    /// Hash-tagged keys share a slot for atomic scripts. Bounded namespaces are
    /// operator configuration; callers use fixed domains, never user-supplied keys.
    pub fn key(&self, domain: &str, suffix: &str) -> String {
        format!("{}:{{{domain}}}:{suffix}", self.inner.namespace)
    }

    /// Atomically applies a shared per-domain and per-subject fixed-window quota.
    /// The subject is hashed before it is used in a Redis key; callers must pass a
    /// bounded, code-defined domain (lowercase ASCII, digits, `_` or `-`).
    /// A denial consumes neither counter. Redis failures fail closed as `Busy`.
    pub async fn rate_limit_pair(
        &self,
        domain: &'static str,
        subject: &str,
        global_limit: i32,
        subject_limit: i32,
    ) -> Result<(), AppError> {
        if !valid_quota_domain(domain)
            || !valid_quota_subject(subject)
            || global_limit <= 0
            || subject_limit <= 0
        {
            return Err(AppError::BadRequest("invalid quota configuration".into()));
        }
        let digest = hex::encode(Sha256::digest(subject.as_bytes()));
        let global_key = self.key(domain, "quota:global");
        let subject_key = self.key(domain, &format!("quota:subject:{digest}"));
        let result: i64 = self
            .query(
                redis::cmd("EVAL")
                    .arg(DUAL_QUOTA)
                    .arg(2)
                    .arg(global_key)
                    .arg(subject_key)
                    .arg(global_limit)
                    .arg(subject_limit),
            )
            .await?;
        match result {
            1 => Ok(()),
            0 => Err(AppError::TooManyRequests),
            _ => Err(AppError::Busy),
        }
    }

    /// Atomically limits one pseudonymous subject in a Redis-time minute window.
    /// The hash key expires at the end of that window, so subject churn does not
    /// leave persistent per-client limiter rows behind.
    pub async fn rate_limit_subject(
        &self,
        domain: &'static str,
        subject: &str,
        limit: i32,
    ) -> Result<(), AppError> {
        if !valid_quota_domain(domain) || !valid_quota_subject(subject) || limit <= 0 {
            return Err(AppError::BadRequest("invalid quota configuration".into()));
        }
        let digest = hex::encode(Sha256::digest(subject.as_bytes()));
        let key = self.key(domain, &format!("quota:subject:{digest}"));
        let result: i64 = self
            .query(
                redis::cmd("EVAL")
                    .arg(SINGLE_QUOTA)
                    .arg(1)
                    .arg(key)
                    .arg(limit),
            )
            .await?;
        match result {
            1 => Ok(()),
            0 => Err(AppError::TooManyRequests),
            _ => Err(AppError::Busy),
        }
    }

    #[tracing::instrument(name = "redis.command", skip_all)]
    pub async fn query<T: FromRedisValue + Send>(
        &self,
        command: &mut redis::Cmd,
    ) -> Result<T, AppError> {
        use crate::metrics::RedisOutcome;
        let started = Instant::now();
        let Ok(_permit) = self.inner.permits.try_acquire() else {
            self.inner
                .metrics
                .redis(RedisOutcome::Busy, started.elapsed().as_secs_f64());
            return Err(AppError::Busy);
        };
        let result = tokio::time::timeout(self.inner.timeout, async {
            let connection = self
                .inner
                .connection
                .get_or_try_init(|| async {
                    let config = ConnectionManagerConfig::new()
                        .set_connection_timeout(self.inner.timeout)
                        .set_response_timeout(self.inner.timeout)
                        .set_number_of_retries(0);
                    ConnectionManager::new_with_config(self.inner.client.clone(), config).await
                })
                .await?;
            command.query_async(&mut connection.clone()).await
        })
        .await;
        match result {
            Ok(Ok(value)) => {
                self.inner
                    .metrics
                    .redis(RedisOutcome::Ok, started.elapsed().as_secs_f64());
                Ok(value)
            }
            Err(_) => {
                self.inner
                    .metrics
                    .redis(RedisOutcome::Timeout, started.elapsed().as_secs_f64());
                Err(AppError::Busy)
            }
            Ok(Err(_)) => {
                self.inner
                    .metrics
                    .redis(RedisOutcome::Unavailable, started.elapsed().as_secs_f64());
                Err(AppError::Busy)
            }
        }
    }

    pub async fn ping(&self) -> Result<(), AppError> {
        let pong: String = self.query(&mut redis::cmd("PING")).await?;
        if pong == "PONG" {
            Ok(())
        } else {
            Err(AppError::Busy)
        }
    }
}

fn valid_quota_domain(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= 32
        && domain.as_bytes()[0].is_ascii_lowercase()
        && domain
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte))
}

fn valid_quota_subject(subject: &str) -> bool {
    !subject.is_empty() && subject.len() <= 128
}

#[cfg(test)]
mod tests {
    use super::{valid_quota_domain, valid_quota_subject};

    #[test]
    fn quota_domains_are_bounded_and_safe_for_hash_tags() {
        assert!(valid_quota_domain("provider_quotes"));
        assert!(valid_quota_domain("v1-aave"));
        for domain in [
            "aave_mutation",
            "aave_read",
            "morpho_mutation",
            "morpho_read",
            "swap_exec_mutation",
            "swap_exec_read",
            "bridge_read",
            "hyperliquid_read",
            "swap_quote",
            "morpho_quote",
            "relay_quote",
            "operation_read",
            "operation_list",
        ] {
            assert!(valid_quota_domain(domain), "invalid quota domain: {domain}");
        }
        assert!(!valid_quota_domain(""));
        assert!(!valid_quota_domain("Upper"));
        assert!(!valid_quota_domain("{untrusted}"));
        assert!(!valid_quota_domain("a".repeat(33).as_str()));
        assert!(valid_quota_subject("wallet-uuid"));
        assert!(!valid_quota_subject(""));
        assert!(!valid_quota_subject("s".repeat(129).as_str()));
    }
}
