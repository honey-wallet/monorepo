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
    #[error("authentication required or expired")]
    Unauthorized,
    #[error("too many requests, try again shortly")]
    TooManyRequests,
    /// Temporarily out of room (e.g. the pairing mailbox is full); retry later.
    #[error("server busy, try again shortly")]
    Busy,
    #[error("request body too large")]
    PayloadTooLarge,
    #[error("request deadline exceeded; check operation status before retrying a submission")]
    Timeout,
    /// The chain cannot do what was asked (e.g. commit-delay-reveal on XRPL).
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
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::TooManyRequests => (StatusCode::TOO_MANY_REQUESTS, "too_many_requests"),
            Self::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
            Self::PayloadTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            Self::Timeout => (StatusCode::GATEWAY_TIMEOUT, "timeout"),
            Self::Unsupported(_) => (StatusCode::UNPROCESSABLE_ENTITY, "unsupported"),
            Self::NotImplemented(_) => (StatusCode::NOT_IMPLEMENTED, "not_implemented"),
            Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };

        let message = match &self {
            // Never leak internal error details to clients.
            Self::Internal(_) => {
                // Driver/provider messages may contain credentials or signed payloads.
                // Log classified context at the source, never arbitrary error chains.
                tracing::error!(error_code = "internal", "internal error");
                "internal server error".to_owned()
            }
            other => other.to_string(),
        };

        let mut response = (
            status,
            Json(ErrorBody {
                error: ErrorDetail { code, message },
            }),
        )
            .into_response();
        if matches!(self, Self::Unauthorized) {
            response.headers_mut().insert(
                axum::http::header::WWW_AUTHENTICATE,
                axum::http::HeaderValue::from_static("Bearer"),
            );
        }
        if matches!(self, Self::Busy | Self::TooManyRequests) {
            response.headers_mut().insert(
                axum::http::header::RETRY_AFTER,
                axum::http::HeaderValue::from_static("1"),
            );
        }
        response
    }
}

pub async fn not_found() -> AppError {
    AppError::NotFound
}
