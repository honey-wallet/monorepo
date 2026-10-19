use axum::{Json, Router, extract::State, http::HeaderMap, routing::get};

use crate::{
    error::AppError,
    hyperliquid_perps::{HyperliquidPerps, PerpsAccountState},
    identity::{Identity, Profile},
};

#[derive(Clone)]
struct StateData {
    identity: Option<Identity>,
    provider: Result<HyperliquidPerps, ()>,
    redis: Option<crate::redis_store::RedisStore>,
}

pub fn router(identity: Option<Identity>, redis: Option<crate::redis_store::RedisStore>) -> Router {
    Router::new()
        .route("/perps/hyperliquid/account", get(account))
        .with_state(StateData {
            identity,
            provider: HyperliquidPerps::new().map_err(|_| ()),
            redis,
        })
}

async fn account(
    State(state): State<StateData>,
    headers: HeaderMap,
) -> Result<Json<PerpsAccountState>, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile: Profile = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?;
    identity
        .rate_limit_pair("hyperliquid_read", &profile.wallet.id.to_string(), 600, 60)
        .await?;
    let provider = state.provider.as_ref().map_err(|_| AppError::Busy)?;
    let redis = state.redis.as_ref().ok_or(AppError::Busy)?;
    Ok(Json(
        provider
            .account_state(&profile.wallet.address, redis)
            .await?,
    ))
}
