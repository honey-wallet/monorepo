use axum::{Json, Router, routing::get};
use serde::Serialize;

/// Response shape mirrored in `packages/api-client/src/types.ts`.
#[derive(Serialize)]
pub struct VersionInfo {
    name: &'static str,
    version: &'static str,
}

pub fn router() -> Router {
    Router::new().route("/version", get(version))
}

async fn version() -> Json<VersionInfo> {
    Json(VersionInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    })
}
