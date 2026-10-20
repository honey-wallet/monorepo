//! Runtime product availability, distinct from the old theoretical chain table.

use crate::markets::MarketHub;
use axum::{Json, Router, extract::State, routing::get};
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone, Copy, Default)]
pub struct RuntimeAdapters {
    pub aave: bool,
    pub morpho: bool,
    pub uniswap_quotes: bool,
    pub uniswap_local_fork: bool,
    pub near_intents_quotes: bool,
    pub relay_quotes: bool,
    pub earn_catalog: bool,
    pub authenticated_identity: bool,
    pub redis: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    schema_version: u8,
    features: Vec<Feature>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Feature {
    id: &'static str,
    available: bool,
    scope: &'static str,
    reason: &'static str,
    /// Planned integration identities; inclusion does not mean the adapter is live.
    providers: &'static [&'static str],
    /// Runtime adapters that are configured in this process.
    configured_providers: Vec<&'static str>,
}

pub fn router() -> Router {
    router_with_prices(None)
}

pub fn router_with_prices(hub: Option<Arc<MarketHub>>) -> Router {
    router_with_runtime(hub, RuntimeAdapters::default())
}

pub fn router_with_runtime(hub: Option<Arc<MarketHub>>, adapters: RuntimeAdapters) -> Router {
    Router::new()
        .route("/capabilities", get(capabilities))
        .with_state((hub, adapters))
}

