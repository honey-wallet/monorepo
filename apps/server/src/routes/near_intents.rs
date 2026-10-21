use crate::{
    error::AppError,
    identity::Identity,
    providers::near_intents::{NearIntents, QuotePreview, QuoteRequest, Token},
};
use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
    routing::{get, post},
};
use std::sync::Arc;

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    provider: Option<Arc<NearIntents>>,
}

pub fn router(identity: Option<Identity>, provider: Option<Arc<NearIntents>>) -> Router {
    Router::new()
        .route("/bridges/near-intents/tokens", get(tokens))
        .route("/bridges/near-intents/quote", post(quote))
        .with_state(StateData { identity, provider })
}

async fn profile(
    state: &StateData,
    headers: &HeaderMap,
) -> Result<crate::identity::Profile, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(headers)?)
        .await?;
    identity
        .rate_limit_shared("near_intents", &profile.wallet.id.to_string(), 240, 10)
        .await?;
    Ok(profile)
}
fn provider(state: &StateData) -> Result<&NearIntents, AppError> {
    state.provider.as_deref().ok_or(AppError::Unsupported(
        "NEAR Intents previews are not configured".into(),
    ))
}
async fn tokens(
    State(state): State<StateData>,
    headers: HeaderMap,
) -> Result<Json<Vec<Token>>, AppError> {
    profile(&state, &headers).await?;
    Ok(Json(provider(&state)?.tokens().await?))
}
async fn quote(
    State(state): State<StateData>,
    headers: HeaderMap,
    body: Result<Json<QuoteRequest>, JsonRejection>,
) -> Result<Json<QuotePreview>, AppError> {
    let profile = profile(&state, &headers).await?;
    let Json(input) =
        body.map_err(|_| AppError::BadRequest("invalid NEAR Intents quote request".into()))?;
    Ok(Json(
        provider(&state)?
            .quote(&input, &profile.wallet.address, &profile.wallet.chain_id)
            .await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn previews_require_auth_before_parsing_input_or_contacting_provider() {
        for (method, path) in [
            ("GET", "/bridges/near-intents/tokens"),
            ("POST", "/bridges/near-intents/quote"),
        ] {
            let response = router(None, None)
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from("{invalid"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }
}
