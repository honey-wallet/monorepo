//! Public launch waitlist: `POST /api/v1/waitlist`.
//!
//! Joining is idempotent and always answers with the same body, so the endpoint
//! does not reveal whether an address was already on the list. Emails are never
//! logged; the IP limiter hashes its subject before storage.

use axum::{
    Json, Router,
    extract::{FromRequest, State},
    http::Request,
    routing::post,
};
use serde::{Deserialize, Serialize};

use crate::{error::AppError, identity::Identity};

const WAITLIST_GLOBAL_LIMIT: i32 = 6_000;
const WAITLIST_PEER_LIMIT: i32 = 10;
const SOURCES: [&str; 3] = ["web", "extension", "mobile"];

#[derive(Clone)]
struct WaitlistState {
    identity: Option<Identity>,
    trust_proxy: bool,
    trusted_proxy_cidrs: Vec<crate::config::TrustedProxyCidr>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaitlistRequest {
    pub email: String,
    #[serde(default)]
    pub source: Option<String>,
}

/// Response shape mirrored in `packages/api-client/src/types.ts`.
#[derive(Serialize)]
pub struct WaitlistResponse {
    status: &'static str,
}

pub fn router(
    identity: Option<Identity>,
    trust_proxy: bool,
    trusted_proxy_cidrs: Vec<crate::config::TrustedProxyCidr>,
) -> Router {
    Router::new()
        .route("/waitlist", post(join))
        .with_state(WaitlistState {
            identity,
            trust_proxy,
            trusted_proxy_cidrs,
        })
}

#[tracing::instrument(name = "waitlist.join", skip_all)]
async fn join(
    State(state): State<WaitlistState>,
    request: Request<axum::body::Body>,
) -> Result<Json<WaitlistResponse>, AppError> {
    let identity = state.identity.as_ref().ok_or(AppError::Unsupported(
        "waitlist storage not configured".into(),
    ))?;
    let ip = super::identity::client_ip_from_request(
        state.trust_proxy,
        &state.trusted_proxy_cidrs,
        &request,
    )?;
    identity
        .rate_limit_shared(
            "waitlist",
            &super::identity::client_bucket(ip).to_string(),
            WAITLIST_GLOBAL_LIMIT,
            WAITLIST_PEER_LIMIT,
        )
        .await?;
    let Json(body) = Json::<WaitlistRequest>::from_request(request, &())
        .await
        .map_err(|_| AppError::BadRequest("expected {\"email\": string}".into()))?;

    let email = normalize_email(&body.email)
        .ok_or_else(|| AppError::BadRequest("enter a valid email address".into()))?;
    let source = match body.source.as_deref() {
        None => "web",
        Some(source) => SOURCES
            .into_iter()
            .find(|known| *known == source)
            .ok_or_else(|| AppError::BadRequest("unknown waitlist source".into()))?,
    };
    sqlx::query(
        "INSERT INTO waitlist(email, source) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING",
    )
    .bind(&email)
    .bind(source)
    .execute(identity.pool())
    .await
    .map_err(crate::identity::unavailable)?;
    Ok(Json(WaitlistResponse { status: "joined" }))
}

/// Trims and lowercases an address, accepting only a conservative shape:
/// `local@domain.tld`, no whitespace or control characters, at most 254 bytes.
pub fn normalize_email(raw: &str) -> Option<String> {
    let email = raw.trim().to_lowercase();
    if email.len() > 254 || email.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let (local, domain) = email.split_once('@')?;
    let labels_ok = domain.split('.').count() >= 2
        && domain.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || !c.is_ascii())
        });
    let local_ok = !local.is_empty()
        && local.len() <= 64
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && !local.contains(['"', '(', ')', ',', ':', ';', '<', '>', '[', '\\', ']', '@']);
    (local_ok && labels_ok).then_some(email)
}

#[cfg(test)]
mod tests {
    use super::normalize_email;

    #[test]
    fn emails_are_trimmed_lowercased_and_conservatively_validated() {
        assert_eq!(
            normalize_email("  Ada.Lovelace+honey@Example.COM ").as_deref(),
            Some("ada.lovelace+honey@example.com")
        );
        for invalid in [
            "",
            "no-at-sign",
            "@example.com",
            "a@",
            "a@localhost",
            "a@@example.com",
            "a b@example.com",
            "a@exa mple.com",
            ".a@example.com",
            "a..b@example.com",
            "a@-example.com",
            "a@example..com",
        ] {
            assert!(normalize_email(invalid).is_none(), "{invalid}");
        }
        assert!(normalize_email(&format!("{}@example.com", "a".repeat(65))).is_none());
    }
}
