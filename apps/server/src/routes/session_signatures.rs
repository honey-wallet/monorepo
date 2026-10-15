use axum::{Json, Router, routing::post};

use crate::{
    error::AppError,
    session_signatures::{SessionVerdict, VerifySessionSignature},
};

pub fn router() -> Router {
    Router::new().route("/session-signatures/verify", post(verify))
}

async fn verify(
    Json(_req): Json<VerifySessionSignature>,
) -> Result<Json<SessionVerdict>, AppError> {
    // TODO(spec §9): dispatch to the chain adapter's
    // `verify_session_signature`; enforce the domain-separator allowlist.
    Err(AppError::NotImplemented("session_signatures.verify"))
}
