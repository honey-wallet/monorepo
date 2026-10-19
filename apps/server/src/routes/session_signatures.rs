use axum::{Router, routing::post};

use crate::error::AppError;

pub fn router() -> Router {
    Router::new().route("/session-signatures/verify", post(verify))
}

async fn verify() -> Result<(), AppError> {
    // Disabled stub: authenticate and validate the chain-specific domain before
    // accepting or parsing a signature when implementation is added.
    Err(AppError::NotImplemented("session_signatures.verify"))
}
