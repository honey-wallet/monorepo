//! `GET /api/v1/me/identity`: who the Supabase access token belongs to.
//!
//! Identity only, separate from SIWE wallet sessions: it proves an account sign-in
//! (Apple, Google or email) and nothing about wallets. Returns 422 `unsupported` while
//! Supabase Auth isn't configured.

use axum::{Json, Router, routing::get};
use serde::Serialize;

use crate::supabase_auth::{SupabaseUser, SupabaseVerifier};

/// Response shape mirrored in `packages/api-client/src/types.ts` (`AccountIdentity`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub user_id: String,
}

pub fn router(verifier: Option<SupabaseVerifier>) -> Router {
    Router::new()
        .route("/me/identity", get(me))
        .with_state(verifier)
}

async fn me(SupabaseUser(session): SupabaseUser) -> Json<AccountIdentity> {
    Json(AccountIdentity {
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
    use crate::supabase_auth::test_support;

    async fn call(app: Router, authorization: Option<&str>) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder().uri("/me/identity");
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
            SupabaseVerifier::from_jwks(test_support::config(), &test_support::jwks()).unwrap(),
        ))
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    #[tokio::test]
    async fn returns_the_supabase_user_id_for_a_valid_token() {
        let token = test_support::sign(&test_support::claims(now()));
        let (status, body) = call(enabled(), Some(&format!("Bearer {token}"))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!({ "userId": test_support::USER_ID }));
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
    async fn is_unsupported_while_supabase_auth_is_off() {
        let token = test_support::sign(&test_support::claims(now()));
        let (status, body) = call(router(None), Some(&format!("Bearer {token}"))).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"]["code"], "unsupported");
    }
}
