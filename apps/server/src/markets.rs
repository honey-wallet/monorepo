//! Public, venue-specific display prices. No execution quotes or portfolio valuation.

use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::extract::ws::Utf8Bytes;
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{Semaphore, watch},
    task::JoinHandle,
};
use uuid::Uuid;

use crate::{Config, error::AppError, redis_store::RedisStore};

const POLL: &str = include_str!("scripts/market_poll.lua");
const PUBLISH: &str = include_str!("scripts/market_publish.lua");
const BACKOFF: &str = include_str!("scripts/market_backoff.lua");
const SOCKET_LEASE: &str = include_str!("scripts/socket_lease.lua");
pub const STALE_AFTER_MS: u64 = 5000;
pub const SYMBOLS: [&str; 3] = ["BTC", "ETH", "SOL"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayPrice {
    pub instrument_id: String,
    pub symbol: String,
    pub quote_unit: String,
    pub price: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceSnapshot {
    pub schema_version: u8,
    #[serde(rename = "type")]
    pub message_type: String,
    pub epoch: Uuid,
    pub sequence: String,
    /// Redis clock when the completed upstream response was accepted; not exchange trade time.
    pub sampled_at_ms: u64,
    pub stale: bool,
    pub source: String,
    pub prices: Vec<DisplayPrice>,
}

pub struct PriceFrame {
    pub snapshot: PriceSnapshot,
    pub text: Utf8Bytes,
}

pub struct MarketHub {
    redis: RedisStore,
    pub metrics: Arc<crate::metrics::Metrics>,
    http: reqwest::Client,
    tx: watch::Sender<Option<Arc<PriceFrame>>>,
    pub permits: Arc<Semaphore>,
    max_connections: usize,
    per_ip: usize,
}

impl MarketHub {
    pub fn new(config: &Config, redis: RedisStore) -> anyhow::Result<Self> {
        Self::with_metrics(config, redis, Arc::new(crate::metrics::Metrics::default()))
    }

    pub fn with_metrics(
        config: &Config,
        redis: RedisStore,
        metrics: Arc<crate::metrics::Metrics>,
    ) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(2)
            .user_agent("HoneyWallet/0.1 public-market-reader")
            .build()
            .map_err(|_| anyhow::anyhow!("could not build market HTTP client"))?;
        let (tx, _) = watch::channel(None);
        Ok(Self {
            redis,
            metrics,
            http,
            tx,
            permits: Arc::new(Semaphore::new(config.price_max_connections)),
            max_connections: config.price_max_connections,
            per_ip: config.price_max_connections_per_ip,
        })
    }

    pub fn subscribe(&self) -> watch::Receiver<Option<Arc<PriceFrame>>> {
        self.tx.subscribe()
    }

    pub fn snapshot(&self) -> Option<PriceSnapshot> {
        self.tx.borrow().as_ref().map(|frame| {
            let mut snapshot = frame.snapshot.clone();
            snapshot.stale = is_stale(snapshot.sampled_at_ms, now_ms());
            snapshot
        })
    }

    pub async fn socket_lease(
        &self,
        mode: &str,
        id: Uuid,
        subject: &str,
    ) -> Result<bool, AppError> {
        let result: i32 = self
            .redis
            .query(
                redis::cmd("EVAL")
                    .arg(SOCKET_LEASE)
                    .arg(2)
                    .arg(self.redis.key("price-sockets", "global"))
                    .arg(self.redis.key("price-sockets", &format!("ip:{subject}")))
                    .arg(mode)
                    .arg(id.to_string())
                    .arg(self.max_connections)
                    .arg(self.per_ip),
            )
            .await?;
        Ok(result == 1)
    }

    /// Fixed upstream endpoint and fixed instrument allowlist. No user-provided URL,
    /// subscription, asset symbol or bearer credential reaches the provider.
    #[tracing::instrument(name = "provider.request", skip_all, fields(provider = "hyperliquid", operation = "all_mids", otel.kind = "client"))]
    async fn fetch_prices(&self) -> Result<Vec<DisplayPrice>, Duration> {
        let mut response = self
            .http
            .post("https://api.hyperliquid.xyz/info")
            .json(&serde_json::json!({"type":"allMids", "dex":""}))
            .send()
            .await
            .map_err(|_| Duration::from_secs(5))?;
        if !response.status().is_success() {
            let retry = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| {
                    v.parse::<u64>().ok().map(Duration::from_secs).or_else(|| {
                        httpdate::parse_http_date(v)
                            .ok()
                            .and_then(|at| at.duration_since(SystemTime::now()).ok())
                    })
                })
                .unwrap_or(Duration::from_secs(30))
                .clamp(Duration::from_secs(1), Duration::from_secs(86400));
            return Err(retry);
        }
        if response.content_length().is_some_and(|n| n > 256 * 1024) {
            return Err(Duration::from_secs(30));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Duration::from_secs(5))? {
            if body.len() + chunk.len() > 256 * 1024 {
                return Err(Duration::from_secs(30));
            }
            body.extend_from_slice(&chunk);
        }
        parse_mids(&body).map_err(|_| Duration::from_secs(30))
    }

    pub fn start(self: Arc<Self>) -> Vec<JoinHandle<()>> {
        self.start_for_role(crate::config::ServerRole::Combined)
    }

    pub fn start_for_role(self: Arc<Self>, role: crate::config::ServerRole) -> Vec<JoinHandle<()>> {
        let mut tasks = Vec::with_capacity(2);
        if role.runs_workers() {
            tasks.push(self.clone().start_collector());
        }
        if role.serves_api() {
            tasks.push(self.start_mirror());
        }
        tasks
    }

    fn start_collector(self: Arc<Self>) -> JoinHandle<()> {
        let ingest = self;
        tokio::spawn(async move {
            let owner = Uuid::new_v4().to_string();
            loop {
                let sampled: Result<i64, _> = ingest
                    .redis
                    .query(
                        redis::cmd("EVAL")
                            .arg(POLL)
                            .arg(1)
                            .arg(ingest.redis.key("prices", "control"))
                            .arg(&owner),
                    )
                    .await;
                ingest
                    .metrics
                    .market_redis("poll", if sampled.is_ok() { "ok" } else { "unavailable" });
                let Ok(sampled) = sampled else {
                    tracing::warn!(
                        operation = "price_poll_lease",
                        error_code = "redis_unavailable",
                        "price poll lease unavailable"
                    );
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                };
                if sampled <= 0 {
                    // Redis owns the schedule. Sleep to its next allowed poll time;
                    // a local periodic timer can repeatedly fire just before that
                    // deadline and lose an entire interval to clock/RTT skew.
                    // A non-owner rechecks once per second in case its lease expires.
                    let wait_ms = sampled.unsigned_abs().clamp(25, 1000);
                    tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                    continue;
                }
                let started = std::time::Instant::now();
                let result = ingest.fetch_prices().await;
                ingest
                    .metrics
                    .market_fetch(result.is_ok(), started.elapsed().as_secs_f64());
                match result {
                    Ok(prices) => match ingest.publish(&owner, &prices).await {
                        Ok(true) => ingest.metrics.market_redis("publish", "ok"),
                        Ok(false) => {
                            ingest.metrics.market_redis("publish", "fenced");
                            tracing::warn!(
                                operation = "price_snapshot_publish",
                                error_code = "lease_fenced",
                                "price snapshot publish rejected by lease fence"
                            );
                        }
                        Err(_) => {
                            ingest.metrics.market_redis("publish", "unavailable");
                            tracing::warn!(
                                operation = "price_snapshot_publish",
                                error_code = "redis_unavailable",
                                "price snapshot publish failed"
                            );
                        }
                    },
                    Err(delay) => {
                        tracing::warn!(
                            provider = "hyperliquid",
                            operation = "allMids",
                            error_code = "market_fetch_failed",
                            retry_ms = delay.as_millis() as u64,
                            "market refresh deferred"
                        );
                        let _: Result<i32, _> = ingest
                            .redis
                            .query(
                                redis::cmd("EVAL")
                                    .arg(BACKOFF)
                                    .arg(1)
                                    .arg(ingest.redis.key("prices", "control"))
                                    .arg(&owner)
                                    .arg(delay.as_millis() as u64),
                            )
                            .await;
                    }
                }
            }
        })
    }

    fn start_mirror(self: Arc<Self>) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(500));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let cached: Result<Option<String>, _> = self
                    .redis
                    .query(redis::cmd("GET").arg(self.redis.key("prices", "snapshot")))
                    .await;
                let snapshot = match cached {
                    Err(_) => {
                        self.metrics.market_redis("read", "unavailable");
                        self.snapshot()
                    }
                    Ok(None) => {
                        self.metrics.market_redis("read", "empty");
                        self.snapshot()
                    }
                    Ok(Some(raw)) if raw.len() > 8192 => {
                        self.metrics.market_redis("read", "invalid");
                        self.snapshot()
                    }
                    Ok(Some(raw)) => match serde_json::from_str::<PriceSnapshot>(&raw)
                        .ok()
                        .filter(valid_snapshot)
                    {
                        Some(snapshot) => {
                            self.metrics.market_redis("read", "ok");
                            Some(snapshot)
                        }
                        None => {
                            self.metrics.market_redis("read", "invalid");
                            self.snapshot()
                        }
                    },
                };
                if let Some(snapshot) = snapshot {
                    self.install(snapshot);
                }
            }
        })
    }

    pub async fn publish(&self, owner: &str, prices: &[DisplayPrice]) -> Result<bool, AppError> {
        let encoded = serde_json::to_string(prices).map_err(|_| AppError::Busy)?;
        let result: i32 = self
            .redis
            .query(
                redis::cmd("EVAL")
                    .arg(PUBLISH)
                    .arg(2)
                    .arg(self.redis.key("prices", "control"))
                    .arg(self.redis.key("prices", "snapshot"))
                    .arg(owner)
                    .arg(Uuid::new_v4().to_string())
                    .arg(encoded),
            )
            .await?;
        Ok(result == 1)
    }

    /// Shared serialization and latest-value coalescing: a slow client cannot grow
    /// an event queue. Sequence gaps are expected; every update is a full snapshot.
    pub fn install(&self, snapshot: PriceSnapshot) {
        self.install_at(snapshot, now_ms());
    }

    fn install_at(&self, mut snapshot: PriceSnapshot, now: u64) {
        if !valid_snapshot(&snapshot) {
            return;
        }
        {
            let current = self.tx.borrow();
            if let Some(previous) = current.as_ref()
                && previous.snapshot.epoch == snapshot.epoch
                && snapshot.sequence.parse::<u64>().unwrap_or(0)
                    < previous.snapshot.sequence.parse::<u64>().unwrap_or(0)
            {
                // Redis restore can roll back the sequence within an epoch.
                // Keep the latest accepted prices, but continue aging their
                // serialized WS frame while the collector catches up.
                snapshot = previous.snapshot.clone();
            }
        }
        snapshot.stale = is_stale(snapshot.sampled_at_ms, now);
        self.metrics
            .price_sample_ms
            .set(snapshot.sampled_at_ms as i64);
        self.metrics.price_stale.set(i64::from(snapshot.stale));
        let unchanged = self.tx.borrow().as_ref().is_some_and(|previous| {
            previous.snapshot.epoch == snapshot.epoch
                && previous.snapshot.sequence == snapshot.sequence
                && previous.snapshot.stale == snapshot.stale
        });
        if unchanged {
            return;
        }
        if let Ok(text) = serde_json::to_string(&snapshot) {
            self.tx.send_replace(Some(Arc::new(PriceFrame {
                snapshot,
                text: Utf8Bytes::from(text),
            })));
        }
    }
}

