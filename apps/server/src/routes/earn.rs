use crate::earn_catalog::{EarnCatalog, EarnCatalogHub};
use axum::{Json, Router, extract::State, routing::get};
use std::sync::Arc;
pub fn router(hub: Option<Arc<EarnCatalogHub>>) -> Router {
    Router::new()
        .route(
            "/earn/catalog",
            get(
                |State(hub): State<Option<Arc<EarnCatalogHub>>>| async move {
                    Json(hub.map_or_else(EarnCatalog::unconfigured, |h| h.snapshot()))
                },
            ),
        )
        .with_state(hub)
}
