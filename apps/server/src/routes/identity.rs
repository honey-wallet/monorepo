use std::net::{IpAddr, SocketAddr};

use axum::{
    Json, Router,
    extract::{ConnectInfo, State, rejection::JsonRejection},
    http::{HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{delete, get, post},
};

use crate::{
    error::AppError,
    identity::{
        AuthenticatedSession, Challenge, ChallengeRequest, Identity, LinkWalletChallengeRequest,
        LinkWalletRequest, Profile, RefreshRequest, VerifyRequest, WalletIdentity,
    },
};

#[derive(Clone)]
struct AuthState {
    identity: Option<Identity>,
    trust_proxy: bool,
    trusted_proxy_cidrs: Vec<crate::config::TrustedProxyCidr>,
}

/// Shared admission for routes that authenticate bearer tokens after entering
/// their handler. The wallet quota in those handlers cannot protect the session
/// lookup itself, so this peer quota runs first and is shared through Redis.
#[derive(Clone)]
pub(crate) struct AuthenticatedApiAdmission {
    redis: crate::redis_store::RedisStore,
    trust_proxy: bool,
    trusted_proxy_cidrs: Vec<crate::config::TrustedProxyCidr>,
    global_limit: i32,
    peer_limit: i32,
}

impl AuthenticatedApiAdmission {
    pub(crate) fn new(
        redis: crate::redis_store::RedisStore,
        trust_proxy: bool,
        trusted_proxy_cidrs: Vec<crate::config::TrustedProxyCidr>,
    ) -> Self {
        Self {
            redis,
            trust_proxy,
            trusted_proxy_cidrs,
            global_limit: AUTHENTICATED_API_GLOBAL_LIMIT,
            peer_limit: AUTHENTICATED_API_PEER_LIMIT,
        }
    }
}

const AUTHENTICATED_API_GLOBAL_LIMIT: i32 = 300_000;
const AUTHENTICATED_API_PEER_LIMIT: i32 = 6_000;
// Public Polymarket reads are cached and read-only, but a refresh miss still
// consumes Redis and provider admission. Bound them independently of auth state.
const PUBLIC_MARKET_GLOBAL_LIMIT: i32 = 300_000;
const PUBLIC_MARKET_PEER_LIMIT: i32 = 6_000;

impl AuthState {
    fn identity(&self) -> Result<&Identity, AppError> {
        self.identity.as_ref().ok_or(AppError::Unsupported(
            "wallet authentication not configured".into(),
        ))
    }
}

pub fn router(identity: Option<Identity>, trust_proxy: bool) -> Router {
    router_with_proxies(identity, trust_proxy, vec![])
}

pub fn router_with_proxies(
    identity: Option<Identity>,
    trust_proxy: bool,
    trusted_proxy_cidrs: Vec<crate::config::TrustedProxyCidr>,
) -> Router {
    let state = AuthState {
        identity,
        trust_proxy,
        trusted_proxy_cidrs,
    };
    let proofs = Router::new()
        .route("/auth/challenges", post(challenge))
        .route("/auth/verify", post(verify))
        .route("/auth/refresh", post(refresh))
        // Logout accepts unknown tokens as a no-op, so it must share proof
        // admission limits rather than allowing unauthenticated DB churn.
        .route("/auth/session", delete(logout))
        .route("/me/wallets/challenges", post(link_wallet_challenge))
        .route("/me/wallets", post(link_wallet))
        .route_layer(middleware::from_fn_with_state(state.clone(), limit_proofs));
    let profile = Router::new()
        .route("/me", get(me))
        .route("/me/wallets", get(wallets))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            limit_profile_reads,
        ));
    Router::new()
        .merge(proofs)
        .merge(profile)
        .route("/auth/config", get(configuration))
        .with_state(state)
}

