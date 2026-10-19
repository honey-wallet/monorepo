//! Public Polymarket catalog with a bounded shared cache. No trading capability.
use std::{sync::Arc, time::Duration};

use crate::error::AppError;
use axum::{
    Json, Router,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};

const MAX_UPSTREAM_BYTES: usize = 1024 * 1024;
const UPSTREAM_PAGE_SIZE: usize = 100;
const MAX_CATALOG_PAGES: usize = 10;
const MAX_CATALOG_MARKETS: usize = UPSTREAM_PAGE_SIZE * MAX_CATALOG_PAGES;
const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
const FRESH_MS: u64 = 30_000;
const STALE_MS: u64 = 300_000;
const CACHE_TTL_SECONDS: usize = 300;
// Keep these maxima aligned with Config::validate and the fixed reqwest client
// timeout below; the TTL regression test makes that relationship explicit.
const MAX_DEPENDENCY_TIMEOUT_MS: usize = 10_000;
const UPSTREAM_TIMEOUT_MS: usize = 4_000;
const MAX_GATE_ATTEMPTS: usize = 2;
const MAX_ADMISSION_WAIT_MS: usize = 1_000;
const CATALOG_LOCK_MARGIN_MS: usize = 16_000;
const BOOK_LOCK_MARGIN_MS: usize = 25_000;
// A refresh may walk ten upstream pages, publish the snapshot, then release the
// lease. Cover both bounded Redis calls so replicas cannot overlap full walks.
const LOCK_TTL_MS: usize = MAX_CATALOG_PAGES * UPSTREAM_TIMEOUT_MS
    + 2 * MAX_DEPENDENCY_TIMEOUT_MS
    + CATALOG_LOCK_MARGIN_MS;
const WAITER_MS: u64 = 1_000;
const BOOK_FRESH_MS: u64 = 10_000;
const BOOK_STALE_MS: u64 = 60_000;
const BOOK_CACHE_TTL_SECONDS: usize = 60;
// Order-book refresh can make two Redis admission calls (each bounded by the
// 10s dependency timeout), wait up to 1s between them, fetch for up to 4s, and
// publish to Redis (another bounded call). This lease covers that upper bound
// with margin; publication is separately fenced by the lock owner.
const BOOK_LOCK_TTL_MS: usize = MAX_GATE_ATTEMPTS * MAX_DEPENDENCY_TIMEOUT_MS
    + MAX_ADMISSION_WAIT_MS
    + UPSTREAM_TIMEOUT_MS
    + MAX_DEPENDENCY_TIMEOUT_MS
    + BOOK_LOCK_MARGIN_MS;
const MAX_BOOK_BYTES: usize = 512 * 1024;
const MAX_BOOK_LEVELS: usize = 500;
const BOOK_GATE: &str = include_str!("../scripts/provider_read_gate.lua");
const CACHE_PUBLISH: &str = include_str!("../scripts/polymarket_cache_publish.lua");

#[derive(Clone)]
pub struct PolymarketCatalogService {
    redis: crate::redis_store::RedisStore,
    client: reqwest::Client,
    upstream: String,
    book_upstream: String,
    local: Arc<RwLock<Option<CacheEntry>>>,
    refresh: Arc<Mutex<()>>,
}

impl PolymarketCatalogService {
    pub fn new(redis: crate::redis_store::RedisStore) -> Self {
        Self::with_upstream(redis, "https://gamma-api.polymarket.com/markets/keyset")
    }

    /// Custom endpoint is exposed for deterministic loopback integration tests.
    pub fn with_upstream(
        redis: crate::redis_store::RedisStore,
        upstream: impl Into<String>,
    ) -> Self {
        Self::with_upstreams(redis, upstream, "https://clob.polymarket.com/book")
    }

    pub fn with_upstreams(
        redis: crate::redis_store::RedisStore,
        upstream: impl Into<String>,
        book_upstream: impl Into<String>,
    ) -> Self {
        Self {
            redis,
            client: reqwest::Client::builder()
                .timeout(Duration::from_millis(UPSTREAM_TIMEOUT_MS as u64))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client configuration is static and valid"),
            upstream: upstream.into(),
            book_upstream: book_upstream.into(),
            local: Arc::new(RwLock::new(None)),
            refresh: Arc::new(Mutex::new(())),
        }
    }

    fn cache_key(&self) -> String {
        self.redis.key("polymarket", "catalog:v2:bounded-pages")
    }

    fn lock_key(&self) -> String {
        self.redis.key("polymarket", "catalog:v2:refresh-lock")
    }

    fn book_cache_key(&self, token_id: &str) -> String {
        let hash = hex::encode(Sha256::digest(token_id.as_bytes()));
        self.redis.key("polymarket", &format!("book:v1:{hash}"))
    }

