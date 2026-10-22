use crate::{error::AppError, identity::Identity, preparation::OperationRecovery, work::WorkStore};
use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::HeaderMap,
    routing::get,
};
use uuid::Uuid;

#[derive(Clone)]
struct OperationState {
    identity: Option<Identity>,
    work: Option<WorkStore>,
}
pub fn router(identity: Option<Identity>, work: Option<WorkStore>) -> Router {
    Router::new()
        .route("/operations", get(list))
        .route("/operations/{id}", get(recover))
        .with_state(OperationState { identity, work })
}
async fn recover(
    State(state): State<OperationState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<OperationRecovery>, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unsupported(
        "wallet authentication not configured".into(),
    ))?;
    let profile = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?;
    // Low-volume recovery only; not a per-frame stream or wallet history query.
    identity
        .rate_limit_scoped("operation_read", &profile.wallet.id.to_string(), 60)
        .await?;
    let id = super::operation_id(&id)?;
    let work = state.work.as_ref().ok_or(AppError::Busy)?;
    Ok(Json(
        work.recover(profile.user_id, profile.wallet.id, id).await?,
    ))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    cursor: Option<Uuid>,
    limit: Option<u16>,
}
async fn list(
    State(state): State<OperationState>,
    headers: HeaderMap,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<crate::operation_history::OperationPage>, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?;
    identity
        .rate_limit_scoped("operation_list", &profile.wallet.id.to_string(), 30)
        .await?;
    let Query(query) =
        query.map_err(|_| AppError::BadRequest("invalid operation page query".into()))?;
    let work = state.work.as_ref().ok_or(AppError::Busy)?;
    Ok(Json(
        work.list_operations(
            profile.user_id,
            profile.wallet.id,
            query.cursor,
            query.limit.unwrap_or(20),
        )
        .await?,
    ))
}
