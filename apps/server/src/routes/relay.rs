//! Optional relay for client-signed payloads (spec §10). See `crate::relayer`.

use axum::{Router, extract::Path, routing::post};

use crate::error::AppError;

pub fn router() -> Router {
    Router::new()
        .route("/relay/commits", post(commit))
        .route("/relay/commits/{id}/reveal", post(reveal))
        .route("/relay/submit", post(submit))
}

async fn commit() -> Result<(), AppError> {
    // Deliberately do not deserialize unauthenticated input for a disabled route.
    // Add authentication, quotas, ownership and replay controls before enabling.
    Err(AppError::NotImplemented("relay.commit"))
}

async fn reveal(Path(_id): Path<String>) -> Result<(), AppError> {
    Err(AppError::NotImplemented("relay.reveal"))
}

async fn submit() -> Result<(), AppError> {
    Err(AppError::NotImplemented("relay.submit"))
}
