//! Actual TCP/WebSocket handshakes against the production router; isolated Redis keys.
use futures_util::StreamExt;
use honey_server::{
    Config,
    config::SecretUrl,
    markets::{MarketHub, PriceSnapshot, now_ms, parse_mids},
    runtime::{Infrastructure, RuntimeHealth},
};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
use uuid::Uuid;

fn fixture(sequence: u64, epoch: Uuid) -> PriceSnapshot {
    PriceSnapshot {
        schema_version: 1,
        message_type: "snapshot".into(),
        epoch,
        sequence: sequence.to_string(),
        sampled_at_ms: now_ms(),
        stale: false,
        source: "hyperliquid".into(),
        prices: parse_mids(br#"{"BTC":"60000.123456789","ETH":"3000","SOL":"150"}"#).unwrap(),
    }
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback sockets"]
async fn websocket_snapshots_origin_capacity_and_drain_use_production_router() {
    let config = Config {
        redis_url: Some(SecretUrl::new(std::env::var("TEST_REDIS_URL").unwrap())),
        redis_namespace: format!("test:{}", Uuid::new_v4().simple()),
        prices_enabled: true,
        price_max_connections: 2,
        price_max_connections_per_ip: 1,
        ..Config::default()
    };
    let infrastructure = Infrastructure::new(&config).unwrap();
    let hub = infrastructure.markets().unwrap().clone();
    let epoch = Uuid::new_v4();
    hub.install(fixture(1, epoch));
    let health = RuntimeHealth::new(&config);
    let app =
        honey_server::build_router_with_infrastructure(&config, health.clone(), &infrastructure)
            .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let url = format!("ws://{address}/api/v1/stream/prices");
    let mut foreign = url.clone().into_client_request().unwrap();
    foreign
        .headers_mut()
        .insert("origin", "https://foreign.example".parse().unwrap());
    assert!(
        matches!(connect_async(foreign).await, Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == 403)
    );
    // Native/non-browser clients intentionally omit Origin for this public feed.
    let (mut socket, response) = connect_async(&url).await.unwrap();
    assert!(response.headers().contains_key("x-request-id"));
    let initial = socket.next().await.unwrap().unwrap();
    let initial: PriceSnapshot = serde_json::from_str(initial.to_text().unwrap()).unwrap();
    assert_eq!(initial.sequence, "1");
    assert_eq!(initial.prices[0].quote_unit, "USDT");
    assert!(
        matches!(connect_async(&url).await, Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status() == 429)
    );
    hub.install(fixture(2, epoch));
    let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let frame: PriceSnapshot = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(frame.sequence, "2");
    hub.install(fixture(1, epoch));
    assert_eq!(hub.snapshot().unwrap().sequence, "2");
    let mut stale = fixture(3, epoch);
    stale.sampled_at_ms = now_ms() - 6000;
    hub.install(stale);
    let http: PriceSnapshot = reqwest::get(format!("http://{address}/api/v1/prices"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(http.stale);
    health.begin_drain();
    loop {
        let message = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if matches!(message, Message::Close(_)) {
            break;
        }
    }
    let _ = socket.close(None).await;
    server.abort();
    let _ = server.await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn replicas_share_refresh_budget_publish_fencing_and_socket_leases() {
    let config = Config {
        redis_url: Some(SecretUrl::new(std::env::var("TEST_REDIS_URL").unwrap())),
        redis_namespace: format!("test:{}", Uuid::new_v4().simple()),
        prices_enabled: true,
        price_max_connections: 2,
        price_max_connections_per_ip: 1,
        ..Config::default()
    };
    let infrastructure = Infrastructure::new(&config).unwrap();
    let redis = infrastructure.redis().unwrap();
    let first = infrastructure.markets().unwrap();
    let second = Arc::new(MarketHub::new(&config, redis.clone()).unwrap());
    let control = redis.key("prices", "control");
    let acquire = |owner: &'static str| {
        let mut cmd = redis::cmd("EVAL");
        cmd.arg(include_str!("../src/scripts/market_poll.lua"))
            .arg(1)
            .arg(&control)
            .arg(owner);
        cmd
    };
    let sampled: i64 = redis.query(&mut acquire("a")).await.unwrap();
    assert!(sampled > 0);
    // The poll lease is owner-bound: a competing replica cannot acquire it until
    // the current lease expires, and a fresh acquisition is scheduled by Redis TIME.
    let _: i32 = redis
        .query(
            redis::cmd("HSET")
                .arg(&control)
                .arg("nextPoll")
                .arg(sampled + 8000),
        )
        .await
        .unwrap();
    let local_wait: i64 = redis.query(&mut acquire("a")).await.unwrap();
    assert!((-8000..=-7000).contains(&local_wait));
    assert_eq!(redis.query::<i64>(&mut acquire("b")).await.unwrap(), -1000);
    let sample = fixture(1, Uuid::new_v4());
    assert!(!second.publish("b", &sample.prices).await.unwrap());
    assert!(first.publish("a", &sample.prices).await.unwrap());
    let raw: String = redis
        .query(redis::cmd("GET").arg(redis.key("prices", "snapshot")))
        .await
        .unwrap();
    let snapshot: PriceSnapshot = serde_json::from_str(&raw).unwrap();
    assert_eq!(snapshot.sequence, "1");
    assert!(snapshot.sampled_at_ms > 0);
    assert!(snapshot.sampled_at_ms.abs_diff(now_ms()) <= 1_000);
    let first_epoch = snapshot.epoch;
    second.install(snapshot);
    assert_eq!(
        second.snapshot().unwrap().prices[0].price,
        "60000.123456789"
    );
    // Publish is fenced by both owner and live lease, and accepted frames advance
    // the shared sequence while retaining the control hash's epoch.
    let control_epoch: String = redis
        .query(redis::cmd("HGET").arg(&control).arg("epoch"))
        .await
        .unwrap();
    assert_eq!(control_epoch, first_epoch.to_string());
    let before: String = redis
        .query(redis::cmd("HGET").arg(&control).arg("sequence"))
        .await
        .unwrap();
    assert_eq!(before, "1");
    let _: i32 = redis
        .query(
            redis::cmd("HSET")
                .arg(&control)
                .arg("leaseUntil")
                .arg(sampled),
        )
        .await
        .unwrap();
    assert!(!first.publish("a", &sample.prices).await.unwrap());
    let _: i32 = redis
        .query(redis::cmd("HSET").arg(&control).arg("nextPoll").arg(0))
        .await
        .unwrap();
    assert!(redis.query::<i64>(&mut acquire("a")).await.unwrap() > 0);
    assert!(first.publish("a", &sample.prices).await.unwrap());
    let after: String = redis
        .query(redis::cmd("HGET").arg(&control).arg("sequence"))
        .await
        .unwrap();
    let after_epoch: String = redis
        .query(redis::cmd("HGET").arg(&control).arg("epoch"))
        .await
        .unwrap();
    assert_eq!(after, "2");
    assert_eq!(after_epoch, control_epoch);

    // Backoff may only be set by the current owner and uses the Redis clock.
    let apply_backoff = |owner: &'static str, delay_ms: u64| {
        let mut cmd = redis::cmd("EVAL");
        cmd.arg(include_str!("../src/scripts/market_backoff.lua"))
            .arg(1)
            .arg(&control)
            .arg(owner)
            .arg(delay_ms);
        cmd
    };
    assert_eq!(
        redis
            .query::<i32>(&mut apply_backoff("wrong", 5_000))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        redis
            .query::<i32>(&mut apply_backoff("a", 5_000))
            .await
            .unwrap(),
        1
    );
    let next_poll: i64 = redis
        .query(redis::cmd("HGET").arg(&control).arg("nextPoll"))
        .await
        .unwrap();
    let redis_now: (i64, i64) = redis.query(&mut redis::cmd("TIME")).await.unwrap();
    let redis_now_ms = redis_now.0 * 1_000 + redis_now.1 / 1_000;
    assert!((redis_now_ms + 4_900..=redis_now_ms + 5_100).contains(&next_poll));
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    assert!(first.socket_lease("acquire", a, "ip1").await.unwrap());
    let global_lease_ttl: i64 = redis
        .query(redis::cmd("PTTL").arg(redis.key("price-sockets", "global")))
        .await
        .unwrap();
    assert!((1..=60_000).contains(&global_lease_ttl));
    assert!(!second.socket_lease("acquire", b, "ip1").await.unwrap());
    assert!(second.socket_lease("acquire", b, "ip2").await.unwrap());
    assert!(!first.socket_lease("acquire", c, "ip3").await.unwrap());
    assert!(first.socket_lease("renew", a, "ip1").await.unwrap());
    // Expired ZSET entries are removed before cap checks, so dead sockets do not
    // permanently consume a global or per-IP slot.
    let _: i32 = redis
        .query(
            redis::cmd("ZADD")
                .arg(redis.key("price-sockets", "global"))
                .arg(0)
                .arg(a.to_string()),
        )
        .await
        .unwrap();
    let _: i32 = redis
        .query(
            redis::cmd("ZADD")
                .arg(redis.key("price-sockets", "ip:ip1"))
                .arg(0)
                .arg(a.to_string()),
        )
        .await
        .unwrap();
    assert!(first.socket_lease("acquire", c, "ip3").await.unwrap());
    assert!(!first.socket_lease("renew", a, "ip1").await.unwrap());
    assert!(second.socket_lease("release", a, "ip1").await.unwrap());
    for (id, ip) in [(b, "ip2"), (c, "ip3")] {
        first.socket_lease("release", id, ip).await.unwrap();
    }
    let _: i32 = redis
        .query(
            redis::cmd("DEL")
                .arg(control)
                .arg(redis.key("prices", "snapshot"))
                .arg(redis.key("price-sockets", "global")),
        )
        .await
        .unwrap();
}
