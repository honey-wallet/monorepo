use axum::{Json, Router, routing::get};

use crate::chains::{self, ChainCapabilities};

pub fn router() -> Router {
    Router::new().route("/chains", get(list))
}

/// What each chain supports (spec §14). Clients use it to pick a tier and to
/// explain limits (e.g. no commit-delay-reveal on XRPL).
async fn list() -> Json<Vec<ChainCapabilities>> {
    Json(chains::capabilities())
}
