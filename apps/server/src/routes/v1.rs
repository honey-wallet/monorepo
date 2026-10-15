use axum::{Json, Router, routing::get};
use serde::Serialize;

/// Response shape mirrored in `packages/api-client/src/types.ts`.
#[derive(Serialize)]
pub struct VersionInfo {
    name: &'static str,
    version: &'static str,
}

pub fn router() -> Router {
    Router::new()
        .route("/version", get(version))
        .merge(super::chains::router())
        .merge(super::accounts::router())
        .merge(super::session_signatures::router())
        .merge(super::relay::router())
        .merge(super::monitoring::router())
}

async fn version() -> Json<VersionInfo> {
    Json(VersionInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    })
}
