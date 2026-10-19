use axum::{Json, Router, body::Body, extract::State, http::Response, routing::post};
use honey_server::{
    metrics::Metrics,
    providers::{
        evm_rpc::{EvmReadRpc, RpcError},
        rpc_budget::{RpcBudget, RpcBudgetConfig},
    },
    redis_store::RedisStore,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
struct Upstream {
    mode: Arc<AtomicUsize>,
    arrivals: Arc<Mutex<Vec<Instant>>>,
}
async fn respond(State(s): State<Upstream>, Json(v): Json<Value>) -> Response<Body> {
    s.arrivals.lock().unwrap().push(Instant::now());
    let mode = s.mode.load(Ordering::Relaxed);
    if mode == 1 || mode == 2 || mode == 3 {
        return Response::builder()
            .status(if mode == 3 { 503 } else { 429 })
            .header(
                "retry-after",
                if mode == 2 {
                    "invalid-private-value"
                } else if mode == 3 {
                    "1"
                } else {
                    "604800"
                },
            )
            .body(Body::from("private-provider-error"))
            .unwrap();
    }
    if mode == 5 {
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    if mode == 6 {
        return Response::builder()
            .status(302)
            .header("location", "/redirected")
            .body(Body::empty())
            .unwrap();
    }
    if mode == 7 {
        return Response::new(Body::from(vec![b'x'; 256 * 1024 + 1]));
    }
    let body = match mode {
        4 => {
            json!({"jsonrpc":"2.0", "id":1, "error":{"code":-32005,"message":"private-provider-error"}})
        }
        8 => json!({"jsonrpc":"2.0", "id":2, "result":"0x1"}),
        9 => {
            json!({"jsonrpc":"2.0", "id":1, "result":"0x1", "error":{"code":-32000,"message":"private-provider-error"}})
        }
        _ => json!({"jsonrpc":"2.0", "id":v["id"], "result":"0x1"}),
    };
    Response::new(Body::from(body.to_string()))
}
struct Fixture {
    url: String,
    upstream: Upstream,
    redis: RedisStore,
    metrics: Arc<Metrics>,
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/private-endpoint-key",
            listener.local_addr().unwrap()
        );
        let upstream = Upstream::default();
        let app = Router::new()
            .route("/private-endpoint-key", post(respond))
            .route("/redirected", post(respond))
            .with_state(upstream.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let redis = RedisStore::new(
            redis::Client::open(std::env::var("TEST_REDIS_URL").expect("isolated Redis required"))
                .unwrap(),
            format!("rpc-test:{}", uuid::Uuid::new_v4()),
            Duration::from_millis(500),
        );
        Self {
            url,
            upstream,
            redis,
            metrics: Arc::new(Metrics::default()),
            server,
        }
    }
    fn client(&self, interval: u64, simulation_cost: u16) -> EvmReadRpc {
        EvmReadRpc::with_budget(
            &self.url,
            RpcBudget::new(self.redis.clone(), config(interval, simulation_cost)).unwrap(),
            self.metrics.clone(),
        )
        .unwrap()
    }
    async fn clear(&self) {
        let _: i32 = self
            .redis
            .query(
                redis::cmd("DEL")
                    .arg(self.redis.key("rpc-budget-test", "policy"))
                    .arg(self.redis.key("rpc-budget-test", "next"))
                    .arg(self.redis.key("rpc-budget-test", "cooldown")),
            )
            .await
            .unwrap();
    }
    fn hits(&self) -> usize {
        self.upstream.arrivals.lock().unwrap().len()
    }
    async fn close(self) {
        self.clear().await;
        self.server.abort();
        let _ = self.server.await;
    }
}
fn config(interval_ms: u64, simulation_cost: u16) -> RpcBudgetConfig {
    RpcBudgetConfig {
        scope: "test".into(),
        interval_ms,
        simulation_cost,
    }
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
async fn independent_clients_share_weighted_spacing_and_reject_configuration_drift() {
    let f = Fixture::new().await;
    let a = f.client(100, 4);
    let b = f.client(100, 4);
    let results = futures_util::future::join_all((0..6).map(|i| {
        if i % 2 == 0 {
            a.chain_id()
        } else {
            b.chain_id()
        }
    }))
    .await;
    assert!(results.iter().all(Result::is_ok));
    let arrivals = f.upstream.arrivals.lock().unwrap().clone();
    for pair in arrivals.windows(2) {
        assert!(pair[1].duration_since(pair[0]) >= Duration::from_millis(80));
    }
    a.simulate(vec![], "latest").await.unwrap();
    b.chain_id().await.unwrap();
    let arrivals = f.upstream.arrivals.lock().unwrap().clone();
    assert!(arrivals[7].duration_since(arrivals[6]) >= Duration::from_millis(380));
    let before = f.hits();
    assert_eq!(
        f.client(1, 4).chain_id().await.unwrap_err(),
        RpcError::Configuration
    );
    assert_eq!(
        f.client(100, 1).chain_id().await.unwrap_err(),
        RpcError::Configuration
    );
    assert_eq!(f.hits(), before);
    let encoded = f.metrics.encode().unwrap();
    assert!(encoded.contains("provider=\"evm_rpc\""));
    assert!(encoded.contains("outcome=\"configuration\""));
    assert!(!encoded.contains("private-"));
    f.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
async fn http_and_rpc_limits_share_durable_cooldowns_without_retries() {
    let f = Fixture::new().await;
    for mode in [1, 2, 3, 4] {
        f.clear().await;
        f.upstream.mode.store(mode, Ordering::Relaxed);
        let a = f.client(1, 1);
        let b = f.client(1, 1);
        assert_eq!(
            a.chain_id().await.unwrap_err(),
            if mode == 3 {
                RpcError::Unavailable
            } else {
                RpcError::CoolingDown
            }
        );
        let before = f.hits();
        f.upstream.mode.store(0, Ordering::Relaxed);
        assert_eq!(b.chain_id().await.unwrap_err(), RpcError::CoolingDown);
        assert_eq!(f.hits(), before);
        let ttl: i64 = f
            .redis
            .query(redis::cmd("PTTL").arg(f.redis.key("rpc-budget-test", "cooldown")))
            .await
            .unwrap();
        assert!(match mode {
            1 => ttl > 604_790_000,
            2 => ttl == -1,
            _ => ttl > 9000,
        });
    }
    f.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
async fn cancellation_does_not_refund_units_and_outage_never_bypasses_admission() {
    let f = Fixture::new().await;
    let a = f.client(100, 100);
    let b = f.client(100, 100);
    f.upstream.mode.store(5, Ordering::Relaxed);
    assert!(
        tokio::time::timeout(Duration::from_millis(200), a.simulate(vec![], "latest"))
            .await
            .is_err()
    );
    assert_eq!(f.hits(), 1);
    assert_eq!(b.chain_id().await.unwrap_err(), RpcError::Busy);
    assert_eq!(f.hits(), 1);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed = listener.local_addr().unwrap();
    drop(listener);
    let redis = RedisStore::new(
        redis::Client::open(format!("redis://{closed}")).unwrap(),
        "unavailable".into(),
        Duration::from_millis(100),
    );
    let unavailable = EvmReadRpc::with_budget(
        &f.url,
        RpcBudget::new(redis, config(1, 1)).unwrap(),
        f.metrics.clone(),
    )
    .unwrap();
    assert_eq!(unavailable.chain_id().await.unwrap_err(), RpcError::Busy);
    assert_eq!(f.hits(), 1);
    f.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
async fn local_concurrency_and_response_bounds_apply_before_any_retry() {
    let f = Fixture::new().await;
    let a = f.client(1, 1);
    f.upstream.mode.store(5, Ordering::Relaxed);
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let c = a.clone();
        tasks.push(tokio::spawn(async move { c.chain_id().await }));
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while f.hits() < 4 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(a.chain_id().await.unwrap_err(), RpcError::Busy);
    assert_eq!(f.hits(), 4);
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    for mode in 6..=9 {
        f.upstream.mode.store(mode, Ordering::Relaxed);
        let before = f.hits();
        assert_eq!(
            a.chain_id().await.unwrap_err(),
            if mode == 6 {
                RpcError::Unavailable
            } else {
                RpcError::InvalidResponse
            }
        );
        assert_eq!(f.hits(), before + 1);
    }
    f.close().await;
}

#[test]
fn budget_configuration_is_explicit_and_scope_cannot_inject_redis_keys() {
    let redis = RedisStore::new(
        redis::Client::open("redis://127.0.0.1:1").unwrap(),
        "unused".into(),
        Duration::from_millis(50),
    );
    for (interval, cost) in [(0, 1), (60_001, 1), (1, 0), (1, 1001)] {
        assert!(RpcBudget::new(redis.clone(), config(interval, cost)).is_err());
    }
    for scope in ["", "a{b}", "A", "secret/key", "two words"] {
        let mut c = config(1, 1);
        c.scope = scope.into();
        assert!(RpcBudget::new(redis.clone(), c).is_err());
    }
    let budget = RpcBudget::new(redis, config(100, 10)).unwrap();
    assert!(
        EvmReadRpc::with_budget(
            "https://example.com/private-key",
            budget,
            Arc::new(Metrics::default())
        )
        .is_ok()
    );
    assert!(EvmReadRpc::new("https://example.com/private-key").is_err());
    assert!(EvmReadRpc::new("http://localhost:8545").is_err());
}
