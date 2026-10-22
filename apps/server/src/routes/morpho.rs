use super::operation_id as parse_id;
use crate::{
    error::AppError,
    identity::{Identity, Profile},
    morpho_service::{
        CreateMorpho, MorphoExecutionConfiguration, MorphoService, MorphoSigningRequest,
        SubmitMorpho,
    },
    preparation::OperationRecovery,
};
use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use std::sync::Arc;
#[derive(Clone)]
struct MorphoState {
    identity: Option<Identity>,
    service: Option<Arc<MorphoService>>,
}
impl MorphoState {
    fn service(&self) -> Result<&MorphoService, AppError> {
        self.service.as_deref().ok_or(AppError::Unsupported(
            "Morpho execution not configured".into(),
        ))
    }
    async fn profile(&self, headers: &HeaderMap, mutation: bool) -> Result<Profile, AppError> {
        super::execution_profile(
            self.identity.as_ref(),
            headers,
            mutation,
            ("morpho_read", "morpho_mutation"),
        )
        .await
    }
}
pub fn router(identity: Option<Identity>, service: Option<Arc<MorphoService>>) -> Router {
    Router::new()
        .route("/earn/morpho/execution", get(configuration))
        .route("/earn/morpho/operations", post(create))
        .route("/earn/morpho/quote", post(quote))
        .route("/operations/{id}/morpho-signing-request", get(signing))
        .route("/operations/{id}/morpho-intent", get(intent))
        .route("/operations/{id}/morpho-signed", post(submit))
        .with_state(MorphoState { identity, service })
}
async fn quote(
    State(s): State<MorphoState>,
    headers: HeaderMap,
    body: Result<Json<crate::morpho_service::QuoteMorpho>, JsonRejection>,
) -> Result<Json<crate::providers::morpho_execution::MorphoQuote>, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?;
    identity
        .rate_limit_shared("morpho_quote", &profile.wallet.id.to_string(), 600, 60)
        .await?;
    let Json(input) =
        body.map_err(|_| AppError::BadRequest("invalid Morpho quote request".into()))?;
    Ok(Json(s.service()?.quote(&profile, input).await?))
}
async fn configuration(
    State(s): State<MorphoState>,
) -> Result<Json<MorphoExecutionConfiguration>, AppError> {
    Ok(Json(s.service()?.configuration()))
}
async fn create(
    State(s): State<MorphoState>,
    headers: HeaderMap,
    body: Result<Json<CreateMorpho>, JsonRejection>,
) -> Result<(StatusCode, Json<OperationRecovery>), AppError> {
    let profile = s.profile(&headers, true).await?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid Morpho intent".into()))?;
    let key = super::idempotency_key(&headers)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(s.service()?.create(&profile, key, input).await?),
    ))
}
async fn signing(
    State(s): State<MorphoState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<MorphoSigningRequest>, AppError> {
    let profile = s.profile(&headers, false).await?;
    Ok(Json(
        s.service()?
            .signing_request(&profile, parse_id(&id)?)
            .await?,
    ))
}
async fn submit(
    State(s): State<MorphoState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<SubmitMorpho>, JsonRejection>,
) -> Result<(StatusCode, Json<OperationRecovery>), AppError> {
    let profile = s.profile(&headers, true).await?;
    let Json(input) =
        body.map_err(|_| AppError::BadRequest("invalid signed transaction request".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(s.service()?.submit(&profile, parse_id(&id)?, input).await?),
    ))
}

async fn intent(
    State(s): State<MorphoState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<crate::morpho_service::MorphoIntentRecovery>, AppError> {
    let profile = s.profile(&headers, false).await?;
    Ok(Json(
        s.service()?
            .recover_intent(&profile, parse_id(&id)?)
            .await?,
    ))
}