    async fn order_book(&self, token_id: &str) -> Result<OrderBookResponse, BookError> {
        if !valid_provider_id(token_id) {
            return Err(BookError::InvalidToken);
        }
        // Only query the CLOB for an active, open-book token returned by our
        // canonical Gamma page; arbitrary caller input never reaches upstream.
        let catalog = self
            .catalog(MAX_CATALOG_MARKETS)
            .await
            .map_err(|_| BookError::Unavailable)?;
        let market = catalog
            .markets
            .iter()
            .find(|market| {
                market.active
                    && !market.closed
                    && market.order_book_enabled
                    && market.outcome_token_ids.iter().any(|id| id == token_id)
            })
            .ok_or(BookError::InvalidToken)?;
        let expected_market = market
            .condition_id
            .as_deref()
            .ok_or(BookError::InvalidToken)?;

        let key = self.book_cache_key(token_id);
        let cached = self.read_book_cache(&key, token_id, expected_market).await;
        if let Some(entry) = cached.as_ref().ok().and_then(|entry| entry.as_ref())
            && entry.age_ms() <= BOOK_FRESH_MS
        {
            return Ok(entry.response());
        }
        let stale = cached
            .ok()
            .flatten()
            .filter(|entry| entry.age_ms() <= BOOK_STALE_MS);

        // Redis NX is the cross-process single-flight guard. Waiters re-read once;
        // no token-dependent key is created until it has passed catalog membership.
        let lock_key = self.redis.key(
            "polymarket",
            &format!(
                "book:v1:refresh:{}",
                hex::encode(Sha256::digest(token_id.as_bytes()))
            ),
        );
        let owner = uuid::Uuid::new_v4().to_string();
        let lease: Option<String> = match self
            .redis
            .query(
                redis::cmd("SET")
                    .arg(&lock_key)
                    .arg(&owner)
                    .arg("PX")
                    .arg(BOOK_LOCK_TTL_MS)
                    .arg("NX"),
            )
            .await
        {
            Ok(lease) => lease,
            Err(_) => {
                return stale
                    .map(|entry| Ok(entry.response()))
                    .unwrap_or(Err(BookError::Unavailable));
            }
        };
        if lease.is_none() {
            tokio::time::sleep(Duration::from_millis(150)).await;
            if let Some(entry) = self
                .read_book_cache(&key, token_id, expected_market)
                .await
                .ok()
                .flatten()
            {
                if entry.age_ms() <= BOOK_FRESH_MS {
                    return Ok(entry.response());
                }
                if entry.age_ms() <= BOOK_STALE_MS {
                    return Ok(entry.response());
                }
            }
            return stale
                .map(|entry| entry.response())
                .ok_or(BookError::Unavailable);
        }

        if !self.admit_order_book().await {
            self.release_book_lock(&lock_key, &owner).await;
            return stale
                .map(|entry| entry.response())
                .ok_or(BookError::Unavailable);
        }
        let refreshed = self.fetch_order_book(token_id, expected_market).await;
        match refreshed {
            Ok(book) => {
                let entry = BookCacheEntry {
                    fetched_at_ms: now_ms(),
                    book,
                };
                if let Ok(raw) = serde_json::to_string(&entry) {
                    let _: Result<(), _> = self
                        .redis
                        .query(
                            redis::cmd("EVAL")
                                .arg(CACHE_PUBLISH)
                                .arg(2)
                                .arg(&lock_key)
                                .arg(&key)
                                .arg(&owner)
                                .arg(raw)
                                .arg(BOOK_CACHE_TTL_SECONDS),
                        )
                        .await;
                }
                self.release_book_lock(&lock_key, &owner).await;
                Ok(entry.response())
            }
            Err(()) => {
                self.release_book_lock(&lock_key, &owner).await;
                stale
                    .map(|entry| entry.response())
                    .ok_or(BookError::Unavailable)
            }
        }
    }

    async fn release_book_lock(&self, lock_key: &str, owner: &str) {
        let _: Result<i32, _> = self
            .redis
            .query(
                redis::cmd("EVAL")
                    .arg("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end")
                    .arg(1)
                    .arg(lock_key)
                    .arg(owner),
            )
            .await;
    }

    async fn admit_order_book(&self) -> bool {
        for attempt in 0..MAX_GATE_ATTEMPTS {
            let result: Result<(i32, u64), _> = self
                .redis
                .query(
                    redis::cmd("EVAL")
                        .arg(BOOK_GATE)
                        .arg(2)
                        .arg(self.redis.key("provider-read-polymarket-book", "next"))
                        .arg(self.redis.key("provider-read-polymarket-book", "cooldown")),
                )
                .await;
            let Ok((status, wait_ms)) = result else {
                return false;
            };
            if status == 1 {
                return true;
            }
            if status != 0
                || wait_ms > MAX_ADMISSION_WAIT_MS as u64
                || attempt + 1 == MAX_GATE_ATTEMPTS
            {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(wait_ms.max(1))).await;
        }
        false
    }

