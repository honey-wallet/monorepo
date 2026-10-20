//! Dependency lifecycle and cheap, cached readiness. No migrations run at startup.

use std::{
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use sqlx::{ConnectOptions, PgPool};
use sqlx_postgres::{PgConnectOptions, PgPoolOptions};
use tokio::{task::JoinHandle, time::timeout};

use crate::Config;

const PROBE_INTERVAL: Duration = Duration::from_secs(5);
const QUEUE_METRICS_INTERVAL: Duration = Duration::from_secs(30);
const AUTH_CLEANUP_INTERVAL: Duration = Duration::from_secs(60);
const AUTH_CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROBE_AGE: Duration = Duration::from_secs(30);
// Authenticated endpoints require the complete embedded schema.
const REQUIRED_SCHEMA_VERSION: i64 = crate::database::LATEST_SCHEMA_VERSION;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyStatus {
    NotConfigured,
    Pending,
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Dependencies {
    pub postgres: DependencyStatus,
    pub redis: DependencyStatus,
}

struct Snapshot {
    dependencies: Dependencies,
    checked_at: Option<Instant>,
}

#[derive(Clone)]
pub struct RuntimeHealth {
    snapshot: Arc<RwLock<Snapshot>>,
    draining: Arc<AtomicBool>,
    required: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessStatus {
    Ready,
    NotReady,
}

/// Mirrored in packages/api-client. Contains no connection strings or error details.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub status: ReadinessStatus,
    pub dependencies: Dependencies,
    pub draining: bool,
    pub checks_fresh: bool,
}

impl RuntimeHealth {
    pub fn new(config: &Config) -> Self {
        let initial = |configured| {
            if configured {
                DependencyStatus::Pending
            } else {
                DependencyStatus::NotConfigured
            }
        };
        Self {
            snapshot: Arc::new(RwLock::new(Snapshot {
                dependencies: Dependencies {
                    postgres: initial(config.database_url.is_some()),
                    redis: initial(config.redis_url.is_some()),
                },
                checked_at: None,
            })),
            draining: Arc::new(AtomicBool::new(false)),
            required: config.require_infrastructure,
        }
    }

    pub fn begin_drain(&self) {
        self.draining.store(true, Ordering::Release);
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::Acquire)
    }

    pub fn readiness(&self) -> Readiness {
        let snapshot = self.snapshot.read().unwrap_or_else(|p| p.into_inner());
        let dependencies = snapshot.dependencies;
        let configured = [dependencies.postgres, dependencies.redis]
            .iter()
            .any(|s| *s != DependencyStatus::NotConfigured);
        let checks_fresh = !configured
            || snapshot
                .checked_at
                .is_some_and(|at| at.elapsed() <= MAX_PROBE_AGE);
        let usable = |s| {
            s == DependencyStatus::Up || (!self.required && s == DependencyStatus::NotConfigured)
        };
        let draining = self.is_draining();
        let ready = !draining
            && checks_fresh
            && usable(dependencies.postgres)
            && usable(dependencies.redis);
        Readiness {
            status: if ready {
                ReadinessStatus::Ready
            } else {
                ReadinessStatus::NotReady
            },
            dependencies,
            draining,
            checks_fresh,
        }
    }

    fn update(&self, dependencies: Dependencies) {
        let mut snapshot = self.snapshot.write().unwrap_or_else(|p| p.into_inner());
        for (dependency, before, after) in [
            (
                "postgres",
                snapshot.dependencies.postgres,
                dependencies.postgres,
            ),
            ("redis", snapshot.dependencies.redis, dependencies.redis),
        ] {
            if before != after {
                tracing::info!(dependency, state = ?after, "dependency state changed");
            }
        }
        *snapshot = Snapshot {
            dependencies,
            checked_at: Some(Instant::now()),
        };
    }
}

/// Constructed once per process. Pool sizing is per replica, not per user.
pub struct Infrastructure {
    metrics: Arc<crate::metrics::Metrics>,
    postgres: Option<PgPool>,
    redis: Option<crate::redis_store::RedisStore>,
    timeout: Duration,
    schema_required: bool,
    schema_version: i64,
    runs_workers: bool,
    markets: Option<Arc<crate::markets::MarketHub>>,
    earn: Option<Arc<crate::earn_catalog::EarnCatalogHub>>,
    aave: Option<Arc<crate::aave_service::AaveService>>,
    morpho: Option<Arc<crate::morpho_service::MorphoService>>,
    swaps: Option<Arc<crate::providers::uniswap::UniswapQuotes>>,
    uniswap: Option<Arc<crate::uniswap_service::UniswapService>>,
    bridges: Option<Arc<crate::bridge_monitor::BridgeMonitor>>,
    near_intents: Option<Arc<crate::providers::near_intents::NearIntents>>,
    relay_quotes: Option<Arc<crate::providers::relay_quotes::RelayQuotes>>,
}

impl Infrastructure {
    pub fn new(config: &Config) -> anyhow::Result<Self> {
        config.validate()?;
        let metrics = Arc::new(crate::metrics::Metrics::default());
        let budget = Duration::from_millis(config.dependency_timeout_ms);
        let postgres = config
            .database_url
            .as_ref()
            .map(|url| {
                // Driver errors can include credentials; intentionally do not chain them.
                let options = url
                    .expose()
                    .parse::<PgConnectOptions>()
                    .map_err(|_| anyhow::anyhow!("invalid DATABASE_URL"))?
                    .options([
                        (
                            "statement_timeout",
                            config.database_statement_timeout_ms.to_string(),
                        ),
                        (
                            "lock_timeout",
                            config.database_statement_timeout_ms.min(2000).to_string(),
                        ),
                        (
                            "idle_in_transaction_session_timeout",
                            config.database_statement_timeout_ms.to_string(),
                        ),
                    ])
                    .disable_statement_logging();
                Ok::<_, anyhow::Error>(
                    PgPoolOptions::new()
                        .max_connections(config.database_max_connections)
                        .min_connections(0)
                        .acquire_timeout(budget)
                        .idle_timeout(Duration::from_secs(60))
                        .connect_lazy_with(options),
                )
            })
            .transpose()?;
        let redis = config
            .redis_url
            .as_ref()
            .map(|url| {
                redis::Client::open(url.expose())
                    .map(|client| {
                        crate::redis_store::RedisStore::with_metrics(
                            client,
                            config.redis_namespace.clone(),
                            budget,
                            metrics.clone(),
                        )
                    })
                    .map_err(|_| anyhow::anyhow!("invalid REDIS_URL"))
            })
            .transpose()?;
        let markets = if config.prices_enabled {
            Some(Arc::new(crate::markets::MarketHub::with_metrics(
                config,
                redis.clone().expect("validated Redis configuration"),
                metrics.clone(),
            )?))
        } else {
            None
        };
        let earn = if config.earn_read_targets.is_empty() {
            None
        } else {
            Some(Arc::new(crate::earn_catalog::EarnCatalogHub::new(
                &config.earn_read_targets,
                redis.clone().expect("validated Redis"),
                metrics.clone(),
            )?))
        };
        let aave = config
            .aave_execution_config_file
            .as_ref()
            .map(|path| {
                crate::aave_service::AaveService::from_file(
                    crate::work::WorkStore::new(postgres.clone().expect("validated database")),
                    path,
                    redis.clone().expect("validated Redis"),
                    metrics.clone(),
                )
                .map(Arc::new)
                .map_err(|_| anyhow::anyhow!("invalid AAVE_EXECUTION_CONFIG_FILE"))
            })
            .transpose()?;
        let morpho = config
            .morpho_execution_config_file
            .as_ref()
            .map(|path| {
                crate::morpho_service::MorphoService::from_file(
                    crate::work::WorkStore::new(postgres.clone().expect("validated database")),
                    path,
                    redis.clone().expect("validated Redis"),
                    metrics.clone(),
                )
                .map(Arc::new)
                .map_err(|_| anyhow::anyhow!("invalid MORPHO_EXECUTION_CONFIG_FILE"))
            })
            .transpose()?;
        let uniswap = config
            .uniswap_execution_config_file
            .as_ref()
            .map(|path| {
                crate::uniswap_service::UniswapService::from_file(
                    crate::work::WorkStore::new(postgres.clone().expect("validated database")),
                    path,
                    redis.clone().expect("validated Redis"),
                    metrics.clone(),
                )
                .map(Arc::new)
                .map_err(|_| anyhow::anyhow!("invalid UNISWAP_EXECUTION_CONFIG_FILE"))
            })
            .transpose()?;
        let swaps = config
            .uniswap_quote_config_file
            .as_ref()
            .map(|path| {
                crate::providers::uniswap::UniswapQuotes::from_file(
                    path,
                    config.auth.as_ref().expect("validated auth").chain_id as u64,
                    redis.clone().expect("validated Redis"),
                    metrics.clone(),
                )
                .map(Arc::new)
                .map_err(|_| anyhow::anyhow!("invalid UNISWAP_QUOTE_CONFIG_FILE"))
            })
            .transpose()?;
        let swaps = swaps.or_else(|| uniswap.as_ref().map(|s| s.quotes()));
        let near_intents = match std::env::var("NEAR_INTENTS_API_KEY") {
            Ok(api_key) => {
                if config.auth.is_none() || postgres.is_none() || redis.is_none() {
                    anyhow::bail!(
                        "NEAR_INTENTS_API_KEY requires wallet authentication, DATABASE_URL and REDIS_URL"
                    );
                }
                Some(Arc::new(
                    crate::providers::near_intents::NearIntents::new(
                        api_key,
                        redis.clone().expect("validated Redis"),
                    )
                    .map_err(|_| anyhow::anyhow!("invalid NEAR_INTENTS_API_KEY configuration"))?,
                ))
            }
            Err(std::env::VarError::NotPresent) => None,
            Err(_) => anyhow::bail!("invalid NEAR_INTENTS_API_KEY configuration"),
        };
        let relay_quotes = match std::env::var("RELAY_API_KEY") {
            Ok(api_key) => {
                if config.auth.is_none() || postgres.is_none() {
                    anyhow::bail!("RELAY_API_KEY requires wallet authentication and DATABASE_URL");
                }
                let redis = redis
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("RELAY_API_KEY requires REDIS_URL"))?;
                Some(Arc::new(
                    crate::providers::relay_quotes::RelayQuotes::new(api_key, redis.clone())
                        .map_err(|_| anyhow::anyhow!("invalid RELAY_API_KEY configuration"))?,
                ))
            }
            Err(std::env::VarError::NotPresent) => None,
            Err(_) => anyhow::bail!("invalid RELAY_API_KEY configuration"),
        };
        let bridges = postgres
            .clone()
            .map(|pool| {
                let work = crate::work::WorkStore::new(pool);
                config
                    .bridge_status_config_file
                    .as_ref()
                    .map_or_else(
                        || Ok(crate::bridge_monitor::BridgeMonitor::new(work.clone())),
                        |path| {
                            crate::bridge_monitor::BridgeMonitor::from_file(
                                work.clone(),
                                path,
                                redis.clone().expect("validated Redis"),
                                metrics.clone(),
                            )
                        },
                    )
                    .map(Arc::new)
                    .map_err(|_| anyhow::anyhow!("invalid BRIDGE_STATUS_CONFIG_FILE"))
            })
            .transpose()?;
        Ok(Self {
            near_intents,
            relay_quotes,
            bridges,
            uniswap,
            aave,
            morpho,
            swaps,
            earn,
            metrics,
            postgres,
            redis,
            timeout: budget,
            schema_required: config.auth.is_some(),
            schema_version: REQUIRED_SCHEMA_VERSION,
            runs_workers: config.server_role.runs_workers(),
            markets,
        })
    }

    pub fn aave(&self) -> Option<&Arc<crate::aave_service::AaveService>> {
        self.aave.as_ref()
    }

    pub fn morpho(&self) -> Option<&Arc<crate::morpho_service::MorphoService>> {
        self.morpho.as_ref()
    }
    pub fn near_intents(&self) -> Option<&Arc<crate::providers::near_intents::NearIntents>> {
        self.near_intents.as_ref()
    }

    pub fn relay_quotes(&self) -> Option<&Arc<crate::providers::relay_quotes::RelayQuotes>> {
        self.relay_quotes.as_ref()
    }
    pub fn bridges(&self) -> Option<&Arc<crate::bridge_monitor::BridgeMonitor>> {
        self.bridges.as_ref()
    }
    pub fn uniswap(&self) -> Option<&Arc<crate::uniswap_service::UniswapService>> {
        self.uniswap.as_ref()
    }
    pub fn swaps(&self) -> Option<&Arc<crate::providers::uniswap::UniswapQuotes>> {
        self.swaps.as_ref()
    }

    pub fn earn(&self) -> Option<&Arc<crate::earn_catalog::EarnCatalogHub>> {
        self.earn.as_ref()
    }

    pub fn metrics(&self) -> &Arc<crate::metrics::Metrics> {
        &self.metrics
    }

    pub fn postgres(&self) -> Option<&PgPool> {
        self.postgres.as_ref()
    }

    pub fn markets(&self) -> Option<&Arc<crate::markets::MarketHub>> {
        self.markets.as_ref()
    }

    pub fn redis(&self) -> Option<&crate::redis_store::RedisStore> {
        self.redis.as_ref()
    }

    pub fn start_monitor(self: Arc<Self>, health: RuntimeHealth) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(PROBE_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut next_queue_metrics = Instant::now();
            let mut next_auth_cleanup = Instant::now() + AUTH_CLEANUP_INTERVAL;
            loop {
                interval.tick().await;
                let (postgres, redis) = tokio::join!(self.probe_postgres(), self.probe_redis(),);
                self.metrics
                    .postgres_up
                    .set(i64::from(postgres == DependencyStatus::Up));
                self.metrics
                    .redis_up
                    .set(i64::from(redis == DependencyStatus::Up));
                self.metrics.draining.set(i64::from(health.is_draining()));
                if let Some(pool) = &self.postgres {
                    self.metrics
                        .database_connections
                        .set(i64::from(pool.size()));
                    self.metrics.database_idle.set(pool.num_idle() as i64);
                }
                if self.schema_required && Instant::now() >= next_queue_metrics {
                    next_queue_metrics = Instant::now() + QUEUE_METRICS_INTERVAL;
                    self.refresh_queue_metrics().await;
                }
                if self.runs_workers
                    && !health.is_draining()
                    && self.schema_required
                    && postgres == DependencyStatus::Up
                    && Instant::now() >= next_auth_cleanup
                {
                    next_auth_cleanup = Instant::now() + AUTH_CLEANUP_INTERVAL;
                    self.prune_expired_auth().await;
                }
                health.update(Dependencies { postgres, redis });
            }
        })
    }

    async fn prune_expired_auth(&self) {
        let Some(pool) = &self.postgres else {
            return;
        };
        match timeout(AUTH_CLEANUP_TIMEOUT, crate::database::prune_auth(pool)).await {
            Ok(Ok(deleted)) if deleted > 0 => {
                tracing::info!(deleted, "expired authentication state pruned");
                self.metrics
                    .auth_cleanup(true, Some(unix_timestamp_seconds()));
            }
            Ok(Ok(_)) => self
                .metrics
                .auth_cleanup(true, Some(unix_timestamp_seconds())),
            Ok(Err(_)) | Err(_) => {
                self.metrics.auth_cleanup(false, None);
                tracing::warn!(
                    error_code = "auth_cleanup_unavailable",
                    "expired authentication state cleanup failed"
                );
            }
        }
    }

    async fn refresh_queue_metrics(&self) {
        let Some(pool) = &self.postgres else {
            return;
        };
        let store = crate::work::WorkStore::new(pool.clone());
        match tokio::time::timeout(self.timeout, store.metrics_snapshot()).await {
            Ok(Ok(snapshot)) => {
                self.metrics.work_queue_state(
                    "ready",
                    snapshot.ready,
                    snapshot.oldest_ready_age_seconds,
                );
                self.metrics
                    .work_queue_state("leased", snapshot.leased, None);
                self.metrics.work_queue_state(
                    "expired_lease",
                    snapshot.expired_lease,
                    snapshot.oldest_expired_lease_age_seconds,
                );
                self.metrics.work_queue_state(
                    "dead",
                    snapshot.dead,
                    snapshot.oldest_dead_age_seconds,
                );
                let timestamp = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
                    .min(i64::MAX as u64) as i64;
                self.metrics.work_queue_refresh(true, Some(timestamp));
            }
            Ok(Err(_)) | Err(_) => {
                self.metrics.work_queue_refresh(false, None);
                tracing::warn!(
                    error_code = "work_queue_metrics_unavailable",
                    "durable queue metrics refresh failed"
                );
            }
        }
    }

    async fn probe_postgres(&self) -> DependencyStatus {
        let Some(pool) = &self.postgres else {
            return DependencyStatus::NotConfigured;
        };
        let probe = async {
            if self.schema_required {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version = $1 AND success)",
                )
                .bind(self.schema_version)
                .fetch_one(pool)
                .await
            } else {
                sqlx::query_scalar::<_, bool>("SELECT true")
                    .fetch_one(pool)
                    .await
            }
        };
        match timeout(self.timeout, probe).await {
            Ok(Ok(true)) => DependencyStatus::Up,
            _ => DependencyStatus::Down,
        }
    }

    async fn probe_redis(&self) -> DependencyStatus {
        let Some(redis) = &self.redis else {
            return DependencyStatus::NotConfigured;
        };
        if redis.ping().await.is_ok() {
            DependencyStatus::Up
        } else {
            DependencyStatus::Down
        }
    }

    pub async fn close(&self) {
        if let Some(pool) = &self.postgres {
            pool.close().await;
        }
    }
}

