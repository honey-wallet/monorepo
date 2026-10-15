//! Accounts the server tracks. Registration stores public data only; keys stay
//! on the client.

use axum::{
    Json, Router,
    extract::Path,
    routing::{get, post},
};

use crate::{
    error::AppError,
    exposure::{ExposureEvent, ReportExposure},
    wallet::{Account, RecoveryStatus, RegisterAccount},
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

async fn register(Json(_req): Json<RegisterAccount>) -> Result<Json<Account>, AppError> {
    // TODO: verify the address exists on `chain` via its adapter's
    // `read_account`, then persist the mirrored state.
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

async fn report_exposure(
    Path(_id): Path<String>,
    Json(_req): Json<ReportExposure>,
) -> Result<Json<ExposureEvent>, AppError> {
    // TODO(spec §12): store and check for key-index reuse.
    Err(AppError::NotImplemented("accounts.report_exposure"))
}
