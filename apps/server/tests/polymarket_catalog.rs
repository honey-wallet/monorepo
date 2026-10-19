use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::State,
    http::{Request, StatusCode},
    routing::get,
};
use honey_server::redis_store::RedisStore;
use serde_json::Value;
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Clone)]
struct Fixture {
    hits: Arc<AtomicUsize>,
    book_hits: Arc<AtomicUsize>,
    fail: Arc<AtomicBool>,
    pages: Arc<std::sync::Mutex<BTreeMap<String, Value>>>,
}

async fn markets(
    State(fixture): State<Fixture>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<Value>) {
    fixture.hits.fetch_add(1, Ordering::SeqCst);
    if fixture.fail.load(Ordering::SeqCst) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error":"fixture failure"})),
        );
    }
    let cursor = query.get("after_cursor").cloned().unwrap_or_default();
    let page = fixture.pages.lock().unwrap().get(&cursor).cloned();
    match page {
        Some(page) => (StatusCode::OK, Json(page)),
        None => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error":"unknown cursor"})),
        ),
    }
}

async fn book(
    State(fixture): State<Fixture>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<Value>) {
    fixture.book_hits.fetch_add(1, Ordering::SeqCst);
    let token_id = query.get("token_id").cloned().unwrap_or_default();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "market":"condition-4", "asset_id":token_id, "timestamp":(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs().to_string()), "hash":"bookhash",
            "bids":[{"price":"0.45","size":"100"},{"price":"0.44","size":"200"}],
            "asks":[{"price":"0.46","size":"150"},{"price":"0.47","size":"250"}],
            "min_order_size":"1", "tick_size":"0.01", "neg_risk":false, "last_trade_price":"0.45"
        })),
    )
}

async fn fixture() -> (String, Fixture, tokio::task::JoinHandle<()>) {
    let mut pages = BTreeMap::new();
    pages.insert(
        String::new(),
        serde_json::json!({"markets":[
            {"id":"1","version":"v2","positionIds":["yes1","no1"],"active":true,"closed":false},
            {"id":"2","version":"v1","clobTokenIds":"[\"yes2\",\"no2\"]","active":true,"closed":false},
            {"id":"4","conditionId":"condition-4","version":"v1","clobTokenIds":["book-yes"],"enableOrderBook":true,"active":true,"closed":false},
            {"id":"3","active":true,"closed":false}
        ]}),
    );
    let state = Fixture {
        hits: Arc::new(AtomicUsize::new(0)),
        book_hits: Arc::new(AtomicUsize::new(0)),
        fail: Arc::new(AtomicBool::new(false)),
        pages: Arc::new(std::sync::Mutex::new(pages)),
    };
    let app = Router::new()
        .route("/markets/keyset", get(markets))
        .route("/book", get(book))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}/markets/keyset"), state, task)
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
async fn order_book_requires_catalog_token_membership_and_caches_bounded_read_only_data() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = redis(&namespace);
    let (upstream, fixture, task) = fixture().await;
    let book_upstream = upstream.strip_suffix("/markets/keyset").unwrap().to_owned() + "/book";
    let app = Router::new().merge(honey_server::routes::polymarket::router(Some(Arc::new(
        honey_server::routes::polymarket::PolymarketCatalogService::with_upstreams(
            redis.clone(),
            upstream,
            book_upstream,
        ),
    ))));

    let invalid = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/prediction/order-book?token_id=not-in-catalog")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::NOT_FOUND);
    assert_eq!(fixture.book_hits.load(Ordering::SeqCst), 0);

    let read = || {
        app.clone().oneshot(
            Request::builder()
                .uri("/prediction/order-book?token_id=book-yes")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
    };
    let response = read().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["executionAvailable"], false);
    assert_eq!(value["book"]["assetId"], "book-yes");
    assert_eq!(value["book"]["marketId"], "condition-4");
    assert_eq!(value["book"]["bids"][0]["price"], "0.45");
    assert_eq!(fixture.book_hits.load(Ordering::SeqCst), 1);

    let cached = read().await.unwrap();
    assert_eq!(cached.status(), StatusCode::OK);
    assert_eq!(fixture.book_hits.load(Ordering::SeqCst), 1);
    task.abort();
}

