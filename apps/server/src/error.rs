use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

/// Error type returned by handlers. Every error is rendered as
/// `{ "error": { "code": "...", "message": "..." } }` so clients can rely on
/// one shape.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("resource not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("not allowed")]
    Forbidden,
    #[error("too many requests, try again shortly")]
    TooManyRequests,
    /// Temporarily out of room (e.g. the pairing mailbox is full); retry later.
    #[error("server busy, try again shortly")]
    Busy,
    /// The chain cannot do what was asked (e.g. commit-delay-reveal on Bitcoin).
    #[error("{0}")]
    Unsupported(String),
    /// Skeleton endpoint; the payload names the feature still to be built.
    #[error("not implemented yet: {0}")]
    NotImplemented(&'static str),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: ErrorDetail<'a>,
}

#[derive(Serialize)]
struct ErrorDetail<'a> {
    code: &'a str,
    message: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::TooManyRequests => (StatusCode::TOO_MANY_REQUESTS, "too_many_requests"),
            Self::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
            Self::Unsupported(_) => (StatusCode::UNPROCESSABLE_ENTITY, "unsupported"),
            Self::NotImplemented(_) => (StatusCode::NOT_IMPLEMENTED, "not_implemented"),
            Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };

        let message = match &self {
            // Never leak internal error details to clients.
            Self::Internal(err) => {
                tracing::error!(error = ?err, "internal error");
                "internal server error".to_owned()
            }
            other => other.to_string(),
        };

        (
            status,
            Json(ErrorBody {
                error: ErrorDetail { code, message },
            }),
        )
            .into_response()
    }
}

pub async fn not_found() -> AppError {
    AppError::NotFound
}
