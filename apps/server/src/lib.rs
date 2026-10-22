//! Honey Wallet API server.
//!
//! The router is built in the library (not `main.rs`) so integration tests
//! can drive it in-process without binding a port.
//!
//! # Custody model
//!
//! Honey Wallet is self-custodial: every seed, owner key, session key and
//! one-time signature key is generated, stored and used on the client. This
//! server must never receive, store or derive one. It only reads public chain
//! state, verifies session signatures against public keys, relays payloads the
//! client already signed, and logs exposure events. Any request type that would
//! carry key material is a design bug.

pub mod aave_service;
pub mod bridge_monitor;
pub mod chains;
pub mod clerk;
pub mod config;
pub mod database;
pub mod earn_catalog;
pub mod earn_service;
pub mod error;
pub mod evm_envelope;
pub mod exposure;
pub mod http_runtime;
pub mod hyperliquid_perps;
pub mod identity;
pub mod markets;
pub mod metrics;
pub mod monitoring;
pub mod morpho_service;
pub mod operation_history;
pub mod pairing_store;
pub mod preparation;
pub mod providers;
pub mod reconciliation;
pub mod redis_store;
pub mod relayer;
pub mod routes;
pub mod runtime;
pub mod session_signatures;
pub mod submissions;
pub mod supervision;
pub mod swap_review;
pub mod telemetry;
pub mod uniswap_service;
pub mod wallet;
pub mod work;

use axum::{Router, http::HeaderName, middleware};
use tower_http::cors::CorsLayer;

pub use config::{Config, ServerRole};

/// Builds the full application router with middleware applied.
pub fn build_router(config: &Config) -> Router {
    build_router_with_health(config, runtime::RuntimeHealth::new(config))
}

/// Production startup shares this health state with the dependency monitor and shutdown.
pub fn build_router_with_health(config: &Config, health: runtime::RuntimeHealth) -> Router {
    router(config, health, RouterServices::default())
}

/// Shares the single process pool with identity and all durable repositories.
pub fn build_router_with_infrastructure(
    config: &Config,
    health: runtime::RuntimeHealth,
    infrastructure: &runtime::Infrastructure,
) -> Result<Router, config::ConfigError> {
    if !config.server_role.serves_api() {
        return Ok(probe_router(
            config,
            health,
            infrastructure.metrics().clone(),
        ));
    }
    let identity = config
        .auth
        .clone()
        .zip(infrastructure.postgres().cloned())
        .map(|(policy, pool)| {
            identity::Identity::new(pool, policy)
                .map(|identity| identity.with_redis(infrastructure.redis().cloned()))
        })
        .transpose()?;
    let capability_adapters = routes::capabilities::RuntimeAdapters {
        aave: infrastructure.aave().is_some(),
        morpho: infrastructure.morpho().is_some(),
        uniswap_quotes: infrastructure.swaps().is_some(),
        uniswap_local_fork: infrastructure.uniswap().is_some(),
        near_intents_quotes: infrastructure.near_intents().is_some(),
        relay_quotes: infrastructure.relay_quotes().is_some(),
        earn_catalog: infrastructure.earn().is_some(),
        authenticated_identity: identity.is_some(),
        redis: infrastructure.redis().is_some(),
    };
    Ok(router(
        config,
        health,
        RouterServices {
            aave: infrastructure.aave().cloned(),
            morpho: infrastructure.morpho().cloned(),
            swaps: infrastructure.swaps().cloned(),
            uniswap: infrastructure.uniswap().cloned(),
            bridges: infrastructure.bridges().cloned(),
            near_intents: infrastructure.near_intents().cloned(),
            relay_quotes: infrastructure.relay_quotes().cloned(),
            identity,
            redis: infrastructure.redis().cloned(),
            markets: infrastructure.markets().cloned(),
            metrics: infrastructure.metrics().clone(),
            earn: infrastructure.earn().cloned(),
            work: infrastructure.postgres().cloned().map(work::WorkStore::new),
            capability_adapters,
        },
    ))
}

