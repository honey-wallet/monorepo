//! Authenticated quote reads. These endpoints never authorize a transfer.
use crate::{
    error::AppError,
    identity::Identity,
    providers::across_quotes::{AcrossQuote, AcrossQuoteRequest, AcrossQuotes},
};
use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use std::sync::Arc;

#[derive(Clone)]
struct AcrossState {
    identity: Option<Identity>,
    quotes: Option<Arc<AcrossQuotes>>,
    execution: Option<Arc<crate::across_service::AcrossService>>,
}
impl AcrossState {
    fn service(&self) -> Result<&AcrossQuotes, AppError> {
        self.quotes
            .as_deref()
            .ok_or(AppError::Unsupported("Across quotes not configured".into()))
    }
}

pub fn router(
    identity: Option<Identity>,
    quotes: Option<Arc<AcrossQuotes>>,
    execution: Option<Arc<crate::across_service::AcrossService>>,
) -> Router {
    Router::new()
        .route("/bridges/across/configuration", get(configuration))
        .route("/bridges/across/execution", get(execution_configuration))
        .route("/bridges/across/quote", post(quote))
        .route("/bridges/across/operations", post(create))
        .route("/operations/{id}/across-intent", get(intent))
        .route(
            "/operations/{id}/across-signing-request",
            get(signing_request),
        )
        .route("/operations/{id}/across-signed", post(submit))
        .with_state(AcrossState {
            identity,
            quotes,
            execution,
        })
}

async fn execution_configuration(
    State(s): State<AcrossState>,
) -> Result<Json<crate::across_service::AcrossExecutionConfiguration>, AppError> {
    Ok(Json(
        s.execution
            .as_ref()
            .ok_or(AppError::Unsupported(
                "Across execution is not enabled".into(),
            ))?
            .configuration(),
    ))
}

async fn configuration(State(s): State<AcrossState>) -> Result<Json<serde_json::Value>, AppError> {
    let configuration = if let Some(e) = &s.execution {
        e.configuration().quote
    } else {
        s.service()?.configuration().clone()
    };
    Ok(Json(
        serde_json::to_value(configuration).map_err(|_| AppError::Busy)?,
    ))
}

async fn quote(
    State(s): State<AcrossState>,
    headers: HeaderMap,
    body: Result<Json<AcrossQuoteRequest>, JsonRejection>,
) -> Result<Json<AcrossQuote>, AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?;
    identity
        .rate_limit_shared("across_quote", &profile.wallet.id.to_string(), 240, 10)
        .await?;
    let source_chain = s
        .execution
        .as_ref()
        .map(|e| e.configuration().quote.source_chain_id)
        .or_else(|| {
            s.quotes
                .as_ref()
                .map(|q| q.configuration().source_chain_id.clone())
        })
        .ok_or(AppError::Unsupported("Across quotes not configured".into()))?;
    if profile.wallet.chain_id != format!("eip155:{}", source_chain) {
        return Err(AppError::Unsupported(
            "Sign in on the configured bridge network".into(),
        ));
    }
    let Json(input) =
        body.map_err(|_| AppError::BadRequest("invalid Across quote request".into()))?;
    if let Some(execution) = &s.execution {
        return Ok(Json(execution.quote(&profile, &input).await?));
    }
    let service = s.service()?;
    Ok(Json(
        service
            .quote(&profile.wallet.address, &input)
            .await?
            .quote()
            .clone(),
    ))
}

async fn create(
    State(s): State<AcrossState>,
    headers: HeaderMap,
    body: Result<Json<crate::across_service::CreateAcross>, JsonRejection>,
) -> Result<(StatusCode, Json<crate::preparation::OperationRecovery>), AppError> {
    let identity = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let profile = identity
        .authenticate(super::identity::bearer(&headers)?)
        .await?;
    identity
        .rate_limit_pair("across_create", &profile.wallet.id.to_string(), 120, 10)
        .await?;
    let key = super::idempotency_key(&headers)?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid Across operation".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            s.execution
                .as_ref()
                .ok_or(AppError::Unsupported(
                    "Across execution is not enabled".into(),
                ))?
                .create(&profile, key, input)
                .await?,
        ),
    ))
}
async fn intent(
    State(s): State<AcrossState>,
    headers: HeaderMap,
    axum::extract::Path(raw_id): axum::extract::Path<String>,
) -> Result<Json<crate::across_service::AcrossIntentRecovery>, AppError> {
    let i = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let p = i.authenticate(super::identity::bearer(&headers)?).await?;
    // Match the provider read policy: cap aggregate operation-recovery work as
    // well as requests from a single wallet. A subject-only quota scales with
    // attacker-controlled wallet count.
    i.rate_limit_pair("across_intent", &p.wallet.id.to_string(), 600, 60)
        .await?;
    let id = parse_id(&raw_id)?;
    Ok(Json(
        s.execution
            .as_ref()
            .ok_or(AppError::Unsupported(
                "Across execution is not enabled".into(),
            ))?
            .recover_intent(&p, id)
            .await?,
    ))
}
async fn signing_request(
    State(s): State<AcrossState>,
    headers: HeaderMap,
    axum::extract::Path(raw_id): axum::extract::Path<String>,
) -> Result<Json<crate::across_service::AcrossSigningRequest>, AppError> {
    let i = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let p = i.authenticate(super::identity::bearer(&headers)?).await?;
    i.rate_limit_pair("across_signing", &p.wallet.id.to_string(), 120, 20)
        .await?;
    let id = parse_id(&raw_id)?;
    Ok(Json(
        s.execution
            .as_ref()
            .ok_or(AppError::Unsupported(
                "Across execution is not enabled".into(),
            ))?
            .signing_request(&p, id)
            .await?,
    ))
}
async fn submit(
    State(s): State<AcrossState>,
    headers: HeaderMap,
    axum::extract::Path(raw_id): axum::extract::Path<String>,
    body: Result<Json<crate::across_service::SubmitAcross>, JsonRejection>,
) -> Result<(StatusCode, Json<crate::preparation::OperationRecovery>), AppError> {
    let i = s.identity.as_ref().ok_or(AppError::Unauthorized)?;
    let p = i.authenticate(super::identity::bearer(&headers)?).await?;
    i.rate_limit_pair("across_submit", &p.wallet.id.to_string(), 120, 10)
        .await?;
    let id = parse_id(&raw_id)?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid signed operation".into()))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            s.execution
                .as_ref()
                .ok_or(AppError::Unsupported(
                    "Across execution is not enabled".into(),
                ))?
                .submit(&p, id, input)
                .await?,
        ),
    ))
}

fn parse_id(id: &str) -> Result<uuid::Uuid, AppError> {
    id.parse()
        .map_err(|_| AppError::BadRequest("invalid operation ID".into()))
}
