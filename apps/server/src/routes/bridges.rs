//! Owner-scoped observation recovery only; never a public register/send command.
use crate::{
    bridge_monitor::{BridgeMonitor, BridgeStatusRecovery},
    error::AppError,
    identity::Identity,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::get,
};
use std::sync::Arc;
#[derive(Clone)]
struct BridgeState {
    identity: Option<Identity>,
    monitor: Option<Arc<BridgeMonitor>>,
}
pub fn router(identity: Option<Identity>, monitor: Option<Arc<BridgeMonitor>>) -> Router {
    Router::new()
        .route("/operations/{id}/bridge-status", get(recover))
        .with_state(BridgeState { identity, monitor })
}
async fn recover(
    State(s): State<BridgeState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<BridgeStatusRecovery>, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?;
    identity
        .rate_limit_pair("bridge_read", &profile.wallet.id.to_string(), 600, 60)
        .await?;
    let id = super::operation_id(&id)?;
    Ok(Json(
        s.monitor
            .as_ref()
            .ok_or(AppError::Busy)?
            .recover(profile.user_id, profile.wallet.id, id)
            .await?,
    ))
}