#[derive(Default)]
struct RouterServices {
    aave: Option<std::sync::Arc<aave_service::AaveService>>,
    morpho: Option<std::sync::Arc<morpho_service::MorphoService>>,
    swaps: Option<std::sync::Arc<providers::uniswap::UniswapQuotes>>,
    uniswap: Option<std::sync::Arc<uniswap_service::UniswapService>>,
    bridges: Option<std::sync::Arc<bridge_monitor::BridgeMonitor>>,
    near_intents: Option<std::sync::Arc<providers::near_intents::NearIntents>>,
    relay_quotes: Option<std::sync::Arc<providers::relay_quotes::RelayQuotes>>,
    identity: Option<identity::Identity>,
    redis: Option<redis_store::RedisStore>,
    markets: Option<std::sync::Arc<markets::MarketHub>>,
    metrics: std::sync::Arc<metrics::Metrics>,
    earn: Option<std::sync::Arc<earn_catalog::EarnCatalogHub>>,
    work: Option<work::WorkStore>,
    capability_adapters: routes::capabilities::RuntimeAdapters,
}

fn probe_router(
    config: &Config,
    health: runtime::RuntimeHealth,
    metrics: std::sync::Arc<metrics::Metrics>,
) -> Router {
    Router::new()
        .merge(routes::health::router())
        .merge(routes::health::readiness_router(health.clone()))
        .fallback(error::not_found)
        .layer(middleware::from_fn_with_state(
            http_runtime::HttpRuntime::with_metrics(config, health, metrics),
            http_runtime::envelope,
        ))
}

fn router(config: &Config, health: runtime::RuntimeHealth, services: RouterServices) -> Router {
    if !config.server_role.serves_api() {
        return probe_router(config, health, services.metrics);
    }
    let RouterServices {
        aave,
        morpho,
        swaps,
        uniswap,
        bridges,
        near_intents,
        relay_quotes,
        identity,
        redis,
        markets,
        metrics,
        earn,
        work,
        capability_adapters,
    } = services;
    // Clerk identity (optional). Config is validated at startup; a client that can't
    // be built leaves the feature off rather than failing the whole API.
    let clerk = clerk::ClerkVerifier::from_config(config).unwrap_or_else(|error| {
        tracing::error!(%error, "Clerk session verification disabled");
        None
    });
    let cors = CorsLayer::new()
        .allow_origin(config.cors_allowed_origins.clone())
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any)
        .expose_headers([
            HeaderName::from_static("x-request-id"),
            HeaderName::from_static("x-trace-id"),
            axum::http::header::RETRY_AFTER,
        ]);

    let public_markets = routes::polymarket::router(redis.clone().map(|store| {
        std::sync::Arc::new(routes::polymarket::PolymarketCatalogService::new(store))
    }));
    let public_markets = if let Some(redis) = redis.clone() {
        public_markets.route_layer(middleware::from_fn_with_state(
            routes::identity::AuthenticatedApiAdmission::new(
                redis,
                config.trust_proxy_headers,
                config.trusted_proxy_cidrs.clone(),
            ),
            routes::identity::limit_public_market_reads_by_ip,
        ))
    } else {
        public_markets
    };

    let mut api = routes::v1::router(config)
        .merge(routes::earn::router(earn))
        .merge(public_markets)
        .merge(routes::capabilities::router_with_runtime(
            markets.clone(),
            capability_adapters,
        ))
        .merge(routes::prices::router(markets, health.clone(), config))
        .merge(routes::pairing::router_with_proxies(
            config.trust_proxy_headers,
            config.trusted_proxy_cidrs.clone(),
            redis.clone().map(pairing_store::PairingStore::new),
        ))
        .merge(routes::waitlist::router(
            identity.clone(),
            config.trust_proxy_headers,
            config.trusted_proxy_cidrs.clone(),
        ))
        .merge(routes::identity::router_with_proxies(
            identity.clone(),
            config.trust_proxy_headers,
            config.trusted_proxy_cidrs.clone(),
        ));

    // All handlers that authenticate a bearer token live in one route group.
    // Applying peer/global admission to the group means adding a private route
    // cannot silently omit protection before session lookup. Configuration GETs
    // colocated with these handlers also receive the generous IP-level budget;
    // their route-specific wallet quotas remain in the handlers that need them.
    let private_api = Router::new()
        .merge(routes::clerk::router(clerk))
        .merge(routes::operations::router(identity.clone(), work))
        .merge(routes::bridges::router(identity.clone(), bridges))
        .merge(routes::near_intents::router(identity.clone(), near_intents))
        .merge(routes::relay_quotes::router(identity.clone(), relay_quotes))
        .merge(routes::aave::router(identity.clone(), aave))
        .merge(routes::morpho::router(identity.clone(), morpho))
        .merge(routes::hyperliquid::router(identity.clone(), redis.clone()))
        .merge(routes::swaps::router_with_execution(
            identity.clone(),
            swaps,
            uniswap,
        ));
    let private_api = if let (Some(_), Some(redis)) = (identity.as_ref(), redis.clone()) {
        private_api.route_layer(middleware::from_fn_with_state(
            routes::identity::AuthenticatedApiAdmission::new(
                redis,
                config.trust_proxy_headers,
                config.trusted_proxy_cidrs.clone(),
            ),
            routes::identity::limit_private_api_by_ip,
        ))
    } else {
        private_api
    };
    api = api.merge(private_api);
    Router::new()
        .merge(routes::health::router())
        .merge(routes::health::readiness_router(health.clone()))
        .nest("/api/v1", api)
        .fallback(error::not_found)
        .layer(middleware::from_fn_with_state(
            http_runtime::HttpRuntime::with_metrics(config, health, metrics),
            http_runtime::envelope,
        ))
        // CORS must decorate overload/body-limit/timeout responses too, so web
        // clients can read their error envelope and diagnostic headers.
        .layer(cors)
}

