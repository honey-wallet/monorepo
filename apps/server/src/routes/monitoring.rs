use axum::{Json, Router, routing::get};

use crate::{error::AppError, monitoring::TriggerStatus};

pub fn router() -> Router {
    Router::new().route("/monitoring/triggers", get(triggers))
}

async fn triggers() -> Result<Json<Vec<TriggerStatus>>, AppError> {
    // TODO(spec §12): return the background monitor's latest results.
    Err(AppError::NotImplemented("monitoring.triggers"))
}