    async fn read_book_cache(
        &self,
        key: &str,
        token_id: &str,
        expected_market: &str,
    ) -> Result<Option<BookCacheEntry>, ()> {
        let raw: Option<String> = self
            .redis
            .query(redis::cmd("GET").arg(key))
            .await
            .map_err(|_| ())?;
        let Some(raw) = raw else { return Ok(None) };
        let entry: BookCacheEntry = serde_json::from_str(&raw).map_err(|_| ())?;
        if entry.fetched_at_ms > now_ms().saturating_add(5_000)
            || entry.book.asset_id != token_id
            || entry.book.market_id != expected_market
        {
            return Err(());
        }
        let normalized = parse_order_book(
            &serde_json::to_vec(&serde_json::json!({
                "market": entry.book.market_id,
                "asset_id": entry.book.asset_id,
                "timestamp": entry.book.timestamp,
                "hash": entry.book.hash,
                "bids": entry.book.bids,
                "asks": entry.book.asks,
                "min_order_size": entry.book.min_order_size,
                "tick_size": entry.book.tick_size,
                "neg_risk": entry.book.negative_risk,
                "last_trade_price": entry.book.last_trade_price,
            }))
            .map_err(|_| ())?,
            token_id,
            expected_market,
        )?;
        Ok(Some(BookCacheEntry {
            fetched_at_ms: entry.fetched_at_ms,
            book: normalized,
        }))
    }

