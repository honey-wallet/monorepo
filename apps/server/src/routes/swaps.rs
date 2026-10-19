//! Quote reads plus explicitly configured local-fork operation execution.
use crate::{
    error::AppError,
    identity::{Identity, Profile},
    preparation::OperationRecovery,
    providers::uniswap::{SwapQuote, SwapQuoteConfiguration, SwapQuoteRequest, UniswapQuotes},
    uniswap_service::{
        CreateSwap, SubmitSwap, SubmitSwapPermit, SwapExecutionConfiguration, SwapIntentRecovery,
        SwapReviewRequest, SwapSigningRequest, UniswapService,
    },
};
use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use std::sync::Arc;
#[derive(Clone)]
struct SwapState {
    identity: Option<Identity>,
    quotes: Option<Arc<UniswapQuotes>>,
    execution: Option<Arc<UniswapService>>,
}
impl SwapState {
    fn execution(&self) -> Result<&UniswapService, AppError> {
        self.execution.as_deref().ok_or(AppError::Unsupported(
            "Swap execution not configured".into(),
        ))
    }
    async fn profile(&self, headers: &HeaderMap, mutation: bool) -> Result<Profile, AppError> {
        let identity = self.identity.as_ref().ok_or(AppError::Unauthorized)?;
        let p = identity
            .authenticate(super::identity::bearer(headers)?)
            .await?;
        identity
            .rate_limit_pair(
                if mutation {
                    "swap_exec_mutation"
                } else {
                    "swap_exec_read"
                },
                &p.wallet.id.to_string(),
                if mutation { 60 } else { 600 },
                if mutation { 10 } else { 60 },
            )
            .await?;
        Ok(p)
    }
    fn service(&self) -> Result<&UniswapQuotes, AppError> {
        self.quotes
            .as_deref()
            .ok_or(AppError::Unsupported("Swap quotes not configured".into()))
    }
}
pub fn router(identity: Option<Identity>, quotes: Option<Arc<UniswapQuotes>>) -> Router {
    router_with_execution(identity, quotes, None)
}
pub fn router_with_execution(
    identity: Option<Identity>,
    quotes: Option<Arc<UniswapQuotes>>,
    execution: Option<Arc<UniswapService>>,
) -> Router {
    Router::new()
        .route("/swaps/configuration", get(configuration))
        .route("/swaps/quote", post(quote))
        .route("/swaps/execution", get(execution_configuration))
        .route("/swaps/operations", post(create))
        .route("/operations/{id}/swap-intent", get(intent))
        .route("/operations/{id}/swap-review", get(review))
        .route("/operations/{id}/swap-permit", post(permit))
        .route("/operations/{id}/swap-signing-request", get(signing))
        .route("/operations/{id}/swap-signed", post(submit))
        .with_state(SwapState {
            identity,
            quotes,
            execution,
        })
}
async fn configuration(
    State(s): State<SwapState>,
) -> Result<Json<SwapQuoteConfiguration>, AppError> {
    Ok(Json(s.service()?.configuration()))
}
async fn quote(
    State(s): State<SwapState>,
    headers: HeaderMap,
    body: Result<Json<SwapQuoteRequest>, JsonRejection>,
) -> Result<Json<SwapQuote>, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?;
    identity
        .rate_limit_shared("swap_quote", &profile.wallet.id.to_string(), 240, 10)
        .await?;
    let service = s.service()?;
    if profile.wallet.chain_id != format!("eip155:{}", service.configuration().chain_id) {
        return Err(AppError::Unsupported(
            "Sign in on the configured quote network".into(),
        ));
    }
    let Json(input) =
        body.map_err(|_| AppError::BadRequest("invalid swap quote request".into()))?;
    Ok(Json(service.quote(&profile.wallet.address, input).await?))
}

fn id(s: &str) -> Result<uuid::Uuid, AppError> {
    s.parse()
        .map_err(|_| AppError::BadRequest("invalid operation ID".into()))
}
async fn execution_configuration(
    State(s): State<SwapState>,
) -> Result<Json<SwapExecutionConfiguration>, AppError> {
    Ok(Json(s.execution()?.configuration()))
}
async fn create(
    State(s): State<SwapState>,
    headers: HeaderMap,
    body: Result<Json<CreateSwap>, JsonRejection>,
) -> Result<(StatusCode, Json<OperationRecovery>), AppError> {
    let p = s.profile(&headers, true).await?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid swap intent".into()))?;
    let key = super::idempotency_key(&headers)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(s.execution()?.create(&p, key, input).await?),
    ))
}
async fn intent(
    State(s): State<SwapState>,
    headers: HeaderMap,
    Path(raw): Path<String>,
) -> Result<Json<SwapIntentRecovery>, AppError> {
    let p = s.profile(&headers, false).await?;
    Ok(Json(s.execution()?.recover_intent(&p, id(&raw)?).await?))
}
async fn review(
    State(s): State<SwapState>,
    headers: HeaderMap,
    Path(raw): Path<String>,
) -> Result<Json<SwapReviewRequest>, AppError> {
    let p = s.profile(&headers, false).await?;
    Ok(Json(s.execution()?.review(&p, id(&raw)?).await?))
}
async fn signing(
    State(s): State<SwapState>,
    headers: HeaderMap,
    Path(raw): Path<String>,
) -> Result<Json<SwapSigningRequest>, AppError> {
    let p = s.profile(&headers, false).await?;
    Ok(Json(s.execution()?.signing_request(&p, id(&raw)?).await?))
}
async fn permit(
    State(s): State<SwapState>,
    headers: HeaderMap,
    Path(raw): Path<String>,
    body: Result<Json<SubmitSwapPermit>, JsonRejection>,
) -> Result<(StatusCode, Json<OperationRecovery>), AppError> {
    let p = s.profile(&headers, true).await?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid swap permit".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(s.execution()?.permit(&p, id(&raw)?, input).await?),
    ))
}
async fn submit(
    State(s): State<SwapState>,
    headers: HeaderMap,
    Path(raw): Path<String>,
    body: Result<Json<SubmitSwap>, JsonRejection>,
) -> Result<(StatusCode, Json<OperationRecovery>), AppError> {
    let p = s.profile(&headers, true).await?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid signed swap".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(s.execution()?.submit(&p, id(&raw)?, input).await?),
    ))
}