/// Applied to the private API route group when runtime identity and Redis are
/// configured. Proof/profile routes live outside this group and retain their own
/// tighter IP quotas.
pub(crate) async fn limit_private_api_by_ip(
    State(state): State<AuthenticatedApiAdmission>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, AppError> {
    let ip = client_ip_from_request(state.trust_proxy, &state.trusted_proxy_cidrs, &request)?;
    let bucket = client_bucket(ip);
    // The global counter is shared across replicas; the peer cap is generous
    // for shared NATs while stopping one source from exhausting session lookups.
    state
        .redis
        .rate_limit_pair(
            "authenticated_api_ip",
            &bucket.to_string(),
            state.global_limit,
            state.peer_limit,
        )
        .await?;
    Ok(next.run(request).await)
}

/// Protect every route in the public market group before cache/provider work.
/// Market discovery is intentionally public and must remain protected even
/// when wallet auth is off.
pub(crate) async fn limit_public_market_reads_by_ip(
    State(state): State<AuthenticatedApiAdmission>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, AppError> {
    let ip = client_ip_from_request(state.trust_proxy, &state.trusted_proxy_cidrs, &request)?;
    state
        .redis
        .rate_limit_pair(
            "polymarket_public_read",
            &client_bucket(ip).to_string(),
            state.global_limit.min(PUBLIC_MARKET_GLOBAL_LIMIT),
            state.peer_limit.min(PUBLIC_MARKET_PEER_LIMIT),
        )
        .await?;
    Ok(next.run(request).await)
}

async fn configuration(
    State(state): State<AuthState>,
    headers: HeaderMap,
) -> Result<Json<crate::identity::AuthConfiguration>, AppError> {
    let origin = request_origin(&headers)?;
    Ok(Json(Identity::configuration(
        state.identity.as_ref(),
        origin.as_deref(),
    )?))
}

async fn limit_proofs(
    State(state): State<AuthState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, AppError> {
    let ip = client_ip(&state, &request)?;
    limit_by_ip(&state, ip, "proof", 1200, 30).await?;
    Ok(next.run(request).await)
}

async fn limit_profile_reads(
    State(state): State<AuthState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, AppError> {
    let ip = client_ip(&state, &request)?;
    limit_by_ip(&state, ip, "profile", 12_000, 1_200).await?;
    Ok(next.run(request).await)
}

fn client_ip(state: &AuthState, request: &Request<axum::body::Body>) -> Result<IpAddr, AppError> {
    client_ip_from_request(state.trust_proxy, &state.trusted_proxy_cidrs, request)
}

pub(crate) fn client_ip_from_request(
    trust_proxy: bool,
    trusted_proxy_cidrs: &[crate::config::TrustedProxyCidr],
    request: &Request<axum::body::Body>,
) -> Result<IpAddr, AppError> {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
        .ok_or(AppError::Busy)?;
    if trust_proxy && trusted_proxy_cidrs.iter().any(|cidr| cidr.contains(peer)) {
        request
            .headers()
            .get_all("x-forwarded-for")
            .iter()
            .next_back()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit(',').next()?.trim().parse().ok())
            .ok_or_else(|| AppError::BadRequest("missing client address".into()))
    } else {
        Ok(peer)
    }
}

pub(crate) fn client_bucket(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) => {
            let mut segments = v6.segments();
            segments[4..].fill(0);
            IpAddr::from(segments)
        }
        v4 => v4,
    }
}

async fn limit_by_ip(
    state: &AuthState,
    ip: IpAddr,
    scope: &str,
    global_limit: i32,
    ip_limit: i32,
) -> Result<(), AppError> {
    let identity = state.identity()?;
    let domain = match scope {
        "proof" => "identity-proof-ip",
        "profile" => "identity-profile-ip",
        _ => return Err(AppError::BadRequest("invalid identity quota scope".into())),
    };
    let bucket = client_bucket(ip);
    identity
        .rate_limit_pair(domain, &bucket.to_string(), global_limit, ip_limit)
        .await
}

async fn challenge(
    State(state): State<AuthState>,
    headers: HeaderMap,
    body: Result<Json<ChallengeRequest>, JsonRejection>,
) -> Result<Json<Challenge>, AppError> {
    let origin = request_origin(&headers)?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid challenge request".into()))?;
    Ok(Json(
        state
            .identity()?
            .challenge_for_origin(input, origin.as_deref())
            .await?,
    ))
}

fn request_origin(headers: &HeaderMap) -> Result<Option<String>, AppError> {
    let values = headers.get_all(axum::http::header::ORIGIN);
    let mut values = values.iter();
    let Some(origin) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(AppError::Unauthorized);
    }
    Ok(Some(
        origin
            .to_str()
            .map_err(|_| AppError::Unauthorized)?
            .to_owned(),
    ))
}