    async fn fetch_order_book(
        &self,
        token_id: &str,
        expected_market: &str,
    ) -> Result<OrderBook, ()> {
        let response = self
            .client
            .get(&self.book_upstream)
            .query(&[("token_id", token_id)])
            .send()
            .await
            .map_err(|_| ())?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|n| n > MAX_BOOK_BYTES as u64)
        {
            return Err(());
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            if body.len().saturating_add(chunk.len()) > MAX_BOOK_BYTES {
                return Err(());
            }
            body.extend_from_slice(&chunk);
        }
        parse_order_book(&body, token_id, expected_market)
    }

    async fn catalog(&self, limit: usize) -> Result<Catalog, ()> {
        self.catalog_page(limit, 0).await
    }

    async fn catalog_page(&self, limit: usize, offset: usize) -> Result<Catalog, ()> {
        if let Some(entry) = self.local.read().await.as_ref()
            && entry.age_ms() <= FRESH_MS
        {
            return Ok(entry.response(limit, offset));
        }

        // One refresh per process; the Redis lease extends single-flight across replicas.
        let _guard = match tokio::time::timeout(Duration::from_secs(6), self.refresh.lock()).await {
            Ok(guard) => guard,
            Err(_) => return self.local_stale(limit, offset).await.ok_or(()),
        };
        if let Some(entry) = self.local.read().await.as_ref()
            && entry.age_ms() <= FRESH_MS
        {
            return Ok(entry.response(limit, offset));
        }

        let key = self.cache_key();
        let cached_raw: Option<String> = match self.redis.query(redis::cmd("GET").arg(&key)).await {
            Ok(raw) => raw,
            Err(_) => return self.local_stale(limit, offset).await.ok_or(()),
        };
        let redis_entry: Option<CacheEntry> =
            cached_raw.and_then(|raw| serde_json::from_str(&raw).ok());
        if let Some(entry) = redis_entry.as_ref() {
            *self.local.write().await = Some(entry.clone());
            if entry.age_ms() <= FRESH_MS {
                return Ok(entry.response(limit, offset));
            }
        }
        let stale = redis_entry
            .filter(|entry| entry.age_ms() <= STALE_MS)
            .or_else(|| self.local_stale_entry());

        let lock_key = self.lock_key();
        let owner = uuid::Uuid::new_v4().to_string();
        let lease: Option<String> = match self
            .redis
            .query(
                redis::cmd("SET")
                    .arg(&lock_key)
                    .arg(&owner)
                    .arg("PX")
                    .arg(LOCK_TTL_MS)
                    .arg("NX"),
            )
            .await
        {
            Ok(lease) => lease,
            Err(_) => return stale.map(|entry| entry.response(limit, offset)).ok_or(()),
        };
        if lease.is_none() {
            let until = tokio::time::Instant::now() + Duration::from_millis(WAITER_MS);
            while tokio::time::Instant::now() < until {
                tokio::time::sleep(Duration::from_millis(50)).await;
                match self.read_cache().await {
                    Ok(Some(entry)) if entry.age_ms() <= FRESH_MS => {
                        *self.local.write().await = Some(entry.clone());
                        return Ok(entry.response(limit, offset));
                    }
                    Ok(Some(entry)) if entry.age_ms() <= STALE_MS => {
                        return Ok(entry.response(limit, offset));
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            return stale.map(|entry| entry.response(limit, offset)).ok_or(());
        }

        let refreshed = self.fetch_catalog().await;
        if let Ok(entry) = &refreshed {
            *self.local.write().await = Some(entry.clone());
            if let Ok(raw) = serde_json::to_string(entry) {
                // Fence publication: an expired owner must not overwrite a newer
                // replica's cache entry. Local cache still protects this process
                // if Redis goes unhealthy after a successful upstream refresh.
                let _: Result<(), _> = self
                    .redis
                    .query(
                        redis::cmd("EVAL")
                            .arg(CACHE_PUBLISH)
                            .arg(2)
                            .arg(&lock_key)
                            .arg(&key)
                            .arg(&owner)
                            .arg(raw)
                            .arg(CACHE_TTL_SECONDS),
                    )
                    .await;
            }
        }
        let _: Result<i32, _> = self.redis.query(
            redis::cmd("EVAL")
                .arg("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end")
                .arg(1).arg(lock_key).arg(owner),
        ).await;
        match refreshed {
            Ok(entry) => Ok(entry.response(limit, offset)),
            Err(()) => stale.map(|entry| entry.response(limit, offset)).ok_or(()),
        }
    }

    async fn read_cache(&self) -> Result<Option<CacheEntry>, ()> {
        let raw: Option<String> = self
            .redis
            .query(redis::cmd("GET").arg(self.cache_key()))
            .await
            .map_err(|_| ())?;
        Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
    }

    async fn local_stale(&self, limit: usize, offset: usize) -> Option<Catalog> {
        self.local_stale_entry()
            .filter(|entry| entry.age_ms() <= STALE_MS)
            .map(|entry| entry.response(limit, offset))
    }

    fn local_stale_entry(&self) -> Option<CacheEntry> {
        // Kept synchronous via try_read for use in fallback selection while refresh lock is held.
        self.local
            .try_read()
            .ok()
            .and_then(|entry| entry.clone())
            .filter(|entry| entry.age_ms() <= STALE_MS)
    }

    async fn fetch_catalog(&self) -> Result<CacheEntry, ()> {
        let mut cursor: Option<String> = None;
        let mut seen_cursors = std::collections::HashSet::new();
        let mut seen_ids = std::collections::HashSet::new();
        let mut markets = Vec::with_capacity(MAX_CATALOG_MARKETS);
        let mut total_bytes = 0usize;
        let mut source_truncated = false;

        for page_index in 0..MAX_CATALOG_PAGES {
            let mut request = self.client.get(&self.upstream).query(&[
                ("closed", "false"),
                ("limit", UPSTREAM_PAGE_SIZE.to_string().as_str()),
            ]);
            if let Some(after_cursor) = cursor.as_deref() {
                request = request.query(&[("after_cursor", after_cursor)]);
            }
            let response = request.send().await.map_err(|_| ())?;
            if !response.status().is_success()
                || response
                    .content_length()
                    .is_some_and(|length| length > MAX_UPSTREAM_BYTES as u64)
            {
                return Err(());
            }
            let remaining = MAX_CATALOG_BYTES.saturating_sub(total_bytes);
            if remaining == 0 {
                return Err(());
            }
            let page_limit = MAX_UPSTREAM_BYTES.min(remaining);
            let mut response = response;
            let mut body = Vec::new();
            loop {
                let chunk = response.chunk().await.map_err(|_| ())?;
                let Some(chunk) = chunk else { break };
                if body.len().saturating_add(chunk.len()) > page_limit {
                    return Err(());
                }
                body.extend_from_slice(&chunk);
            }
            total_bytes = total_bytes.checked_add(body.len()).ok_or(())?;
            let value: Value = serde_json::from_slice(&body).map_err(|_| ())?;
            let rows = value.get("markets").and_then(Value::as_array).ok_or(())?;
            if rows.len() > UPSTREAM_PAGE_SIZE {
                return Err(());
            }
            for row in rows {
                if let Some(market) = parse_market(row)
                    && seen_ids.insert(market.id.clone())
                {
                    if markets.len() == MAX_CATALOG_MARKETS {
                        source_truncated = true;
                        break;
                    }
                    markets.push(market);
                }
            }
            let next = match value.get("next_cursor") {
                None | Some(Value::Null) => None,
                Some(Value::String(next))
                    if !next.is_empty()
                        && next.len() <= 4096
                        && !next.bytes().any(|byte| byte.is_ascii_control()) =>
                {
                    Some(next.clone())
                }
                _ => return Err(()),
            };
            let Some(next) = next else { break };
            if rows.len() != UPSTREAM_PAGE_SIZE || !seen_cursors.insert(next.clone()) {
                return Err(());
            }
            if markets.len() >= MAX_CATALOG_MARKETS || page_index + 1 == MAX_CATALOG_PAGES {
                source_truncated = true;
                break;
            }
            cursor = Some(next);
        }
        Ok(CacheEntry {
            fetched_at_ms: now_ms(),
            markets,
            source_truncated,
        })
    }
}

#[derive(Debug, Deserialize)]
struct CatalogQuery {
    limit: Option<usize>,
    cursor: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    fetched_at_ms: u64,
    markets: Vec<Market>,
    #[serde(default)]
    source_truncated: bool,
}

impl CacheEntry {
    fn age_ms(&self) -> u64 {
        // A replica clock behind the writer must not turn old shared-cache data
        // into a fresh entry. Treat future timestamps as beyond the stale window.
        let now = now_ms();
        if self.fetched_at_ms > now {
            STALE_MS.saturating_add(1)
        } else {
            now - self.fetched_at_ms
        }
    }
    fn response(&self, limit: usize, offset: usize) -> Catalog {
        let age_ms = self.age_ms();
        let markets = self
            .markets
            .iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let end = offset.saturating_add(markets.len());
        Catalog {
            schema_version: 1,
            execution_available: false,
            data_status: if age_ms <= FRESH_MS { "fresh" } else { "stale" },
            fetched_at_ms: self.fetched_at_ms,
            age_ms,
            source_truncated: self.source_truncated,
            next_cursor: (end < self.markets.len()).then(|| end.to_string()),
            markets,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u8,
    execution_available: bool,
    data_status: &'static str,
    fetched_at_ms: u64,
    age_ms: u64,
    source_truncated: bool,
    next_cursor: Option<String>,
    markets: Vec<Market>,
}

#[derive(Debug)]
enum BookError {
    InvalidToken,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BookLevel {
    price: String,
    size: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrderBook {
    market_id: String,
    asset_id: String,
    timestamp: String,
    hash: String,
    bids: Vec<BookLevel>,
    asks: Vec<BookLevel>,
    min_order_size: String,
    tick_size: String,
    negative_risk: bool,
    last_trade_price: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookCacheEntry {
    fetched_at_ms: u64,
    book: OrderBook,
}

impl BookCacheEntry {
    fn age_ms(&self) -> u64 {
        let provider_sample_ms = self
            .book
            .timestamp
            .parse::<u64>()
            .unwrap_or(0)
            .saturating_mul(1000);
        now_ms()
            .saturating_sub(self.fetched_at_ms)
            .max(now_ms().saturating_sub(provider_sample_ms))
    }
    fn response(&self) -> OrderBookResponse {
        OrderBookResponse {
            schema_version: 1,
            execution_available: false,
            data_status: if self.age_ms() <= BOOK_FRESH_MS {
                "fresh"
            } else {
                "stale"
            },
            fetched_at_ms: self.fetched_at_ms,
            age_ms: self.age_ms(),
            book: self.book.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrderBookResponse {
    schema_version: u8,
    execution_available: bool,
    data_status: &'static str,
    fetched_at_ms: u64,
    age_ms: u64,
    book: OrderBook,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Market {
    id: String,
    slug: Option<String>,
    question: Option<String>,
    condition_id: Option<String>,
    version: Option<String>,
    outcome_token_ids: Vec<String>,
    position_ids: Vec<String>,
    /// Gamma metadata only; does not imply Honey has authenticated or can trade this market.
    #[serde(default)]
    order_book_enabled: bool,
    active: bool,
    closed: bool,
}

pub fn router(service: Option<Arc<PolymarketCatalogService>>) -> Router {
    Router::new()
        .route("/prediction/markets", get(list_markets))
        .route("/prediction/order-book", get(get_order_book))
        .with_state(service)
}

#[derive(Debug, Deserialize)]
struct OrderBookQuery {
    token_id: String,
}

async fn get_order_book(
    State(service): State<Option<Arc<PolymarketCatalogService>>>,
    query: Result<Query<OrderBookQuery>, QueryRejection>,
) -> Result<Response, AppError> {
    let Query(query) =
        query.map_err(|_| AppError::BadRequest("invalid query parameters".into()))?;
    let Some(service) = service else {
        return Ok((StatusCode::SERVICE_UNAVAILABLE, Json(book_error_body())).into_response());
    };
    match service.order_book(&query.token_id).await {
        Ok(book) => Ok((StatusCode::OK, Json(book)).into_response()),
        Err(BookError::InvalidToken) => Ok((
            StatusCode::NOT_FOUND,
            Json(BookErrorBody {
                error: BookErrorDetail {
                    code: "market_token_unavailable",
                    message: "Token is not in the active public market catalog",
                },
            }),
        )
            .into_response()),
        Err(BookError::Unavailable) => {
            Ok((StatusCode::SERVICE_UNAVAILABLE, Json(book_error_body())).into_response())
        }
    }
}

async fn list_markets(
    State(service): State<Option<Arc<PolymarketCatalogService>>>,
    query: Result<Query<CatalogQuery>, QueryRejection>,
) -> Result<Response, AppError> {
    let Query(query) =
        query.map_err(|_| AppError::BadRequest("invalid query parameters".into()))?;
    let Some(service) = service else {
        return Ok((StatusCode::SERVICE_UNAVAILABLE, Json(error_body())).into_response());
    };
    let limit = query.limit.unwrap_or(20).clamp(1, UPSTREAM_PAGE_SIZE);
    let offset = query.cursor.unwrap_or(0);
    if offset >= MAX_CATALOG_MARKETS {
        return Err(AppError::BadRequest("invalid catalog cursor".into()));
    }
    match service.catalog_page(limit, offset).await {
        Ok(catalog) => Ok((StatusCode::OK, Json(catalog)).into_response()),
        Err(()) => Ok((StatusCode::SERVICE_UNAVAILABLE, Json(error_body())).into_response()),
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}
#[derive(Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: &'static str,
}
fn error_body() -> ErrorBody {
    ErrorBody {
        error: ErrorDetail {
            code: "catalog_unavailable",
            message: "Polymarket catalog is temporarily unavailable",
        },
    }
}

#[derive(Serialize)]
struct BookErrorBody {
    error: BookErrorDetail,
}
#[derive(Serialize)]
struct BookErrorDetail {
    code: &'static str,
    message: &'static str,
}
fn book_error_body() -> BookErrorBody {
    BookErrorBody {
        error: BookErrorDetail {
            code: "order_book_unavailable",
            message: "Polymarket order book is temporarily unavailable",
        },
    }
}

fn parse_order_book(body: &[u8], token_id: &str, expected_market: &str) -> Result<OrderBook, ()> {
    let value: Value = serde_json::from_slice(body).map_err(|_| ())?;
    let market_id = bounded_id(value.get("market").and_then(Value::as_str), 128)?;
    if market_id != expected_market {
        return Err(());
    }
    let asset_id = bounded_id(value.get("asset_id").and_then(Value::as_str), 256)?;
    if asset_id != token_id {
        return Err(());
    }
    let timestamp = value.get("timestamp").and_then(Value::as_str).ok_or(())?;
    if timestamp.is_empty()
        || timestamp.len() > 32
        || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(());
    }
    let provider_timestamp = timestamp.parse::<u64>().map_err(|_| ())?;
    let provider_timestamp_ms = provider_timestamp.saturating_mul(1000);
    if provider_timestamp > now_ms() / 1000 + 300
        || now_ms().saturating_sub(provider_timestamp_ms) > BOOK_STALE_MS
    {
        return Err(());
    }
    let hash = bounded_id(value.get("hash").and_then(Value::as_str), 128)?;
    let bids = parse_levels(value.get("bids"), true)?;
    let asks = parse_levels(value.get("asks"), false)?;
    let min_order_size = bounded_decimal(
        value.get("min_order_size").and_then(Value::as_str),
        1e15,
        false,
    )?;
    let tick_size = bounded_decimal(value.get("tick_size").and_then(Value::as_str), 1.0, false)?;
    let last_trade_price = bounded_decimal(
        value.get("last_trade_price").and_then(Value::as_str),
        1.0,
        true,
    )?;
    let negative_risk = value.get("neg_risk").and_then(Value::as_bool).ok_or(())?;
    Ok(OrderBook {
        market_id,
        asset_id,
        timestamp: timestamp.to_owned(),
        hash,
        bids,
        asks,
        min_order_size,
        tick_size,
        negative_risk,
        last_trade_price,
    })
}

fn parse_levels(value: Option<&Value>, descending: bool) -> Result<Vec<BookLevel>, ()> {
    let values = value.and_then(Value::as_array).ok_or(())?;
    if values.len() > MAX_BOOK_LEVELS {
        return Err(());
    }
    let mut levels = Vec::with_capacity(values.len());
    let mut previous: Option<String> = None;
    for value in values {
        let price = bounded_decimal(value.get("price").and_then(Value::as_str), 1.0, false)?;
        let size = bounded_decimal(value.get("size").and_then(Value::as_str), 1e15, false)?;
        if let Some(prior) = previous.as_deref() {
            let order = decimal_cmp(&price, prior)?;
            if (descending && order != std::cmp::Ordering::Less)
                || (!descending && order != std::cmp::Ordering::Greater)
            {
                return Err(());
            }
        }
        previous = Some(price.clone());
        levels.push(BookLevel { price, size });
    }
    Ok(levels)
}

fn bounded_decimal(value: Option<&str>, max: f64, allow_zero: bool) -> Result<String, ()> {
    let value = value.ok_or(())?;
    if value.is_empty()
        || value.len() > 64
        || value.bytes().filter(|byte| *byte == b'.').count() > 1
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        || value.starts_with('.')
        || value.ends_with('.')
    {
        return Err(());
    }
    let number = value.parse::<f64>().map_err(|_| ())?;
    if !number.is_finite()
        || number < 0.0
        || decimal_cmp(value, &max.to_string())? == std::cmp::Ordering::Greater
        || (!allow_zero && decimal_cmp(value, "0")? == std::cmp::Ordering::Equal)
    {
        return Err(());
    }
    Ok(value.to_owned())
}

fn decimal_cmp(left: &str, right: &str) -> Result<std::cmp::Ordering, ()> {
    fn parts(value: &str) -> Result<(String, String), ()> {
        let mut split = value.split('.');
        let integer = split.next().ok_or(())?;
        let fraction = split.next().unwrap_or("");
        if split.next().is_some()
            || integer.is_empty()
            || !integer.bytes().all(|b| b.is_ascii_digit())
            || !fraction.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(());
        }
        let integer = integer.trim_start_matches('0');
        Ok((
            if integer.is_empty() { "0" } else { integer }.to_owned(),
            fraction.trim_end_matches('0').to_owned(),
        ))
    }
    let (li, lf) = parts(left)?;
    let (ri, rf) = parts(right)?;
    let integer_order = li.len().cmp(&ri.len()).then_with(|| li.cmp(&ri));
    if integer_order != std::cmp::Ordering::Equal {
        return Ok(integer_order);
    }
    let width = lf.len().max(rf.len());
    let left_fraction = format!("{lf:0<width$}");
    let right_fraction = format!("{rf:0<width$}");
    Ok(left_fraction.cmp(&right_fraction))
}

fn bounded_id(value: Option<&str>, max: usize) -> Result<String, ()> {
    let value = value.ok_or(())?;
    if value.is_empty() || value.len() > max || !valid_provider_id(value) {
        return Err(());
    }
    Ok(value.to_owned())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn parse_market(value: &Value) -> Option<Market> {
    let id = value.get("id")?.as_str()?.to_owned();
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return None;
    }
    let tokens = parse_provider_ids(value.get("clobTokenIds"))?;
    let positions = parse_provider_ids(value.get("positionIds"))?;
    // Gamma exposes token identifiers as either a JSON-encoded string or an array.
    // Never silently discard malformed members or truncate a market's outcomes: doing so
    // could make a displayed outcome map to the wrong CLOB token.
    if tokens.len() > 8
        || positions.len() > 8
        || tokens.iter().any(|id| !valid_provider_id(id))
        || positions.iter().any(|id| !valid_provider_id(id))
    {
        return None;
    }
    if let Some(version) = value.get("version").and_then(Value::as_str)
        && !matches!(version, "v1" | "v2")
    {
        return None;
    }
    Some(Market {
        id,
        slug: optional_text(value, "slug", 256)?,
        question: optional_text(value, "question", 2048)?,
        condition_id: optional_text(value, "conditionId", 128)?,
        version: optional_text(value, "version", 8)?,
        outcome_token_ids: tokens,
        position_ids: positions,
        order_book_enabled: value
            .get("enableOrderBook")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        active: value.get("active").and_then(Value::as_bool).unwrap_or(true),
        closed: value
            .get("closed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn optional_text(value: &Value, field: &str, max_bytes: usize) -> Option<Option<String>> {
    match value.get(field) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text))
            if text.len() <= max_bytes && !text.chars().any(char::is_control) =>
        {
            Some(Some(text.clone()))
        }
        _ => None,
    }
}

fn parse_provider_ids(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Some(Vec::new());
    };
    let ids: Vec<String> = match value {
        Value::String(encoded) => serde_json::from_str(encoded).ok()?,
        Value::Array(items) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<_>>()?,
        _ => return None,
    };
    Some(ids)
}

fn valid_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Config;

    #[test]
    fn shared_refresh_leases_cover_the_configured_work_bounds() {
        let catalog_bound = MAX_CATALOG_PAGES * UPSTREAM_TIMEOUT_MS + 2 * MAX_DEPENDENCY_TIMEOUT_MS;
        let book_bound = MAX_GATE_ATTEMPTS * MAX_DEPENDENCY_TIMEOUT_MS
            + MAX_ADMISSION_WAIT_MS
            + UPSTREAM_TIMEOUT_MS
            + MAX_DEPENDENCY_TIMEOUT_MS;
        assert!(LOCK_TTL_MS > catalog_bound);
        assert!(BOOK_LOCK_TTL_MS > book_bound);
        assert_eq!(LOCK_TTL_MS, 76_000);
        assert_eq!(BOOK_LOCK_TTL_MS, 60_000);
        assert!(LOCK_TTL_MS - catalog_bound >= CATALOG_LOCK_MARGIN_MS);
        assert!(BOOK_LOCK_TTL_MS - book_bound >= BOOK_LOCK_MARGIN_MS);
        assert!(
            Config {
                dependency_timeout_ms: MAX_DEPENDENCY_TIMEOUT_MS as u64,
                ..Config::default()
            }
            .validate()
            .is_ok()
        );
        assert!(
            Config {
                dependency_timeout_ms: MAX_DEPENDENCY_TIMEOUT_MS as u64 + 1,
                ..Config::default()
            }
            .validate()
            .is_err()
        );
    }
    #[test]
    fn parses_v1_and_v2_outcome_identifiers() {
        let v1 = parse_market(&serde_json::json!({"id":"703257","version":"v1","clobTokenIds":"[\"yes-id\",\"no-id\"]"})).unwrap();
        assert_eq!(v1.version.as_deref(), Some("v1"));
        assert_eq!(v1.outcome_token_ids, ["yes-id", "no-id"]);
        let v2 = parse_market(&serde_json::json!({"id":"1","version":"v2","clobTokenIds":null,"positionIds":["yes-position","no-position"]})).unwrap();
        assert_eq!(v2.position_ids, ["yes-position", "no-position"]);
        assert!(!v1.order_book_enabled);
    }

    #[test]
    fn exposes_gamma_orderbook_flag_as_metadata_only() {
        let market = parse_market(&serde_json::json!({
            "id":"3", "enableOrderBook":true, "active":true, "closed":false,
            "clobTokenIds":["12345678901234567890"]
        }))
        .unwrap();
        assert!(market.order_book_enabled);
        // The response-level execution invariant remains independent of Gamma metadata.
        let catalog = CacheEntry {
            fetched_at_ms: now_ms(),
            markets: vec![market],
            source_truncated: false,
        }
        .response(10, 0);
        assert!(!catalog.execution_available);
    }

    #[test]
    fn rejects_incomplete_or_ambiguous_outcome_identifier_sets() {
        assert!(parse_market(&serde_json::json!({"id":"m","clobTokenIds":["yes",7]})).is_none());
        assert!(parse_market(&serde_json::json!({"id":"m","clobTokenIds":"not-json"})).is_none());
        assert!(parse_market(&serde_json::json!({"id":"m","clobTokenIds":["yes","no","third","fourth","fifth","sixth","seventh","eighth","ninth"]})).is_none());
        assert!(parse_market(&serde_json::json!({"id":"m","positionIds":["has space"]})).is_none());
        assert!(parse_market(&serde_json::json!({"id":"m","version":"v3"})).is_none());
        assert!(parse_market(&serde_json::json!({"id":"m","question":"x".repeat(2049)})).is_none());
        assert!(parse_market(&serde_json::json!({"id":"m","slug":"bad\nslug"})).is_none());
    }

    #[test]
    fn returns_stale_metadata_and_slices_max_page() {
        let entry = CacheEntry {
            fetched_at_ms: now_ms().saturating_sub(FRESH_MS + 10),
            markets: vec![
                parse_market(&serde_json::json!({"id":"one"})).unwrap(),
                parse_market(&serde_json::json!({"id":"two"})).unwrap(),
            ],
            source_truncated: false,
        };
        let response = entry.response(1, 1);
        assert_eq!(response.data_status, "stale");
        assert_eq!(response.markets.len(), 1);
        assert!(response.next_cursor.is_none());
        assert!(!response.execution_available);
    }

    #[test]
    fn future_catalog_timestamp_is_never_fresh_or_stale() {
        let entry = CacheEntry {
            fetched_at_ms: now_ms().saturating_add(1_000),
            markets: vec![],
            source_truncated: false,
        };
        assert!(entry.age_ms() > STALE_MS);
        assert_eq!(entry.response(10, 0).data_status, "stale");
    }

    fn book_fixture() -> Value {
        let timestamp = now_ms() / 1000;
        serde_json::json!({
            "market":"condition-4", "asset_id":"token-4", "timestamp":timestamp.to_string(), "hash":"abc123",
            "bids":[{"price":"0.45","size":"100"},{"price":"0.44","size":"200"}],
            "asks":[{"price":"0.46","size":"150"},{"price":"0.47","size":"250"}],
            "min_order_size":"1", "tick_size":"0.01", "neg_risk":false, "last_trade_price":"0.45"
        })
    }

    #[test]
    fn parses_book_only_when_token_market_and_sorted_levels_match() {
        let value = book_fixture();
        let parsed = parse_order_book(
            &serde_json::to_vec(&value).unwrap(),
            "token-4",
            "condition-4",
        )
        .unwrap();
        assert_eq!(parsed.bids[0].price, "0.45");
        assert!(
            parse_order_book(
                &serde_json::to_vec(&value).unwrap(),
                "other-token",
                "condition-4"
            )
            .is_err()
        );
        assert!(
            parse_order_book(
                &serde_json::to_vec(&value).unwrap(),
                "token-4",
                "other-condition"
            )
            .is_err()
        );

        let mut unsorted = value.clone();
        unsorted["bids"] =
            serde_json::json!([{"price":"0.44","size":"1"},{"price":"0.45","size":"1"}]);
        assert!(
            parse_order_book(
                &serde_json::to_vec(&unsorted).unwrap(),
                "token-4",
                "condition-4"
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_invalid_decimals_missing_metadata_and_oversized_books() {
        let mut value = book_fixture();
        value["asks"][0]["price"] = serde_json::json!("1.00000000000000001");
        assert!(
            parse_order_book(
                &serde_json::to_vec(&value).unwrap(),
                "token-4",
                "condition-4"
            )
            .is_err()
        );
        let mut value = book_fixture();
        value["bids"][0]["size"] = serde_json::json!("NaN");
        assert!(
            parse_order_book(
                &serde_json::to_vec(&value).unwrap(),
                "token-4",
                "condition-4"
            )
            .is_err()
        );
        let mut value = book_fixture();
        value.as_object_mut().unwrap().remove("tick_size");
        assert!(
            parse_order_book(
                &serde_json::to_vec(&value).unwrap(),
                "token-4",
                "condition-4"
            )
            .is_err()
        );
        let mut value = book_fixture();
        value["timestamp"] = serde_json::json!("1700000000");
        assert!(
            parse_order_book(
                &serde_json::to_vec(&value).unwrap(),
                "token-4",
                "condition-4"
            )
            .is_err()
        );
        assert!(bounded_decimal(Some("1e-3"), 1.0, false).is_err());
        assert_eq!(
            decimal_cmp("0.4501", "0.45").unwrap(),
            std::cmp::Ordering::Greater
        );
        let mut oversized = book_fixture();
        oversized["bids"] = serde_json::Value::Array(
            (0..=MAX_BOOK_LEVELS)
                .map(|index| {
                    serde_json::json!({
                        "price": format!("{:.3}", (1000 - index) as f64 / 1000.0),
                        "size": "1"
                    })
                })
                .collect(),
        );
        assert!(
            parse_order_book(
                &serde_json::to_vec(&oversized).unwrap(),
                "token-4",
                "condition-4"
            )
            .is_err()
        );
    }
}
