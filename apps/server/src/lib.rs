//! Honey Wallet API server.
//!
//! The router is built in the library (not `main.rs`) so integration tests
//! can drive it in-process without binding a port.
//!
//! # Custody model
//!
//! Honey Wallet is self-custodial: every seed, owner key, session key and
//! one-time signature key is generated, stored and used on the client. This
//! server must never receive, store or derive one. It only reads public chain
//! state, verifies session signatures against public keys, relays payloads the
//! client already signed, and logs exposure events. Any request type that would
//! carry key material is a design bug.

pub mod chains;
pub mod config;
pub mod error;
pub mod exposure;
pub mod monitoring;
pub mod relayer;
pub mod routes;
pub mod session_signatures;
pub mod telemetry;
pub mod wallet;

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