pub fn parse_mids(body: &[u8]) -> Result<Vec<DisplayPrice>, &'static str> {
    let mids: BTreeMap<String, String> =
        serde_json::from_slice(body).map_err(|_| "invalid_schema")?;
    SYMBOLS
        .into_iter()
        .map(|symbol| {
            let price = mids
                .get(symbol)
                .filter(|p| positive_decimal(p))
                .ok_or("missing_or_invalid_price")?;
            Ok(DisplayPrice {
                instrument_id: format!("hyperliquid:perp:{symbol}"),
                symbol: symbol.into(),
                quote_unit: "USDT".into(),
                price: price.clone(),
                kind: "mid_or_last".into(),
            })
        })
        .collect()
}

fn positive_decimal(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction
            .is_none_or(|f| !f.is_empty() && f.len() <= 18 && f.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
        && value.bytes().any(|b| matches!(b, b'1'..=b'9'))
}

fn valid_snapshot(snapshot: &PriceSnapshot) -> bool {
    snapshot.sampled_at_ms > 0
        && snapshot.sampled_at_ms <= 9_007_199_254_740_991
        && snapshot.schema_version == 1
        && snapshot.message_type == "snapshot"
        && snapshot.source == "hyperliquid"
        && snapshot.sequence.parse::<u64>().is_ok_and(|n| n > 0)
        && snapshot.prices.len() == SYMBOLS.len()
        && snapshot.prices.iter().zip(SYMBOLS).all(|(p, symbol)| {
            p.instrument_id == format!("hyperliquid:perp:{symbol}")
                && p.symbol == symbol
                && p.quote_unit == "USDT"
                && p.kind == "mid_or_last"
                && positive_decimal(&p.price)
        })
}

fn is_stale(sampled: u64, now: u64) -> bool {
    sampled > now || now.saturating_sub(sampled) > STALE_AFTER_MS
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restored_lower_sequence_ages_existing_frame_without_replacing_prices() {
        let cfg = crate::Config::default();
        let redis = RedisStore::new(
            redis::Client::open("redis://127.0.0.1:1").unwrap(),
            "market-restore-test".into(),
            Duration::from_millis(100),
        );
        let hub = MarketHub::new(&cfg, redis).unwrap();
        let mut updates = hub.subscribe();
        let latest = PriceSnapshot {
            schema_version: 1,
            message_type: "snapshot".into(),
            epoch: Uuid::new_v4(),
            sequence: "100".into(),
            sampled_at_ms: 10_000,
            stale: false,
            source: "hyperliquid".into(),
            prices: parse_mids(br#"{"BTC":"10","ETH":"2","SOL":"3"}"#).unwrap(),
        };
        hub.install_at(latest.clone(), 10_000);
        updates.borrow_and_update();
        let mut restored = latest.clone();
        restored.sequence = "1".into();
        restored.sampled_at_ms = 9_000;
        restored.prices[0].price = "9".into();
        hub.install_at(restored.clone(), 11_000);
        assert!(!updates.has_changed().unwrap());

        hub.install_at(restored.clone(), 15_001);
        assert!(updates.has_changed().unwrap());
        let frame = updates.borrow_and_update().clone().unwrap();
        let serialized: PriceSnapshot = serde_json::from_str(frame.text.as_str()).unwrap();
        assert!(serialized.stale);
        assert_eq!(serialized.sequence, "100");
        assert_eq!(serialized.sampled_at_ms, 10_000);
        assert_eq!(serialized.prices[0].price, "10");
        assert_eq!(hub.metrics.price_stale.get(), 1);

        hub.install_at(restored, 16_000);
        assert!(!updates.has_changed().unwrap());
        let mut recovered = latest;
        recovered.sequence = "101".into();
        recovered.sampled_at_ms = 16_000;
        recovered.prices[0].price = "11".into();
        hub.install_at(recovered, 16_000);
        assert!(updates.has_changed().unwrap());
        let frame = updates.borrow_and_update().clone().unwrap();
        assert!(!frame.snapshot.stale);
        assert_eq!(frame.snapshot.sequence, "101");
        assert_eq!(frame.snapshot.prices[0].price, "11");
    }

    #[tokio::test]
    async fn roles_start_only_their_assigned_tasks() {
        use crate::config::ServerRole;
        let cfg = crate::Config {
            redis_url: Some(crate::config::SecretUrl::new("redis://127.0.0.1:1".into())),
            ..Default::default()
        };
        let infrastructure = crate::runtime::Infrastructure::new(&cfg).unwrap();
        let hub = Arc::new(MarketHub::new(&cfg, infrastructure.redis().unwrap().clone()).unwrap());
        for (role, expected) in [
            (ServerRole::Api, 1),
            (ServerRole::Worker, 1),
            (ServerRole::Combined, 2),
        ] {
            let tasks = hub.clone().start_for_role(role);
            assert_eq!(tasks.len(), expected);
            // Abort before yielding: this checks task topology without contacting
            // Redis or an upstream provider.
            for task in &tasks {
                task.abort();
            }
            for task in tasks {
                assert!(task.await.unwrap_err().is_cancelled());
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires isolated TEST_REDIS_URL"]
    async fn api_role_mirrors_another_instances_publication() {
        let cfg = crate::Config {
            redis_url: Some(crate::config::SecretUrl::new(
                std::env::var("TEST_REDIS_URL").expect("isolated TEST_REDIS_URL"),
            )),
            redis_namespace: format!("market-role:{}", Uuid::new_v4().simple()),
            ..Default::default()
        };
        let infrastructure = crate::runtime::Infrastructure::new(&cfg).unwrap();
        let redis = infrastructure.redis().unwrap().clone();
        let collector = MarketHub::new(&cfg, redis.clone()).unwrap();
        let api = Arc::new(MarketHub::new(&cfg, redis.clone()).unwrap());
        let owner = Uuid::new_v4().to_string();
        let sampled: i64 = redis
            .query(
                redis::cmd("EVAL")
                    .arg(POLL)
                    .arg(1)
                    .arg(redis.key("prices", "control"))
                    .arg(&owner),
            )
            .await
            .unwrap();
        assert!(sampled > 0);
        let prices = parse_mids(br#"{"BTC":"10","ETH":"2","SOL":"3"}"#).unwrap();
        assert!(collector.publish(&owner, &prices).await.unwrap());
        let tasks = api.clone().start_for_role(crate::config::ServerRole::Api);
        assert_eq!(tasks.len(), 1);
        let mirrored = tokio::time::timeout(Duration::from_secs(2), async {
            while api.snapshot().is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        for task in tasks {
            task.abort();
            let _ = task.await;
        }
        mirrored.unwrap();
        assert_eq!(api.snapshot().unwrap().prices[0].price, "10");
        assert!(collector.snapshot().is_none());
    }

    #[test]
    fn display_prices_preserve_decimals_and_reject_missing_numbers_or_exponents() {
        let prices =
            parse_mids(br#"{"BTC":"12345678901234567890.123456789012345678","ETH":"2","SOL":"3"}"#)
                .unwrap();
        assert_eq!(prices[0].price, "12345678901234567890.123456789012345678");
        for body in [
            br#"{"BTC":1,"ETH":"2","SOL":"3"}"#.as_slice(),
            br#"{"BTC":"1e5","ETH":"2","SOL":"3"}"#,
            br#"{"BTC":"1","ETH":"2"}"#,
        ] {
            assert!(parse_mids(body).is_err());
        }
        assert!(is_stale(100, 6000));
        assert!(is_stale(100, 99));
        assert!(!is_stale(100, 5000));
    }
}