async fn capabilities(
    State((hub, adapters)): State<(Option<Arc<MarketHub>>, RuntimeAdapters)>,
) -> Json<Capabilities> {
    // This is deliberately not configurable: an environment flag cannot implement
    // authentication, signer validation or reconciliation for an absent adapter.
    let mut features: Vec<Feature> = [
        ("portfolio", &[][..]),
        ("transfers", &[][..]),
        ("swap", &["uniswap"][..]),
        ("swap_quotes", &["uniswap"][..]),
        ("bridge", &["relay", "near_intents"][..]),
        ("bridge_quotes", &["relay", "near_intents"][..]),
        ("earn", &["morpho", "aave"][..]),
        ("earn_catalog", &["morpho", "aave"][..]),
        ("perps", &["hyperliquid"][..]),
        ("perps_account", &["hyperliquid"][..]),
        ("predictions", &["polymarket"][..]),
        ("prediction_markets", &["polymarket"][..]),
        ("shared_wallets", &[][..]),
        ("recovery", &[][..]),
        ("price_stream", &[][..]),
    ]
    .into_iter()
    .map(|(id, providers)| Feature {
        id,
        available: false,
        scope: "unavailable",
        reason: "not_implemented",
        providers,
        configured_providers: Vec::new(),
    })
    .collect();
    let set_feature = |features: &mut Vec<Feature>, id, available, scope, reason| {
        if let Some(feature) = features.iter_mut().find(|feature| feature.id == id) {
            feature.available = available;
            feature.scope = scope;
            feature.reason = reason;
        }
    };
    if adapters.uniswap_local_fork {
        set_feature(
            &mut features,
            "swap",
            false,
            "local_testnet",
            "local_testnet_only",
        );
        if let Some(f) = features.iter_mut().find(|f| f.id == "swap") {
            f.configured_providers.push("uniswap");
        }
    } else {
        set_feature(
            &mut features,
            "swap",
            false,
            "unavailable",
            "not_configured",
        );
    }
    if adapters.uniswap_quotes {
        set_feature(
            &mut features,
            "swap_quotes",
            true,
            "read_only",
            "quote_preview_only",
        );
        if let Some(f) = features.iter_mut().find(|f| f.id == "swap_quotes") {
            f.configured_providers.push("uniswap");
        }
    } else {
        set_feature(
            &mut features,
            "swap_quotes",
            false,
            "unavailable",
            "not_configured",
        );
    }
    set_feature(
        &mut features,
        "bridge",
        false,
        "unavailable",
        "not_configured",
    );
    let bridge_quotes = adapters.near_intents_quotes || adapters.relay_quotes;
    if bridge_quotes {
        set_feature(
            &mut features,
            "bridge_quotes",
            true,
            "read_only",
            "quote_preview_only",
        );
        if let Some(f) = features.iter_mut().find(|f| f.id == "bridge_quotes") {
            if adapters.relay_quotes {
                f.configured_providers.push("relay");
            }
            if adapters.near_intents_quotes {
                f.configured_providers.push("near_intents");
            }
        }
    } else {
        set_feature(
            &mut features,
            "bridge_quotes",
            false,
            "unavailable",
            "not_configured",
        );
    }
    if adapters.aave || adapters.morpho {
        set_feature(
            &mut features,
            "earn",
            false,
            "local_testnet",
            "local_testnet_only",
        );
        if let Some(f) = features.iter_mut().find(|f| f.id == "earn") {
            if adapters.morpho {
                f.configured_providers.push("morpho");
            }
            if adapters.aave {
                f.configured_providers.push("aave");
            }
        }
    } else {
        set_feature(
            &mut features,
            "earn",
            false,
            "unavailable",
            "not_configured",
        );
    }
    if adapters.earn_catalog {
        set_feature(
            &mut features,
            "earn_catalog",
            true,
            "read_only",
            "catalog_only",
        );
        if let Some(f) = features.iter_mut().find(|f| f.id == "earn_catalog") {
            if adapters.morpho {
                f.configured_providers.push("morpho");
            }
            if adapters.aave {
                f.configured_providers.push("aave");
            }
        }
    } else {
        set_feature(
            &mut features,
            "earn_catalog",
            false,
            "unavailable",
            "not_configured",
        );
    }
    if adapters.authenticated_identity {
        set_feature(
            &mut features,
            "perps",
            false,
            "unavailable",
            "not_implemented",
        );
        set_feature(
            &mut features,
            "perps_account",
            true,
            "read_only",
            "account_read_only",
        );
        if let Some(f) = features.iter_mut().find(|f| f.id == "perps_account") {
            f.configured_providers.push("hyperliquid");
        }
    } else {
        set_feature(
            &mut features,
            "perps",
            false,
            "unavailable",
            "not_implemented",
        );
        set_feature(
            &mut features,
            "perps_account",
            false,
            "unavailable",
            "authentication_not_configured",
        );
    }
    if adapters.redis {
        set_feature(
            &mut features,
            "predictions",
            false,
            "unavailable",
            "not_implemented",
        );
        set_feature(
            &mut features,
            "prediction_markets",
            true,
            "read_only",
            "market_catalog_only",
        );
        if let Some(f) = features.iter_mut().find(|f| f.id == "prediction_markets") {
            f.configured_providers.push("polymarket");
        }
    } else {
        set_feature(
            &mut features,
            "predictions",
            false,
            "unavailable",
            "not_implemented",
        );
        set_feature(
            &mut features,
            "prediction_markets",
            false,
            "unavailable",
            "not_configured",
        );
    }
    if let Some(hub) = hub
        && let Some(feature) = features.iter_mut().find(|f| f.id == "price_stream")
    {
        feature.scope = "read_only";
        let snapshot = hub.snapshot();
        feature.available = snapshot.as_ref().is_some_and(|s| !s.stale);
        feature.reason = if feature.available {
            "available"
        } else if snapshot.is_some() {
            "stale"
        } else {
            "warming_up"
        };
        feature.providers = &["hyperliquid"];
        feature.configured_providers = vec!["hyperliquid"];
    } else if let Some(feature) = features.iter_mut().find(|f| f.id == "price_stream") {
        feature.reason = "not_configured";
    }
    Json(Capabilities {
        schema_version: 3,
        features,
    })
}

