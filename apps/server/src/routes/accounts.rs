//! Accounts the server tracks. Registration stores public data only; keys stay
//! on the client.

use axum::{
    Json, Router,
    extract::Path,
    routing::{get, post},
};

use crate::{
    error::AppError,
    exposure::ExposureEvent,
    wallet::{Account, RecoveryStatus},
};

pub fn router() -> Router {
    Router::new()
        .route("/accounts", post(register))
        .route("/accounts/{id}", get(fetch))
        .route("/accounts/{id}/recovery", get(recovery))
        .route(
            "/accounts/{id}/exposure-events",
            get(list_exposure).post(report_exposure),
        )
}

async fn register() -> Result<(), AppError> {
    // Disabled stub: do not deserialize unauthenticated input until implemented.
    Err(AppError::NotImplemented("accounts.register"))
}

async fn fetch(Path(_id): Path<String>) -> Result<Json<Account>, AppError> {
    // TODO: return cached state, refreshed from chain when stale.
    Err(AppError::NotImplemented("accounts.fetch"))
}

async fn recovery(Path(_id): Path<String>) -> Result<Json<RecoveryStatus>, AppError> {
    // TODO(spec §12): guardians, pending `freezeAndMigrate`, dead-man switch.
    Err(AppError::NotImplemented("accounts.recovery"))
}

async fn list_exposure(Path(_id): Path<String>) -> Result<Json<Vec<ExposureEvent>>, AppError> {
    Err(AppError::NotImplemented("accounts.list_exposure"))
}

async fn report_exposure(Path(_id): Path<String>) -> Result<(), AppError> {
    Err(AppError::NotImplemented("accounts.report_exposure"))
}
