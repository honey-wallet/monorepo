use anyhow::Context;
use honey_server::{
    Config, build_router_with_infrastructure, database,
    runtime::{Infrastructure, RuntimeHealth},
    telemetry,
};
use std::{future::IntoFuture, sync::Arc, time::Duration};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // A missing .env file is fine; real deployments set variables directly.
    let _ = dotenvy::dotenv();
    let config = Config::from_env().context("invalid configuration")?;

    // `honey-server healthcheck`: used by the container's HEALTHCHECK, since
    // the distroless image has no shell or curl.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(match healthcheck(config.port) {
            Ok(()) => 0,
            Err(err) => {
                eprintln!("healthcheck failed: {err:#}");
                1
            }
        });
    }

    let health = RuntimeHealth::new(&config);
    let infrastructure = Arc::new(Infrastructure::new(&config)?);
    let telemetry = telemetry::init(&config, infrastructure.metrics().clone())?;
    match std::env::args().nth(1).as_deref() {
        Some("migrate") => {
            let pool = infrastructure
                .postgres()
                .context("DATABASE_URL required for migrations")?;
            database::migrate(pool).await.map_err(|error| {
                anyhow::anyhow!("migration failed; inspect schema and migration history: {error}")
            })?;
            tracing::info!("database migrations applied");
            infrastructure.close().await;
            telemetry.shutdown().await;
            return Ok(());
        }
        Some("prune-auth") => {
            let pool = infrastructure
                .postgres()
                .context("DATABASE_URL required for auth retention")?;
            let deleted = database::prune_auth(pool)
                .await
                .map_err(|_| anyhow::anyhow!("auth retention failed"))?;
            tracing::info!(deleted, "expired auth records pruned");
            infrastructure.close().await;
            telemetry.shutdown().await;
            return Ok(());
        }
        Some("dead-letters") => {
            // One-shot, bounded, read-only operator view. Never expose this through
            // the public API: job IDs are internal metadata and replay needs a
            // provider-specific reconciliation decision.
            let mut args = std::env::args().skip(2);
            let limit = match args.next() {
                Some(value) => value
                    .parse::<usize>()
                    .context("limit must be an integer from 1 to 100")?,
                None => 25,
            };
            let before = args
                .next()
                .map(|value| value.parse::<uuid::Uuid>())
                .transpose()
                .context("before-job-id must be a UUID")?;
            anyhow::ensure!(
                args.next().is_none(),
                "usage: honey-server dead-letters [limit] [before-job-id]"
            );
            let pool = infrastructure
                .postgres()
                .context("DATABASE_URL required for dead-letter inspection")?;
            let page = honey_server::work::WorkStore::new(pool.clone())
                .dead_letters(limit, before)
                .await
                .map_err(|_| anyhow::anyhow!("dead-letter inspection failed"))?;
            println!("{}", serde_json::to_string_pretty(&page)?);
            infrastructure.close().await;
            telemetry.shutdown().await;
            return Ok(());
        }
        Some(_) => anyhow::bail!("unknown command"),
        None => {}
    }
    let listener = TcpListener::bind(config.socket_addr())
        .await
        .with_context(|| format!("failed to bind {}", config.socket_addr()))?;

    tracing::info!(addr = %listener.local_addr()?, role = ?config.server_role, "server listening");

    // Connect info gives handlers the client's IP (the pairing mailbox limits per IP).
    let app = build_router_with_infrastructure(&config, health.clone(), &infrastructure)?
        .into_make_service_with_connect_info::<std::net::SocketAddr>();
    let metrics_server = if let Some(address) = config.metrics_addr {
        let listener = TcpListener::bind(address)
            .await
            .context("failed to bind metrics listener")?;
        let metrics_router = honey_server::metrics::router(infrastructure.metrics().clone());
        Some(tokio::spawn(async move {
            if axum::serve(listener, metrics_router).await.is_err() {
                tracing::error!(
                    error_code = "metrics_listener_failed",
                    "metrics listener stopped"
                );
            }
        }))
    } else {
        None
    };
    let monitor = infrastructure.clone().start_monitor(health.clone());
    let market_tasks = infrastructure
        .markets()
        .map(|hub| hub.clone().start_for_role(config.server_role))
        .unwrap_or_default();
    let mut background = vec![monitor];
    background.extend(market_tasks);
    if let Some(earn) = infrastructure.earn() {
        background.extend(earn.clone().start_for_role(config.server_role));
    }
    if config.server_role.runs_workers() {
        if let Some(aave) = infrastructure.aave() {
            background.push(aave.clone().start(health.clone()));
        }
        if let Some(bridges) = infrastructure.bridges() {
            background.push(bridges.clone().start(health.clone()));
        }
        if let Some(across) = infrastructure.across_execution() {
            background.push(across.clone().start(health.clone()).await);
        }
        if let Some(uniswap) = infrastructure.uniswap() {
            background.push(uniswap.clone().start(health.clone()));
        }
        if let Some(morpho) = infrastructure.morpho() {
            background.push(morpho.clone().start(health.clone()));
        }
    }
    if let Some(task) = metrics_server {
        background.push(task);
    }
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .into_future();
    tokio::pin!(server);
    let mut failed_task = None;
    let completed = tokio::select! {
        result = &mut server => Some(result.context("server error")),
        () = shutdown_signal() => None,
        index = honey_server::supervision::watch(health.clone(), infrastructure.metrics().clone(), &mut background) => {
            failed_task = Some(index); None
        }
    };
    let result = if let Some(result) = completed {
        result
    } else {
        health.begin_drain();
        infrastructure.metrics().draining.set(1);
        tracing::info!("draining server");
        let _ = stop.send(());
        match tokio::time::timeout(
            Duration::from_secs(config.shutdown_timeout_secs),
            &mut server,
        )
        .await
        {
            Ok(result) => result.context("server error during drain"),
            Err(_) => Err(anyhow::anyhow!("shutdown deadline exceeded")),
        }
    };
    if let Some(index) = failed_task {
        drop(background.swap_remove(index));
    }
    for task in background {
        task.abort();
        let _ = task.await;
    }
    // Closing a pool is also bounded, even if a future handler leaks a connection.
    let _ = tokio::time::timeout(Duration::from_secs(2), infrastructure.close()).await;
    tracing::info!("server shut down");
    telemetry.shutdown().await;
    if failed_task.is_some() {
        anyhow::bail!("required background task stopped");
    }
    result
}

/// Resolves on Ctrl+C or SIGTERM so in-flight requests can drain.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

/// Probes `GET /health` on the local port and succeeds only on a 200.
fn healthcheck(port: u16) -> anyhow::Result<()> {
    use std::{
        io::{Read, Write},
        net::{Ipv4Addr, SocketAddr, TcpStream},
        time::Duration,
    };

    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let timeout = Duration::from_secs(2);
    let mut stream =
        TcpStream::connect_timeout(&addr, timeout).with_context(|| format!("connect to {addr}"))?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;

    let mut status_line = [0u8; 12]; // "HTTP/1.1 200"
    stream.read_exact(&mut status_line)?;
    anyhow::ensure!(
        status_line.ends_with(b" 200"),
        "unexpected status: {}",
        String::from_utf8_lossy(&status_line)
    );
    Ok(())
}
