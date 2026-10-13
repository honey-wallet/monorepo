use anyhow::Context;
use honey_server::{Config, build_router, telemetry};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // A missing .env file is fine; real deployments set variables directly.
    let _ = dotenvy::dotenv();
    telemetry::init();

    let config = Config::from_env().context("invalid configuration")?;
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