async fn verify(
    State(state): State<AuthState>,
    headers: HeaderMap,
    body: Result<Json<VerifyRequest>, JsonRejection>,
) -> Result<Json<AuthenticatedSession>, AppError> {
    let origin = request_origin(&headers)?;
    let Json(input) =
        body.map_err(|_| AppError::BadRequest("invalid verification request".into()))?;
    // Browser origins receive short-lived access only. Long-lived refresh secrets
    // are reserved for originless native clients with platform secure storage.
    Ok(Json(
        state
            .identity()?
            .verify_for_origin(input, origin.is_none(), origin.as_deref())
            .await?,
    ))
}

async fn refresh(
    State(state): State<AuthState>,
    headers: HeaderMap,
    body: Result<Json<RefreshRequest>, JsonRejection>,
) -> Result<Json<AuthenticatedSession>, AppError> {
    if headers.contains_key(axum::http::header::ORIGIN) {
        return Err(AppError::Unauthorized);
    }
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid refresh request".into()))?;
    Ok(Json(state.identity()?.refresh(input).await?))
}

async fn me(State(state): State<AuthState>, headers: HeaderMap) -> Result<Json<Profile>, AppError> {
    let identity = state.identity()?;
    let profile = identity.authenticate(bearer(&headers)?).await?;
    identity.rate_profile_read(profile.user_id).await?;
    Ok(Json(profile))
}

async fn wallets(
    State(state): State<AuthState>,
    headers: HeaderMap,
) -> Result<Json<Vec<WalletIdentity>>, AppError> {
    Ok(Json(state.identity()?.wallets(bearer(&headers)?).await?))
}

async fn link_wallet_challenge(
    State(state): State<AuthState>,
    headers: HeaderMap,
    body: Result<Json<LinkWalletChallengeRequest>, JsonRejection>,
) -> Result<Json<Challenge>, AppError> {
    let origin = request_origin(&headers)?;
    let Json(input) =
        body.map_err(|_| AppError::BadRequest("invalid wallet link challenge".into()))?;
    Ok(Json(
        state
            .identity()?
            .link_wallet_challenge(bearer(&headers)?, input, origin.as_deref())
            .await?,
    ))
}

async fn link_wallet(
    State(state): State<AuthState>,
    headers: HeaderMap,
    body: Result<Json<LinkWalletRequest>, JsonRejection>,
) -> Result<Json<WalletIdentity>, AppError> {
    let origin = request_origin(&headers)?;
    let Json(input) = body.map_err(|_| AppError::BadRequest("invalid wallet link proof".into()))?;
    Ok(Json(
        state
            .identity()?
            .link_wallet(bearer(&headers)?, input, origin.as_deref())
            .await?,
    ))
}

