use super::operation_id as parse_id;
use crate::{
    aave_service::{
        AaveService, AaveSigningRequest, CreateAave, ExecutionConfiguration, SubmitAave,
    },
    error::AppError,
    identity::{Identity, Profile},
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
struct AaveState {
    identity: Option<Identity>,
    service: Option<Arc<AaveService>>,
}
impl AaveState {
    fn service(&self) -> Result<&AaveService, AppError> {
        self.service.as_deref().ok_or(AppError::Unsupported(
            "Aave execution not configured".into(),
        ))
    }
    async fn profile(&self, headers: &HeaderMap, mutation: bool) -> Result<Profile, AppError> {
        super::execution_profile(
            self.identity.as_ref(),
            headers,
            mutation,
            ("aave_read", "aave_mutation"),
        )
        .await
    }
}
pub fn router(identity: Option<Identity>, service: Option<Arc<AaveService>>) -> Router {
    Router::new()
        .route("/earn/aave/execution", get(configuration))
        .route("/earn/aave/operations", post(create))
        .route("/operations/{id}/signing-request", get(signing))
        .route("/operations/{id}/aave-intent", get(intent))
        .route("/operations/{id}/signed", post(submit))
        .with_state(AaveState { identity, service })
}
async fn configuration(
    State(s): State<AaveState>,
) -> Result<Json<ExecutionConfiguration>, AppError> {
    Ok(Json(s.service()?.configuration()))
}
async fn create(
    State(s): State<AaveState>,
    headers: HeaderMap,
    body: Result<Json<CreateAave>, JsonRejection>,
) -> Result<(StatusCode, Json<OperationRecovery>), AppError> {
    let profile = s.profile(&headers, true).await?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid Aave intent".into()))?;
    let key = super::idempotency_key(&headers)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(s.service()?.create(&profile, key, input).await?),
    ))
}
async fn signing(
    State(s): State<AaveState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<AaveSigningRequest>, AppError> {
    let profile = s.profile(&headers, false).await?;
    Ok(Json(
        s.service()?
            .signing_request(&profile, parse_id(&id)?)
            .await?,
    ))
}
async fn submit(
    State(s): State<AaveState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Result<Json<SubmitAave>, JsonRejection>,
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
    State(s): State<AaveState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<crate::aave_service::AaveIntentRecovery>, AppError> {
    let profile = s.profile(&headers, false).await?;
    Ok(Json(
        s.service()?
            .recover_intent(&profile, parse_id(&id)?)
            .await?,
    ))
}
