//! `GET /api/v1/me/clerk`: who the Clerk session token belongs to.
//!
//! Identity only, separate from SIWE wallet sessions: it proves a Clerk sign-in and
//! nothing about wallets. Returns 422 `unsupported` while Clerk isn't configured.

use axum::{Json, Router, routing::get};
use serde::Serialize;

use crate::clerk::{ClerkUser, ClerkVerifier};

/// Response shape mirrored in `packages/api-client/src/types.ts` (`ClerkIdentity`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClerkIdentity {
    pub user_id: String,
}

pub fn router(clerk: Option<ClerkVerifier>) -> Router {
    Router::new().route("/me/clerk", get(me)).with_state(clerk)
}

async fn me(ClerkUser(session): ClerkUser) -> Json<ClerkIdentity> {
    Json(ClerkIdentity {
        user_id: session.user_id,
    })
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::clerk::test_support;

    async fn call(app: Router, authorization: Option<&str>) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder().uri("/me/clerk");
        if let Some(value) = authorization {
            request = request.header("authorization", value);
        }
        let response = app
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap())
    }

    fn enabled() -> Router {
        router(Some(
            ClerkVerifier::from_jwks(test_support::config(), &test_support::jwks()).unwrap(),
        ))
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    #[tokio::test]
    async fn returns_the_clerk_user_id_for_a_valid_token() {
        let token = test_support::sign(&test_support::claims(now()));
        let (status, body) = call(enabled(), Some(&format!("Bearer {token}"))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!({ "userId": "user_2abc" }));
    }

    #[tokio::test]
    async fn rejects_missing_and_invalid_tokens() {
        let (status, _) = call(enabled(), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, body) = call(enabled(), Some("Bearer not.a.token")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["code"], "unauthorized");
        let mut expired = test_support::claims(now());
        expired["exp"] = serde_json::json!(now() - 600);
        let token = test_support::sign(&expired);
        let (status, _) = call(enabled(), Some(&format!("Bearer {token}"))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn is_unsupported_while_clerk_is_off() {
        let token = test_support::sign(&test_support::claims(now()));
        let (status, body) = call(router(None), Some(&format!("Bearer {token}"))).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"]["code"], "unsupported");
    }
}
