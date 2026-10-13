use axum::{Json, Router, routing::get};
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