async fn logout(
    State(state): State<AuthState>,
    headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    state.identity()?.logout(bearer(&headers)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn bearer(headers: &HeaderMap) -> Result<&str, AppError> {
    let mut values = headers.get_all(axum::http::header::AUTHORIZATION).iter();
    let value = values
        .next()
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    if values.next().is_some() {
        return Err(AppError::Unauthorized);
    }
    let (scheme, token) = value.split_once(' ').ok_or(AppError::Unauthorized)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(AppError::Unauthorized);
    }
    Ok(token)
}

#[cfg(test)]
mod proxy_tests {
    use super::*;
    use axum::body::Body;

    fn state(trust_proxy: bool, trusted: &str) -> AuthState {
        AuthState {
            identity: None,
            trust_proxy,
            trusted_proxy_cidrs: vec![crate::config::TrustedProxyCidr::parse(trusted).unwrap()],
        }
    }

    fn request(peer: &str, forwarded: Option<&str>) -> Request<Body> {
        let mut request = Request::new(Body::empty());
        request
            .extensions_mut()
            .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
        if let Some(forwarded) = forwarded {
            request
                .headers_mut()
                .insert("x-forwarded-for", forwarded.parse().unwrap());
        }
        request
    }

    #[test]
    fn only_allowlisted_proxy_peers_can_select_forwarded_quota_identity() {
        let state = state(true, "10.20.0.0/16");
        assert_eq!(
            client_ip(&state, &request("10.20.1.9:8080", Some("192.0.2.1"))).unwrap(),
            "192.0.2.1".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            client_ip(&state, &request("127.0.0.1:8080", Some("192.0.2.1"))).unwrap(),
            "127.0.0.1".parse::<IpAddr>().unwrap()
        );
        assert!(client_ip(&state, &request("10.20.1.9:8080", None)).is_err());
    }

    #[tokio::test]
    #[ignore = "requires isolated TEST_REDIS_URL"]
    async fn public_market_admission_allows_then_denies_by_trusted_proxy_identity() {
        use axum::{Router, middleware, routing::get};
        use tower::ServiceExt;

        let redis = crate::redis_store::RedisStore::new(
            redis::Client::open(
                std::env::var("TEST_REDIS_URL").expect("set isolated TEST_REDIS_URL"),
            )
            .unwrap(),
            format!("test:{}", uuid::Uuid::new_v4().simple()),
            std::time::Duration::from_secs(1),
        );
        let mut state = AuthenticatedApiAdmission::new(
            redis,
            true,
            vec![crate::config::TrustedProxyCidr::parse("10.20.0.0/16").unwrap()],
        );
        state.global_limit = 10;
        state.peer_limit = 1;
        let app = Router::new()
            .route(
                "/api/v1/prediction/markets",
                get(|| async { StatusCode::NO_CONTENT }),
            )
            .route_layer(middleware::from_fn_with_state(
                state,
                limit_public_market_reads_by_ip,
            ));
        let request = |forwarded: &str| {
            let mut request = Request::builder()
                .uri("/api/v1/prediction/markets")
                .body(Body::empty())
                .unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo("10.20.1.9:8080".parse::<SocketAddr>().unwrap()));
            request
                .headers_mut()
                .insert("x-forwarded-for", forwarded.parse().unwrap());
            request
        };

        assert_eq!(
            app.clone()
                .oneshot(request("192.0.2.11"))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            app.clone()
                .oneshot(request("192.0.2.11"))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            app.oneshot(request("192.0.2.12")).await.unwrap().status(),
            StatusCode::NO_CONTENT,
            "forwarded clients must receive independent peer quotas"
        );
    }

    #[tokio::test]
    #[ignore = "requires isolated TEST_REDIS_URL"]
    async fn private_group_admission_precedes_handlers_and_proofs_stay_outside_group() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        use axum::{Router, middleware, routing::any};
        use tower::ServiceExt;

        let namespace = format!("test:{}", uuid::Uuid::new_v4().simple());
        let redis = crate::redis_store::RedisStore::new(
            redis::Client::open(
                std::env::var("TEST_REDIS_URL").expect("set isolated TEST_REDIS_URL"),
            )
            .unwrap(),
            namespace,
            std::time::Duration::from_secs(1),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let handler_calls = calls.clone();
        let config_calls = calls.clone();
        let mut state = AuthenticatedApiAdmission::new(redis, false, vec![]);
        state.global_limit = 10;
        state.peer_limit = 1;
        let private_api = Router::new()
            .route(
                "/api/v1/operations/{id}",
                any(move || {
                    let calls = handler_calls.clone();
                    async move {
                        // This represents the route's DB-backed session lookup.
                        calls.fetch_add(1, Ordering::SeqCst);
                        StatusCode::NO_CONTENT
                    }
                }),
            )
            .route(
                "/api/v1/earn/aave/execution",
                any(move || {
                    let calls = config_calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        StatusCode::NO_CONTENT
                    }
                }),
            )
            .route_layer(middleware::from_fn_with_state(
                state,
                limit_private_api_by_ip,
            ));
        let app = private_api.clone();
        let proof_app = Router::new().route(
            "/api/v1/auth/challenges",
            any(|| async { StatusCode::NO_CONTENT }),
        );
        let request = |path: &str| {
            let mut request = Request::builder()
                .uri(path)
                .header("authorization", format!("Bearer {}", "a".repeat(43)))
                .body(Body::empty())
                .unwrap();
            request.extensions_mut().insert(ConnectInfo(
                "198.51.100.42:45000".parse::<SocketAddr>().unwrap(),
            ));
            request
        };

        assert_eq!(
            app.clone()
                .oneshot(request(
                    "/api/v1/operations/00000000-0000-0000-0000-000000000001"
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            app.clone()
                .oneshot(request("/api/v1/earn/aave/execution"))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS,
            "every route in the private group gets pre-auth admission"
        );
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "/api/v1/operations/00000000-0000-0000-0000-000000000002"
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            proof_app
                .oneshot(request("/api/v1/auth/challenges"))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT,
            "proof routes are outside the private route group"
        );
    }

    #[tokio::test]
    async fn shared_admission_fails_closed_when_redis_is_unavailable() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        use axum::{Router, middleware, routing::get};
        use tower::ServiceExt;

        let calls = Arc::new(AtomicUsize::new(0));
        let handler_calls = calls.clone();
        let market_handler_calls = calls.clone();
        let redis = crate::redis_store::RedisStore::new(
            redis::Client::open("redis://127.0.0.1:1").unwrap(),
            format!("test:{}", uuid::Uuid::new_v4().simple()),
            std::time::Duration::from_millis(100),
        );
        let private_api = Router::new()
            .route(
                "/api/v1/operations/{id}",
                get(move || {
                    let calls = handler_calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        StatusCode::NO_CONTENT
                    }
                }),
            )
            .route_layer(middleware::from_fn_with_state(
                AuthenticatedApiAdmission::new(redis.clone(), false, vec![]),
                limit_private_api_by_ip,
            ));
        let public_markets = Router::new()
            .route(
                "/api/v1/prediction/markets",
                get(move || {
                    let calls = market_handler_calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        StatusCode::NO_CONTENT
                    }
                }),
            )
            .route_layer(middleware::from_fn_with_state(
                AuthenticatedApiAdmission::new(redis, false, vec![]),
                limit_public_market_reads_by_ip,
            ));
        let app = private_api.merge(public_markets);
        let request = |path: &str| {
            let mut request = Request::builder()
                .uri(path)
                .header("authorization", format!("Bearer {}", "b".repeat(43)))
                .body(Body::empty())
                .unwrap();
            request.extensions_mut().insert(ConnectInfo(
                "198.51.100.44:45000".parse::<SocketAddr>().unwrap(),
            ));
            request
        };
        assert_eq!(
            app.clone()
                .oneshot(request(
                    "/api/v1/operations/00000000-0000-0000-0000-000000000001",
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            app.oneshot(request("/api/v1/prediction/markets"))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