fn redis(namespace: &str) -> RedisStore {
    RedisStore::new(
        redis::Client::open(std::env::var("TEST_REDIS_URL").expect("isolated TEST_REDIS_URL"))
            .unwrap(),
        namespace.to_owned(),
        Duration::from_millis(200),
    )
}

async fn request(app: Router, limit: usize) -> (StatusCode, Value) {
    request_cursor(app, limit, None).await
}

async fn request_cursor(app: Router, limit: usize, cursor: Option<usize>) -> (StatusCode, Value) {
    let cursor = cursor
        .map(|cursor| format!("&cursor={cursor}"))
        .unwrap_or_default();
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/prediction/markets?limit={limit}{cursor}"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

fn market_page(start: usize, count: usize, next: Option<&str>) -> Value {
    let markets: Vec<_> = (start..start + count)
        .map(|id| serde_json::json!({"id":format!("market-{id}"),"active":true,"closed":false}))
        .collect();
    match next {
        Some(cursor) => serde_json::json!({"markets":markets,"next_cursor":cursor}),
        None => serde_json::json!({"markets":markets}),
    }
}

fn build_app(redis: RedisStore, upstream: String) -> Router {
    Router::new().merge(honey_server::routes::polymarket::router(Some(Arc::new(
        honey_server::routes::polymarket::PolymarketCatalogService::with_upstream(redis, upstream),
    ))))
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
async fn catalog_walks_keyset_pages_deduplicates_ids_and_exposes_local_page_cursor() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = redis(&namespace);
    let (upstream, fixture, task) = fixture().await;
    {
        let mut pages = fixture.pages.lock().unwrap();
        pages.clear();
        pages.insert(String::new(), market_page(0, 100, Some("cursor-1")));
        let mut second = (0..100)
            .map(|id| serde_json::json!({"id":format!("market-{}", if id == 0 { 0 } else { id + 99 })}))
            .collect::<Vec<_>>();
        second[0] = serde_json::json!({"id":"market-0"});
        pages.insert("cursor-1".into(), serde_json::json!({"markets":second}));
    }
    let app = build_app(redis.clone(), upstream.clone());

    let (status, first) = request_cursor(app.clone(), 100, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["markets"].as_array().unwrap().len(), 100);
    assert_eq!(first["nextCursor"], "100");
    assert_eq!(first["sourceTruncated"], false);

    let (status, second) = request_cursor(app, 100, Some(100)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["markets"].as_array().unwrap().len(), 99);
    assert!(second["nextCursor"].is_null());
    assert_eq!(fixture.hits.load(Ordering::SeqCst), 2);
    cleanup(&redis).await;
    task.abort();
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
async fn repeated_gamma_cursor_fails_closed_without_publishing_partial_catalog() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = redis(&namespace);
    let (upstream, fixture, task) = fixture().await;
    {
        let mut pages = fixture.pages.lock().unwrap();
        pages.clear();
        pages.insert(String::new(), market_page(0, 100, Some("loop")));
        pages.insert("loop".into(), market_page(100, 100, Some("loop")));
    }
    let app = build_app(redis.clone(), upstream);

    let (status, _) = request(app, 100).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(fixture.hits.load(Ordering::SeqCst), 2);
    let cached: Option<String> = redis
        .query(redis::cmd("GET").arg(redis.key("polymarket", "catalog:v2:bounded-pages")))
        .await
        .unwrap();
    assert!(cached.is_none());
    cleanup(&redis).await;
    task.abort();
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
async fn catalog_page_and_market_caps_are_hard_and_report_source_truncation() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = redis(&namespace);
    let (upstream, fixture, task) = fixture().await;
    {
        let mut pages = fixture.pages.lock().unwrap();
        pages.clear();
        for index in 0..10 {
            let cursor = (index + 1 < 10).then(|| format!("cursor-{index}"));
            pages.insert(
                if index == 0 {
                    String::new()
                } else {
                    format!("cursor-{}", index - 1)
                },
                market_page(index * 100, 100, cursor.as_deref()),
            );
        }
    }
    let app = build_app(redis.clone(), upstream.clone());

    let (status, catalog) = request(app.clone(), 100).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fixture.hits.load(Ordering::SeqCst), 10);
    assert_eq!(catalog["sourceTruncated"], false);

    cleanup(&redis).await;
    {
        let mut pages = fixture.pages.lock().unwrap();
        pages.insert("cursor-8".into(), market_page(1000, 100, Some("cursor-10")));
    }
    let (status, catalog) = request(build_app(redis.clone(), upstream), 100).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(catalog["sourceTruncated"], true);
    assert_eq!(fixture.hits.load(Ordering::SeqCst), 20);
    cleanup(&redis).await;
    task.abort();
}

