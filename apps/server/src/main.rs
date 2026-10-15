use anyhow::Context;
use honey_server::{Config, build_router, telemetry};
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

    telemetry::init();
    let listener = TcpListener::bind(config.socket_addr())
        .await
        .with_context(|| format!("failed to bind {}", config.socket_addr()))?;

    tracing::info!(addr = %listener.local_addr()?, "server listening");

    axum::serve(listener, build_router(&config))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;

    tracing::info!("server shut down");
    Ok(())
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
