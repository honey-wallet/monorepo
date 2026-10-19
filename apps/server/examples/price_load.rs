//! Reproducible local capacity experiment, not a production readiness certificate.
//! Synthetic ingress; actual production router, TCP WebSockets and Redis quotas.
use futures_util::{SinkExt, StreamExt};
use honey_server::{
    Config,
    config::SecretUrl,
    markets::{PriceSnapshot, now_ms, parse_mids},
    runtime::{Infrastructure, RuntimeHealth},
};
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let users: usize = std::env::var("LOAD_USERS")
        .unwrap_or("10000".into())
        .parse()?;
    let seconds: u64 = std::env::var("LOAD_SECONDS")
        .unwrap_or("60".into())
        .parse()?;
    anyhow::ensure!((1..=10000).contains(&users) && (30..=600).contains(&seconds));
    let config = Config {
        redis_url: Some(SecretUrl::new(std::env::var("TEST_REDIS_URL")?)),
        redis_namespace: format!("load:{}", Uuid::new_v4().simple()),
        prices_enabled: true,
        otlp_traces_endpoint: std::env::var("HONEY_OTLP_TRACES_ENDPOINT")
            .ok()
            .map(SecretUrl::new),
        price_max_connections: users,
        price_max_connections_per_ip: users,
        ..Config::default()
    };
    let infrastructure = Infrastructure::new(&config)?;
    let telemetry = honey_server::telemetry::init(&config, infrastructure.metrics().clone())?;
    let hub = infrastructure.markets().unwrap().clone();
    let epoch = Uuid::new_v4();
    let prices = parse_mids(br#"{"BTC":"60000.123456789","ETH":"3000","SOL":"150"}"#).unwrap();
    let sample = |n: u64| PriceSnapshot {
        schema_version: 1,
        message_type: "snapshot".into(),
        epoch,
        sequence: n.to_string(),
        sampled_at_ms: now_ms(),
        stale: false,
        source: "hyperliquid".into(),
        prices: prices.clone(),
    };
    hub.install(sample(1u64));
    let health = RuntimeHealth::new(&config);
    let app =
        honey_server::build_router_with_infrastructure(&config, health.clone(), &infrastructure)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let update_hub = hub.clone();
    let producer = tokio::spawn(async move {
        let mut n = 2;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            update_hub.install(PriceSnapshot {
                schema_version: 1,
                message_type: "snapshot".into(),
                epoch,
                sequence: n.to_string(),
                sampled_at_ms: now_ms(),
                stale: false,
                source: "hyperliquid".into(),
                prices: prices.clone(),
            });
            n += 1;
        }
    });
    let connected = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0));
    let frames = Arc::new(AtomicU64::new(0));
    let lag_buckets = Arc::new(std::array::from_fn::<_, 11, _>(|_| AtomicU64::new(0)));
    let mut clients = Vec::with_capacity(users);
    let started = Instant::now();
    // Batches of 50 every 100ms keep admission load distinct from a handshake storm.
    for batch in 0..users.div_ceil(50) {
        let mut opens = tokio::task::JoinSet::new();
        for _ in 0..(users - batch * 50).min(50) {
            let url = format!("ws://{address}/api/v1/stream/prices");
            opens.spawn(async move {
                tokio::time::timeout(Duration::from_secs(5), connect_async(url)).await
            });
        }
        while let Some(result) = opens.join_next().await {
            let (mut socket, _) = result???;
            connected.fetch_add(1, Ordering::Relaxed);
            let connected = connected.clone();
            let dropped = dropped.clone();
            let frames = frames.clone();
            let buckets = lag_buckets.clone();
            clients.push(tokio::spawn(async move {
                while let Some(Ok(message)) = socket.next().await {
                    match message {
                        Message::Text(text) => {
                            let Ok(snapshot) = serde_json::from_str::<PriceSnapshot>(&text) else {
                                break;
                            };
                            let lag = now_ms().saturating_sub(snapshot.sampled_at_ms);
                            let bounds = [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000];
                            buckets[bounds.iter().position(|&b| lag <= b).unwrap_or(10)]
                                .fetch_add(1, Ordering::Relaxed);
                            frames.fetch_add(1, Ordering::Relaxed);
                        }
                        Message::Ping(payload) => {
                            if socket.send(Message::Pong(payload)).await.is_err() {
                                break;
                            }
                        }
                        Message::Close(_) => break,
                        _ => (),
                    }
                }
                connected.fetch_sub(1, Ordering::Relaxed);
                dropped.fetch_add(1, Ordering::Relaxed);
            }));
        }
        if batch % 20 == 19 {
            eprintln!("ramp: {} connected", connected.load(Ordering::Relaxed));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let ramp_ms = started.elapsed().as_millis();
    let baseline = frames.load(Ordering::Relaxed);
    let client = reqwest::Client::new();
    let mut http_us = Vec::new();
    let mut http_errors = 0u64;
    let soak = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    while soak.elapsed() < Duration::from_secs(seconds) {
        tick.tick().await;
        let at = Instant::now();
        match client
            .get(format!("http://{address}/api/v1/prices"))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                let _: PriceSnapshot = r.json().await?;
                http_us.push(at.elapsed().as_micros() as u64);
            }
            _ => http_errors += 1,
        }
    }
    http_us.sort_unstable();
    let report = serde_json::json!({ "syntheticIngress":true,"traceExport":config.otlp_traces_endpoint.is_some(),"traceSamplePerMille":config.trace_sample_per_mille,"tls":false,"sameProcessGenerator":true,"requestedUsers":users,"connectedAtEnd":connected.load(Ordering::Relaxed),"unexpectedDisconnects":dropped.load(Ordering::Relaxed),"rampMs":ramp_ms,"soakSeconds":seconds,"soakFrames":frames.load(Ordering::Relaxed)-baseline,"httpSuccess":http_us.len(),"httpErrors":http_errors,"httpP95Micros":http_us.get(http_us.len()*95/100),"httpP99Micros":http_us.get(http_us.len()*99/100),"frameLagBucketUpperMs":[5,10,25,50,100,250,500,1000,2000,5000,"inf"],"frameLagCounts":lag_buckets.iter().map(|n|n.load(Ordering::Relaxed)).collect::<Vec<_>>() });
    println!("{}", serde_json::to_string_pretty(&report)?);
    let passed = connected.load(Ordering::Relaxed) == users as u64
        && dropped.load(Ordering::Relaxed) == 0
        && http_errors == 0
        && frames.load(Ordering::Relaxed) - baseline >= users as u64 * (seconds - 3);
    health.begin_drain();
    tokio::time::sleep(Duration::from_secs(2)).await;
    for task in clients {
        task.abort();
        let _ = task.await;
    }
    producer.abort();
    server.abort();
    let _ = producer.await;
    let _ = server.await;
    let redis = infrastructure.redis().unwrap();
    let _: i32 = redis
        .query(redis::cmd("DEL").arg(redis.key("price-sockets", "global")))
        .await?;
    telemetry.shutdown().await;
    anyhow::ensure!(passed, "capacity experiment failed; see report");
    Ok(())
}
