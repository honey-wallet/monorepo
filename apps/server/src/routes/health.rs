use crate::runtime::{Readiness, ReadinessStatus, RuntimeHealth};
use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde::Serialize;

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
}

/// Unversioned liveness probe for load balancers and orchestrators.
pub fn router() -> Router {
    Router::new().route("/health", get(health))
}

async fn health() -> Json<Health> {
    Json(Health { status: "ok" })
}

pub fn readiness_router(health: RuntimeHealth) -> Router {
    Router::new().route("/ready", get(ready)).with_state(health)
}

async fn ready(State(health): State<RuntimeHealth>) -> (StatusCode, Json<Readiness>) {
    let readiness = health.readiness();
    let status = match readiness.status {
        ReadinessStatus::Ready => StatusCode::OK,
        ReadinessStatus::NotReady => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, Json(readiness))
}