fn unix_timestamp_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SecretUrl;

    #[tokio::test]
    async fn authenticated_readiness_tracks_latest_required_migration() {
        let config = Config {
            database_url: Some(SecretUrl::new(
                "postgres://honey:secret@127.0.0.1/honey".into(),
            )),
            auth: Some(crate::config::AuthConfig {
                origin: "http://localhost:5173".into(),
                additional_origins: vec![],
                chain_id: 1,
            }),
            ..Config::default()
        };
        let infrastructure = Infrastructure::new(&config).unwrap();
        assert_eq!(infrastructure.schema_version, REQUIRED_SCHEMA_VERSION);
    }

    #[test]
    fn configured_dependencies_require_a_fresh_success_and_drain_revokes_readiness() {
        let config = Config {
            database_url: Some(SecretUrl::new("unused".into())),
            ..Config::default()
        };
        let health = RuntimeHealth::new(&config);
        assert!(matches!(
            health.readiness().status,
            ReadinessStatus::NotReady
        ));
        health.update(Dependencies {
            postgres: DependencyStatus::Up,
            redis: DependencyStatus::NotConfigured,
        });
        assert!(matches!(health.readiness().status, ReadinessStatus::Ready));
        health.snapshot.write().unwrap().checked_at =
            Some(Instant::now() - MAX_PROBE_AGE - Duration::from_secs(1));
        assert!(matches!(
            health.readiness().status,
            ReadinessStatus::NotReady
        ));
        health.update(Dependencies {
            postgres: DependencyStatus::Up,
            redis: DependencyStatus::NotConfigured,
        });
        health.begin_drain();
        assert!(matches!(
            health.readiness().status,
            ReadinessStatus::NotReady
        ));
    }

    #[test]
    fn required_infrastructure_cannot_be_ready_when_missing() {
        let health = RuntimeHealth::new(&Config {
            require_infrastructure: true,
            ..Config::default()
        });
        assert!(matches!(
            health.readiness().status,
            ReadinessStatus::NotReady
        ));
    }
}
