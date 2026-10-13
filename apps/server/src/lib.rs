//! Honey Wallet API server.
//!
//! The router is built in the library (not `main.rs`) so integration tests
//! can drive it in-process without binding a port.

pub mod config;
pub mod error;
pub mod routes;
pub mod telemetry;

use std::time::Duration;

use axum::{Router, http::StatusCode};
use tower_http::{
    cors::CorsLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

pub use config::Config;

/// Builds the full application router with middleware applied.
pub fn build_router(config: &Config) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(config.cors_allowed_origins.clone())
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    Router::new()
        .merge(routes::health::router())
        .nest("/api/v1", routes::v1::router())
        .fallback(error::not_found)
        // Layers run bottom-to-top on the way in.
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(config.request_timeout_secs),
        ))
        .layer(cors)
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
}
