//! Read-only Hyperliquid perps account state. The authenticated SIWE wallet is
//! always the provider account; callers cannot query another address.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

use crate::error::AppError;

const INFO_URL: &str = "https://api.hyperliquid.xyz/info";
const MAX_PROVIDER_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_SOURCE_AGE_MS: u64 = 30_000;
const MAX_FUTURE_SKEW_MS: u64 = 5_000;
const CACHE_TTL_MS: u64 = 5_000;
const REFRESH_LOCK_MS: u64 = 8_000;
const WAITER_MS: u64 = 1_000;
const RELEASE_LOCK: &str = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

#[derive(Clone)]
pub struct HyperliquidPerps {
    http: reqwest::Client,
    permits: Arc<Semaphore>,
    info_url: String,
}

/// Owner-fenced refresh lease. Cancellation schedules best-effort release; a
/// process crash still relies on the bounded Redis TTL.
struct RefreshLease {
    redis: crate::redis_store::RedisStore,
    key: String,
    owner: String,
    released: bool,
}

impl RefreshLease {
    fn new(redis: crate::redis_store::RedisStore, key: String, owner: String) -> Self {
        Self {
            redis,
            key,
            owner,
            released: false,
        }
    }

    async fn release(&mut self) {
        if self.released {
            return;
        }
        if release_refresh_lock(&self.redis, &self.key, &self.owner)
            .await
            .is_ok()
        {
            self.released = true;
        }
    }
}

impl Drop for RefreshLease {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let redis = self.redis.clone();
        let key = self.key.clone();
        let owner = self.owner.clone();
        runtime.spawn(async move {
            let _ = release_refresh_lock(&redis, &key, &owner).await;
        });
    }
}