#[cfg(test)]
mod role_router_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn worker_exposes_only_probes() {
        let config = Config {
            server_role: ServerRole::Worker,
            ..Config::default()
        };
        let app = build_router(&config);
        for path in [
            "/api/v1/version",
            "/api/v1/capabilities",
            "/api/v1/prices",
            "/api/v1/auth/challenge",
        ] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
        for path in ["/health", "/ready"] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
        }
    }

    #[tokio::test]
    async fn configured_worker_is_not_ready_before_dependency_probe() {
        let config = Config {
            server_role: ServerRole::Worker,
            redis_url: Some(config::SecretUrl::new("redis://127.0.0.1:6379".into())),
            ..Config::default()
        };
        config.validate().unwrap();
        let infrastructure = runtime::Infrastructure::new(&config).unwrap();
        let health = runtime::RuntimeHealth::new(&config);
        let app = build_router_with_infrastructure(&config, health, &infrastructure).unwrap();
        for (method, path, expected) in [
            ("GET", "/health", StatusCode::OK),
            ("GET", "/ready", StatusCode::SERVICE_UNAVAILABLE),
            ("GET", "/api/v1/capabilities", StatusCode::NOT_FOUND),
            ("GET", "/api/v1/prices", StatusCode::NOT_FOUND),
            ("POST", "/api/v1/auth/challenge", StatusCode::NOT_FOUND),
            ("GET", "/api/v1/operations", StatusCode::NOT_FOUND),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "{method} {path}");
        }
        infrastructure.close().await;
    }

    #[tokio::test]
    async fn api_and_combined_keep_product_routes() {
        for server_role in [ServerRole::Api, ServerRole::Combined] {
            let config = Config {
                server_role,
                ..Config::default()
            };
            let response = build_router(&config)
                .oneshot(
                    Request::builder()
                        .uri("/api/v1/capabilities")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
    }
}
