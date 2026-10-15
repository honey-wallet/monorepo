//! Optional relay for client-signed payloads (spec §10). See `crate::relayer`.

use axum::{Json, Router, extract::Path, routing::post};

use crate::{
    error::AppError,
    relayer::{CommitReceipt, CommitRequest, RevealRequest, SubmissionReceipt, SubmitRequest},
};

pub fn router() -> Router {
    Router::new()
        .route("/relay/commits", post(commit))
        .route("/relay/commits/{id}/reveal", post(reveal))
        .route("/relay/submit", post(submit))
}

async fn commit(Json(_req): Json<CommitRequest>) -> Result<Json<CommitReceipt>, AppError> {
    // TODO(spec §10): look up the account's chain, reject chains without
    // commit-delay-reveal, then call the adapter's `post_commit`.
    Err(AppError::NotImplemented("relay.commit"))
}

async fn reveal(
    Path(_id): Path<String>,
    Json(_req): Json<RevealRequest>,
) -> Result<Json<SubmissionReceipt>, AppError> {
    // TODO(spec §10): refuse before `reveal_after` or after expiry, then
    // submit privately.
    Err(AppError::NotImplemented("relay.reveal"))
}

async fn submit(Json(_req): Json<SubmitRequest>) -> Result<Json<SubmissionReceipt>, AppError> {
    // TODO(spec §10, §12): adapter's `submit`, then log an
    // OwnerSignature exposure event when `owner_key_index` is set.
    Err(AppError::NotImplemented("relay.submit"))
}