async fn cleanup(redis: &RedisStore) {
    let _: i32 = redis
        .query(
            redis::cmd("DEL")
                .arg(redis.key("polymarket", "catalog:v2:bounded-pages"))
                .arg(redis.key("polymarket", "catalog:v2:refresh-lock")),
        )
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
async fn concurrent_cold_requests_across_service_instances_fetch_one_canonical_page() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = redis(&namespace);
    let (upstream, fixture, task) = fixture().await;
    let apps: Vec<_> = (0..20)
        .map(|_| {
            Router::new().merge(honey_server::routes::polymarket::router(Some(Arc::new(
                honey_server::routes::polymarket::PolymarketCatalogService::with_upstream(
                    redis.clone(),
                    upstream.clone(),
                ),
            ))))
        })
        .collect();
    let results = futures_util::future::join_all(
        apps.into_iter()
            .enumerate()
            .map(|(n, app)| request(app, if n % 2 == 0 { 1 } else { 100 })),
    )
    .await;
    assert!(
        results
            .iter()
            .all(|(status, body)| *status == StatusCode::OK
                && body["executionAvailable"] == false
                && body["dataStatus"] == "fresh")
    );
    assert_eq!(
        fixture.hits.load(Ordering::SeqCst),
        1,
        "distributed cold-cache lease must coalesce upstream requests"
    );
    assert!(
        results
            .iter()
            .any(|(_, body)| body["markets"].as_array().unwrap().len() == 1)
    );
    assert!(
        results
            .iter()
            .any(|(_, body)| body["markets"].as_array().unwrap().len() == 4)
    );
    cleanup(&redis).await;
    task.abort();
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
async fn stale_shared_cache_is_identified_when_upstream_fails() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = redis(&namespace);
    let (upstream, fixture, task) = fixture().await;
    fixture.fail.store(true, Ordering::SeqCst);
    let fetched_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - 60_000;
    let cached = serde_json::json!({"fetchedAtMs":fetched_at_ms,"markets":[{"id":"cached","slug":null,"question":null,"conditionId":null,"version":null,"outcomeTokenIds":[],"positionIds":[],"active":true,"closed":false}]});
    let _: String = redis
        .query(
            redis::cmd("SET")
                .arg(redis.key("polymarket", "catalog:v2:bounded-pages"))
                .arg(cached.to_string())
                .arg("EX")
                .arg(300),
        )
        .await
        .unwrap();
    let app = Router::new().merge(honey_server::routes::polymarket::router(Some(Arc::new(
        honey_server::routes::polymarket::PolymarketCatalogService::with_upstream(
            redis.clone(),
            upstream,
        ),
    ))));
    let (status, body) = request(app, 10).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["dataStatus"], "stale");
    assert_eq!(body["markets"][0]["id"], "cached");
    assert_eq!(fixture.hits.load(Ordering::SeqCst), 1);
    cleanup(&redis).await;
    task.abort();
}

#[tokio::test]
#[ignore = "requires loopback sockets"]
async fn cold_redis_failure_returns_service_error_without_gamma_fanout() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let redis = RedisStore::new(
        redis::Client::open(format!("redis://{address}")).unwrap(),
        "test:unavailable".into(),
        Duration::from_millis(50),
    );
    let (upstream, fixture, task) = fixture().await;
    let app = Router::new().merge(honey_server::routes::polymarket::router(Some(Arc::new(
        honey_server::routes::polymarket::PolymarketCatalogService::with_upstream(redis, upstream),
    ))));
    let results = futures_util::future::join_all((0..8).map(|_| request(app.clone(), 20))).await;
    assert!(
        results
            .iter()
            .all(|(status, _)| *status == StatusCode::SERVICE_UNAVAILABLE)
    );
    assert_eq!(
        fixture.hits.load(Ordering::SeqCst),
        0,
        "Redis outage must not fall through to Gamma"
    );
    drop(listener);
    task.abort();
}