#[cfg(test)]
mod tests {
    use super::{RuntimeAdapters, router_with_runtime};
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    async fn capabilities(adapters: RuntimeAdapters) -> Value {
        let response = router_with_runtime(None, adapters)
            .oneshot(Request::get("/capabilities").body(Body::empty()).unwrap())
            .await
            .unwrap();
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    fn feature<'a>(body: &'a Value, id: &str) -> &'a Value {
        body["features"]
            .as_array()
            .unwrap()
            .iter()
            .find(|feature| feature["id"] == id)
            .unwrap()
    }

    #[tokio::test]
    async fn configured_local_execution_is_visible_but_never_advertised_as_live() {
        let body = capabilities(RuntimeAdapters {
            aave: true,
            uniswap_quotes: true,
            uniswap_local_fork: true,
            near_intents_quotes: true,
            earn_catalog: true,
            authenticated_identity: true,
            redis: true,
            ..RuntimeAdapters::default()
        })
        .await;

        assert_eq!(body["schemaVersion"], 3);
        for id in ["swap", "earn"] {
            assert_eq!(feature(&body, id)["available"], false);
            assert_eq!(feature(&body, id)["scope"], "local_testnet");
            assert_eq!(feature(&body, id)["reason"], "local_testnet_only");
        }
        for id in [
            "swap_quotes",
            "bridge_quotes",
            "earn_catalog",
            "perps_account",
            "prediction_markets",
        ] {
            assert_eq!(feature(&body, id)["scope"], "read_only");
            assert_eq!(feature(&body, id)["available"], true);
        }
        assert_eq!(
            feature(&body, "bridge_quotes")["configuredProviders"],
            serde_json::json!(["near_intents"])
        );
        assert_eq!(
            feature(&body, "bridge")["configuredProviders"],
            serde_json::json!([])
        );
    }

    #[tokio::test]
    async fn quote_and_catalog_services_report_read_only_scope() {
        let body = capabilities(RuntimeAdapters {
            uniswap_quotes: true,
            near_intents_quotes: true,
            earn_catalog: true,
            ..RuntimeAdapters::default()
        })
        .await;

        for id in ["swap_quotes", "bridge_quotes", "earn_catalog"] {
            assert_eq!(feature(&body, id)["available"], true);
            assert_eq!(feature(&body, id)["scope"], "read_only");
        }
        assert_eq!(
            feature(&body, "swap_quotes")["reason"],
            "quote_preview_only"
        );
        assert_eq!(
            feature(&body, "bridge_quotes")["reason"],
            "quote_preview_only"
        );
        assert_eq!(feature(&body, "earn_catalog")["reason"], "catalog_only");
        assert_eq!(
            feature(&body, "bridge_quotes")["configuredProviders"],
            serde_json::json!(["near_intents"])
        );
    }

    #[tokio::test]
    async fn bridge_reports_only_configured_quote_providers() {
        let relay = capabilities(RuntimeAdapters {
            relay_quotes: true,
            ..RuntimeAdapters::default()
        })
        .await;
        let both = capabilities(RuntimeAdapters {
            relay_quotes: true,
            near_intents_quotes: true,
            ..RuntimeAdapters::default()
        })
        .await;
        assert_eq!(
            feature(&relay, "bridge_quotes")["providers"],
            serde_json::json!(["relay", "near_intents"])
        );
        assert_eq!(
            feature(&relay, "bridge_quotes")["configuredProviders"],
            serde_json::json!(["relay"])
        );
        assert_eq!(
            feature(&both, "bridge_quotes")["configuredProviders"],
            serde_json::json!(["relay", "near_intents"])
        );
        assert_eq!(feature(&relay, "bridge")["scope"], "unavailable");
    }

    #[tokio::test]
    async fn catalog_and_preview_capabilities_can_coexist_with_local_execution() {
        let body = capabilities(RuntimeAdapters {
            aave: true,
            morpho: true,
            earn_catalog: true,
            uniswap_quotes: true,
            uniswap_local_fork: true,
            ..RuntimeAdapters::default()
        })
        .await;
        assert_eq!(feature(&body, "earn")["scope"], "local_testnet");
        assert_eq!(feature(&body, "earn_catalog")["available"], true);
        assert_eq!(feature(&body, "swap")["scope"], "local_testnet");
        assert_eq!(feature(&body, "swap_quotes")["scope"], "read_only");
        assert_eq!(
            feature(&body, "swap_quotes")["configuredProviders"],
            serde_json::json!(["uniswap"])
        );
    }
}
