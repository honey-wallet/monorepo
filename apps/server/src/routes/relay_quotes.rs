//! Relay quote previews are authenticated and intentionally non-executable.

use crate::{
    error::AppError,
    identity::Identity,
    providers::relay_quotes::{RelayQuoteRequest, RelayQuotes},
};
use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::HeaderMap,
    routing::post,
};
use std::sync::Arc;

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    quotes: Option<Arc<RelayQuotes>>,
}

pub fn router(identity: Option<Identity>, quotes: Option<Arc<RelayQuotes>>) -> Router {
    Router::new()
        .route("/relay/quote", post(quote))
        .with_state(StateData { identity, quotes })
}

async fn quote(
    State(state): State<StateData>,
    headers: HeaderMap,
    body: Result<Json<RelayQuoteRequest>, JsonRejection>,
) -> Result<Json<crate::providers::relay_quotes::RelayQuotePreview>, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?;
    identity
        .rate_limit_shared("relay_quote", &profile.wallet.id.to_string(), 240, 10)
        .await?;
    let Json(input) =
        body.map_err(|_| AppError::BadRequest("invalid Relay quote request".into()))?;
    if !input.user.eq_ignore_ascii_case(&profile.wallet.address) {
        return Err(AppError::BadRequest(
            "Relay quote user must match the signed-in wallet".into(),
        ));
    }
    let expected_chain = format!("eip155:{}", input.origin_chain_id);
    if profile.wallet.chain_id != expected_chain {
        return Err(AppError::Unsupported(
            "sign in with the Relay origin wallet".into(),
        ));
    }
    let quotes = state.quotes.as_ref().ok_or(AppError::Unsupported(
        "Relay quotes are not configured".into(),
    ))?;
    Ok(Json(quotes.quote(&input).await?))
}