async fn release_refresh_lock(
    redis: &crate::redis_store::RedisStore,
    key: &str,
    owner: &str,
) -> Result<(), AppError> {
    let _: i32 = redis
        .query(
            redis::cmd("EVAL")
                .arg(RELEASE_LOCK)
                .arg(1)
                .arg(key)
                .arg(owner),
        )
        .await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerpsAccountState {
    pub schema_version: u8,
    pub venue: String,
    pub account: String,
    pub fetched_at_ms: u64,
    pub state: ClearinghouseState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearinghouseState {
    pub margin_summary: MarginSummary,
    pub cross_margin_summary: MarginSummary,
    pub cross_maintenance_margin_used: String,
    pub withdrawable: String,
    pub asset_positions: Vec<PerpPosition>,
    pub time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginSummary {
    pub account_value: String,
    pub total_ntl_pos: String,
    pub total_raw_usd: String,
    pub total_margin_used: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerpPosition {
    #[serde(rename = "type")]
    pub position_type: String,
    pub position: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub coin: String,
    pub szi: String,
    pub entry_px: Option<String>,
    pub position_value: String,
    pub unrealized_pnl: String,
    pub margin_used: String,
    pub liquidation_px: Option<String>,
    pub leverage: Leverage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Leverage {
    #[serde(rename = "type")]
    pub margin_mode: String,
    pub value: u32,
}

impl HyperliquidPerps {
    pub fn new() -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("HoneyWallet/0.1 authenticated-perps-read")
            .build()
            .map_err(|_| AppError::Busy)?;
        Ok(Self {
            http,
            permits: Arc::new(Semaphore::new(8)),
            info_url: INFO_URL.into(),
        })
    }

    pub async fn account_state(
        &self,
        account: &str,
        redis: &crate::redis_store::RedisStore,
    ) -> Result<PerpsAccountState, AppError> {
        if !valid_address(account) {
            return Err(AppError::Unauthorized);
        }
        // Redis is mandatory for this read. Without it each replica could turn a
        // simultaneous cache miss into an unbounded burst at the provider.
        let canonical = account.to_ascii_lowercase();
        if let Some(cached) = self.read_cache(redis, &canonical).await? {
            return Ok(cached);
        }
        let suffix = hex::encode(sha2::Sha256::digest(canonical.as_bytes()));
        let lock_key = redis.key("hyperliquid_account", &format!("lock:{suffix}"));
        let cache_key = redis.key("hyperliquid_account", &format!("cache:{suffix}"));
        let owner = uuid::Uuid::new_v4().to_string();
        let acquired: Option<String> = redis
            .query(
                redis::cmd("SET")
                    .arg(&lock_key)
                    .arg(&owner)
                    .arg("PX")
                    .arg(REFRESH_LOCK_MS)
                    .arg("NX"),
            )
            .await?;
        if acquired.is_none() {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(WAITER_MS);
            while tokio::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if let Some(cached) = self.read_cache(redis, &canonical).await? {
                    return Ok(cached);
                }
            }
            return Err(AppError::Busy);
        }
        let mut lease = RefreshLease::new(redis.clone(), lock_key.clone(), owner.clone());

        let refresh = async {
            // clearinghouseState costs two weight units; 500 reads/minute stays
            // below Hyperliquid's 1,200-weight/IP minute ceiling with headroom.
            redis
                .rate_limit_pair("hyperliquid_upstream", &canonical, 500, 12)
                .await?;
            let result = self.fetch_account_state(&canonical).await?;
            let raw = serde_json::to_string(&result).map_err(|_| AppError::Busy)?;
            let published: i32 = redis
                .query(
                    redis::cmd("EVAL")
                        .arg("if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]); return 1")
                        .arg(2)
                        .arg(&lock_key)
                        .arg(&cache_key)
                        .arg(&owner)
                        .arg(raw)
                        .arg(CACHE_TTL_MS),
                )
                .await?;
            if published != 1 {
                return Err(AppError::Busy);
            }
            Ok(result)
        }
        .await;
        // Release only our own lock; a delayed owner cannot delete a successor's lease.
        // The guard also schedules this release if the request future is cancelled.
        lease.release().await;
        refresh
    }

    async fn read_cache(
        &self,
        redis: &crate::redis_store::RedisStore,
        account: &str,
    ) -> Result<Option<PerpsAccountState>, AppError> {
        let suffix = hex::encode(sha2::Sha256::digest(account.as_bytes()));
        let key = redis.key("hyperliquid_account", &format!("cache:{suffix}"));
        let raw: Option<String> = redis.query(redis::cmd("GET").arg(&key)).await?;
        let Some(raw) = raw else { return Ok(None) };
        let ttl_ms: i64 = redis.query(redis::cmd("PTTL").arg(&key)).await?;
        let now = crate::markets::now_ms();
        let cached: PerpsAccountState = match serde_json::from_str(&raw) {
            Ok(cached) => cached,
            Err(_) => return Ok(None),
        };
        if valid_cached(&cached, account, now, ttl_ms) {
            Ok(Some(cached))
        } else {
            Ok(None)
        }
    }

    async fn fetch_account_state(&self, account: &str) -> Result<PerpsAccountState, AppError> {
        // Authenticated callers can still fan out requests across many sessions.
        // Reject excess provider work instead of building an unbounded wait queue.
        let _permit = self.permits.try_acquire().map_err(|_| AppError::Busy)?;
        let started = Instant::now();
        let result = self.fetch_provider(account).await;
        tracing::info!(
            provider = "hyperliquid",
            operation = "clearinghouse_state",
            outcome = if result.is_ok() { "ok" } else { "failed" },
            elapsed_ms = started.elapsed().as_millis() as u64,
            "perps account read completed"
        );
        result
    }

    async fn fetch_provider(&self, account: &str) -> Result<PerpsAccountState, AppError> {
        let response = self
            .http
            .post(&self.info_url)
            .json(&serde_json::json!({ "type": "clearinghouseState", "user": account }))
            .send()
            .await
            .map_err(|_| AppError::Busy)?;
        if !response.status().is_success() {
            return Err(AppError::Busy);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
        {
            return Err(AppError::Busy);
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::with_capacity(16 * 1024);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| AppError::Busy)?;
            if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
                return Err(AppError::Busy);
            }
            body.extend_from_slice(&chunk);
        }
        let raw: Value = serde_json::from_slice(&body).map_err(|_| AppError::Busy)?;
        let state: ClearinghouseState = serde_json::from_value(raw).map_err(|_| AppError::Busy)?;
        let fetched_at_ms = crate::markets::now_ms();
        if !valid_state(&state) || !valid_source_time(state.time, fetched_at_ms) {
            return Err(AppError::Busy);
        }
        Ok(PerpsAccountState {
            schema_version: 1,
            venue: "hyperliquid".into(),
            account: account.to_ascii_lowercase(),
            fetched_at_ms,
            state,
        })
    }
}

/// Hyperliquid's clearinghouse `time` is a Unix millisecond source timestamp.
/// Keep it separate from local receipt time and fail closed on stale/future data.
fn valid_source_time(source_ms: u64, now_ms: u64) -> bool {
    source_ms <= now_ms.saturating_add(MAX_FUTURE_SKEW_MS)
        && now_ms.saturating_sub(source_ms) <= MAX_SOURCE_AGE_MS
}

fn valid_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn decimal(s: &str, signed: bool) -> bool {
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    let s = s.strip_prefix('-').filter(|_| signed).unwrap_or(s);
    let mut parts = s.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction
            .is_none_or(|f| !f.is_empty() && f.len() <= 24 && f.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
}

fn valid_summary(summary: &MarginSummary) -> bool {
    decimal(&summary.account_value, false)
        && decimal(&summary.total_ntl_pos, false)
        && decimal(&summary.total_raw_usd, true)
        && decimal(&summary.total_margin_used, false)
}

fn valid_state(state: &ClearinghouseState) -> bool {
    valid_summary(&state.margin_summary)
        && valid_summary(&state.cross_margin_summary)
        && decimal(&state.cross_maintenance_margin_used, false)
        && decimal(&state.withdrawable, false)
        && state.asset_positions.len() <= 500
        && state.asset_positions.iter().all(|ap| {
            let p = &ap.position;
            matches!(ap.position_type.as_str(), "oneWay" | "hedged")
                && !p.coin.is_empty()
                && p.coin.len() <= 64
                && decimal(&p.szi, true)
                && p.entry_px.as_ref().is_none_or(|v| decimal(v, false))
                && decimal(&p.position_value, false)
                && decimal(&p.unrealized_pnl, true)
                && decimal(&p.margin_used, false)
                && p.liquidation_px.as_ref().is_none_or(|v| decimal(v, false))
                && matches!(p.leverage.margin_mode.as_str(), "cross" | "isolated")
                && p.leverage.value > 0
        })
}

fn valid_cached(cached: &PerpsAccountState, account: &str, now: u64, ttl_ms: i64) -> bool {
    ttl_ms > 0
        && ttl_ms as u64 <= CACHE_TTL_MS
        && cached.schema_version == 1
        && cached.venue == "hyperliquid"
        && cached.account == account
        && cached.fetched_at_ms <= now
        && now.saturating_sub(cached.fetched_at_ms) <= CACHE_TTL_MS
        && valid_state(&cached.state)
        && valid_source_time(cached.state.time, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ClearinghouseState {
        serde_json::from_value(serde_json::json!({
            "assetPositions":[{"type":"oneWay","position":{
                "coin":"ETH","szi":"0.0335","entryPx":"2986.3",
                "positionValue":"100.02765","unrealizedPnl":"-0.0134",
                "marginUsed":"4.967826","liquidationPx":"2866.26936529",
                "leverage":{"type":"isolated","value":20,"rawUsd":"-95.059824"}
            }}],
            "crossMaintenanceMarginUsed":"0.0","withdrawable":"29.78001",
            "marginSummary":{"accountValue":"29.78001","totalNtlPos":"0.0","totalRawUsd":"29.78001","totalMarginUsed":"0.0"},
            "crossMarginSummary":{"accountValue":"29.78001","totalNtlPos":"0.0","totalRawUsd":"29.78001","totalMarginUsed":"0.0"},
            "time":1733968369395u64
        })).unwrap()
    }

    #[test]
    fn validates_official_clearinghouse_shape_and_preserves_decimal_strings() {
        let state = fixture();
        assert!(valid_state(&state));
        assert_eq!(state.asset_positions[0].position.unrealized_pnl, "-0.0134");
    }

    #[test]
    fn rejects_malformed_amounts_and_unbounded_position_lists() {
        let mut state = fixture();
        state.asset_positions[0].position.szi = "1e3".into();
        assert!(!valid_state(&state));
        let mut state = fixture();
        state
            .asset_positions
            .resize(501, state.asset_positions[0].clone());
        assert!(!valid_state(&state));
    }

    #[test]
    fn account_address_validation_is_exact_hex_eoa_shape() {
        assert!(valid_address("0x0000000000000000000000000000000000000001"));
        assert!(!valid_address("0x000000000000000000000000000000000000000"));
        assert!(!valid_address("0xzz000000000000000000000000000000000001"));
    }

    #[tokio::test]
    async fn provider_admission_rejects_overload_without_waiting() {
        let provider = HyperliquidPerps {
            http: reqwest::Client::new(),
            permits: Arc::new(Semaphore::new(1)),
            info_url: INFO_URL.into(),
        };
        let permit = provider.permits.clone().try_acquire_owned().unwrap();
        let result = provider
            .fetch_account_state("0x0000000000000000000000000000000000000001")
            .await;
        assert!(matches!(result, Err(AppError::Busy)));
        drop(permit);
        assert_eq!(provider.permits.available_permits(), 1);
    }

    #[test]
    fn clearinghouse_source_time_must_be_fresh_milliseconds() {
        let now = 1_800_000_000_000;
        assert!(valid_source_time(now, now));
        assert!(valid_source_time(now - MAX_SOURCE_AGE_MS, now));
        assert!(!valid_source_time(now - MAX_SOURCE_AGE_MS - 1, now));
        assert!(valid_source_time(now + MAX_FUTURE_SKEW_MS, now));
        assert!(!valid_source_time(now + MAX_FUTURE_SKEW_MS + 1, now));
        // A seconds-valued timestamp is stale by orders of magnitude.
        assert!(!valid_source_time(now / 1000, now));
        assert!(valid_source_time(u64::MAX, u64::MAX));
        assert!(!valid_source_time(u64::MAX, now));
    }

    #[test]
    fn cached_state_requires_exact_account_schema_ttl_and_fresh_source_time() {
        let now = 1_800_000_000_000;
        let account = "0x0000000000000000000000000000000000000001";
        let mut state = fixture();
        state.time = now;
        let mut cached = PerpsAccountState {
            schema_version: 1,
            venue: "hyperliquid".into(),
            account: account.into(),
            fetched_at_ms: now,
            state,
        };
        assert!(valid_cached(&cached, account, now, CACHE_TTL_MS as i64));
        assert!(!valid_cached(
            &cached,
            "0x0000000000000000000000000000000000000002",
            now,
            1
        ));
        assert!(!valid_cached(&cached, account, now, 0));
        assert!(!valid_cached(
            &cached,
            account,
            now,
            CACHE_TTL_MS as i64 + 1
        ));
        assert!(!valid_cached(&cached, account, now + CACHE_TTL_MS + 1, 1));
        cached.schema_version = 2;
        assert!(!valid_cached(&cached, account, now, 1));
        cached.schema_version = 1;
        cached.state.time = now - MAX_SOURCE_AGE_MS - 1;
        assert!(!valid_cached(&cached, account, now, 1));
    }

    #[tokio::test]
    #[ignore = "requires isolated TEST_REDIS_URL"]
    async fn stale_refresh_lease_drop_cannot_delete_successor() {
        use uuid::Uuid;

        let namespace = format!("test:{}", Uuid::new_v4().simple());
        let redis = crate::redis_store::RedisStore::new(
            redis::Client::open(std::env::var("TEST_REDIS_URL").unwrap()).unwrap(),
            namespace.clone(),
            Duration::from_secs(1),
        );
        redis.ping().await.unwrap();

        let key = redis.key("hyperliquid_account", "lock:stale-owner-race");
        let stale_owner = Uuid::new_v4().to_string();
        let successor = Uuid::new_v4().to_string();
        let acquired: Option<String> = redis
            .query(
                redis::cmd("SET")
                    .arg(&key)
                    .arg(&stale_owner)
                    .arg("PX")
                    .arg(25)
                    .arg("NX"),
            )
            .await
            .unwrap();
        assert_eq!(acquired.as_deref(), Some("OK"));
        let stale_lease = RefreshLease::new(redis.clone(), key.clone(), stale_owner);

        // Wait for Redis to expire A before B acquires the same lease key.
        let mut expired = false;
        for _ in 0..100 {
            let current: Option<String> = redis.query(redis::cmd("GET").arg(&key)).await.unwrap();
            if current.is_none() {
                expired = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(expired, "owner A lease did not expire");

        let acquired: Option<String> = redis
            .query(
                redis::cmd("SET")
                    .arg(&key)
                    .arg(&successor)
                    .arg("PX")
                    .arg(REFRESH_LOCK_MS)
                    .arg("NX"),
            )
            .await
            .unwrap();
        assert_eq!(acquired.as_deref(), Some("OK"));

        // Dropping A schedules the same best-effort cleanup used after cancellation.
        drop(stale_lease);
        let mut observed_successor = false;
        for _ in 0..100 {
            let current: Option<String> = redis.query(redis::cmd("GET").arg(&key)).await.unwrap();
            if current.as_deref() == Some(successor.as_str()) {
                observed_successor = true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            observed_successor,
            "stale owner cleanup deleted successor lease"
        );
        let _: i32 = redis.query(redis::cmd("DEL").arg(&key)).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
    async fn redis_cache_coalesces_cross_instance_misses_and_isolates_accounts() {
        use axum::{Json, Router, extract::State, routing::post};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use uuid::Uuid;

        async fn provider(State(calls): State<Arc<AtomicUsize>>) -> Json<serde_json::Value> {
            calls.fetch_add(1, Ordering::SeqCst);
            let now = crate::markets::now_ms();
            Json(serde_json::json!({
                "assetPositions":[],
                "crossMaintenanceMarginUsed":"0.0",
                "withdrawable":"0.0",
                "marginSummary":{"accountValue":"0.0","totalNtlPos":"0.0","totalRawUsd":"0.0","totalMarginUsed":"0.0"},
                "crossMarginSummary":{"accountValue":"0.0","totalNtlPos":"0.0","totalRawUsd":"0.0","totalMarginUsed":"0.0"},
                "time":now
            }))
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/info", post(provider))
            .with_state(calls.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let namespace = format!("test:{}", Uuid::new_v4().simple());
        let redis = crate::redis_store::RedisStore::new(
            redis::Client::open(std::env::var("TEST_REDIS_URL").unwrap()).unwrap(),
            namespace.clone(),
            Duration::from_secs(1),
        );
        redis.ping().await.unwrap();
        let make_provider = || HyperliquidPerps {
            http: reqwest::Client::new(),
            permits: Arc::new(Semaphore::new(8)),
            info_url: format!("http://{address}/info"),
        };
        let first = make_provider();
        let second = make_provider();
        let account = "0x0000000000000000000000000000000000000001";
        let (a, b) = tokio::join!(
            first.account_state(account, &redis),
            second.account_state(account, &redis)
        );
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(second.account_state(account, &redis).await.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(
            second
                .account_state("0x0000000000000000000000000000000000000002", &redis)
                .await
                .is_ok()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
        let mut cursor = 0u64;
        loop {
            let (next, keys): (u64, Vec<String>) = redis
                .query(
                    redis::cmd("SCAN")
                        .arg(cursor)
                        .arg("MATCH")
                        .arg(format!("{namespace}:*")),
                )
                .await
                .unwrap();
            if !keys.is_empty() {
                let _: i32 = redis.query(redis::cmd("DEL").arg(keys)).await.unwrap();
            }
            if next == 0 {
                break;
            }
            cursor = next;
        }
    }

    #[tokio::test]
    #[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
    async fn cancelled_refresh_releases_only_its_owner_lease() {
        use axum::{Json, Router, extract::State, routing::post};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use uuid::Uuid;

        async fn provider(State(calls): State<Arc<AtomicUsize>>) -> Json<serde_json::Value> {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            let now = crate::markets::now_ms();
            Json(serde_json::json!({
                "assetPositions":[],
                "crossMaintenanceMarginUsed":"0.0",
                "withdrawable":"0.0",
                "marginSummary":{"accountValue":"0.0","totalNtlPos":"0.0","totalRawUsd":"0.0","totalMarginUsed":"0.0"},
                "crossMarginSummary":{"accountValue":"0.0","totalNtlPos":"0.0","totalRawUsd":"0.0","totalMarginUsed":"0.0"},
                "time":now
            }))
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/info", post(provider))
            .with_state(calls.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let namespace = format!("test:{}", Uuid::new_v4().simple());
        let redis = crate::redis_store::RedisStore::new(
            redis::Client::open(std::env::var("TEST_REDIS_URL").unwrap()).unwrap(),
            namespace.clone(),
            Duration::from_secs(1),
        );
        redis.ping().await.unwrap();
        let provider = HyperliquidPerps {
            http: reqwest::Client::new(),
            permits: Arc::new(Semaphore::new(8)),
            info_url: format!("http://{address}/info"),
        };
        let account = "0x0000000000000000000000000000000000000001";
        let suffix = hex::encode(sha2::Sha256::digest(account));
        let lock = redis.key("hyperliquid_account", &format!("lock:{suffix}"));
        let refresh = {
            let provider = provider.clone();
            let redis = redis.clone();
            tokio::spawn(async move { provider.account_state(account, &redis).await })
        };
        let mut acquired = false;
        for _ in 0..100 {
            let owner: Option<String> = redis.query(redis::cmd("GET").arg(&lock)).await.unwrap();
            if owner.is_some() {
                acquired = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(acquired, "refresh lease was not acquired");
        refresh.abort();
        assert!(refresh.await.unwrap_err().is_cancelled());

        let mut released = false;
        for _ in 0..100 {
            let owner: Option<String> = redis.query(redis::cmd("GET").arg(&lock)).await.unwrap();
            if owner.is_none() {
                released = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(released, "cancelled refresh retained its Redis lease");
        assert!(provider.account_state(account, &redis).await.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // A delayed cleanup from an expired owner must leave a successor lease intact.
        let successor = Uuid::new_v4().to_string();
        let _: Option<String> = redis
            .query(
                redis::cmd("SET")
                    .arg(&lock)
                    .arg(&successor)
                    .arg("PX")
                    .arg(REFRESH_LOCK_MS)
                    .arg("NX"),
            )
            .await
            .unwrap();
        release_refresh_lock(&redis, &lock, "expired-owner")
            .await
            .unwrap();
        let current_owner: Option<String> =
            redis.query(redis::cmd("GET").arg(&lock)).await.unwrap();
        assert_eq!(current_owner.as_deref(), Some(successor.as_str()));
        server.abort();
        let mut cursor = 0u64;
        loop {
            let (next, keys): (u64, Vec<String>) = redis
                .query(
                    redis::cmd("SCAN")
                        .arg(cursor)
                        .arg("MATCH")
                        .arg(format!("{namespace}:*")),
                )
                .await
                .unwrap();
            if !keys.is_empty() {
                let _: i32 = redis.query(redis::cmd("DEL").arg(keys)).await.unwrap();
            }
            if next == 0 {
                break;
            }
            cursor = next;
        }
    }
}
