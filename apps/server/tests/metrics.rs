use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use honey_server::{
    Config, build_router_with_infrastructure,
    metrics::{ActiveGauge, Metrics},
    runtime::{Infrastructure, RuntimeHealth},
};
use std::sync::Arc;
use tower::ServiceExt;

#[tokio::test]
async fn metrics_are_private_and_cannot_include_client_selected_paths_methods_or_secrets() {
    let config = Config::default();
    let infrastructure = Infrastructure::new(&config).unwrap();
    let app =
        build_router_with_infrastructure(&config, RuntimeHealth::new(&config), &infrastructure)
            .unwrap();
    for path in [
        "/unknown/private-address?secret=private-query",
        "/api/v1/pairing/private-address/commit",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PRIVATE-METHOD")
                    .uri(path)
                    .header("authorization", "private-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_client_error());
    }
    assert_eq!(
        app.oneshot(Request::get("/metrics").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status(),
        404
    );
    let metrics = infrastructure.metrics().encode().unwrap();
    assert!(!metrics.contains("private-"));
    assert!(!metrics.contains("PRIVATE-METHOD"));
    assert!(metrics.contains("method=\"OTHER\""));
    assert!(metrics.contains("route=\"/api/v1/pairing/{channel}/{slot}\""));
    assert!(metrics.contains("honey_http_active 0"));
    let response = honey_server::metrics::router(infrastructure.metrics().clone())
        .oneshot(Request::get("/metrics").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("openmetrics-text")
    );
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert!(body.ends_with(b"# EOF\n"));
}
#[test]
fn active_gauges_return_to_zero_on_drop_and_metric_outcomes_are_bounded() {
    let metrics = Arc::new(Metrics::default());
    {
        let _gauge = ActiveGauge::new(metrics.ws_active.clone());
        assert!(
            metrics
                .encode()
                .unwrap()
                .contains("honey_price_sockets_active 1")
        );
    }
    metrics.socket_closed("private-arbitrary-reason");
    metrics.price_socket_send(0.012);
    metrics.socket_handshake_rejected("redis_busy");
    metrics.socket_handshake_rejected("attacker-selected-reason");
    metrics.http_admission_rejected("capacity");
    assert!(
        metrics
            .encode()
            .unwrap()
            .contains("honey_price_sockets_active 0")
    );
    assert!(!metrics.encode().unwrap().contains("private-"));
    let encoded = metrics.encode().unwrap();
    assert!(encoded.contains("honey_price_socket_send_duration_seconds_count 1"));
    assert!(
        encoded.contains("honey_price_socket_handshake_rejections_total{outcome=\"redis_busy\"} 1")
    );
    assert!(encoded.contains("outcome=\"other\"} 1"));
    assert!(encoded.contains("honey_http_admission_rejections_total{outcome=\"capacity\"} 1"));
}

#[test]
fn price_redis_metrics_use_only_fixed_operation_and_outcome_labels() {
    let metrics = Metrics::default();
    metrics.market_redis("publish", "fenced");
    metrics.market_redis("read", "unavailable");
    metrics.market_redis("attacker-selected-operation", "attacker-selected-outcome");
    let encoded = metrics.encode().unwrap();
    assert!(encoded.contains("operation=\"publish\",outcome=\"fenced\""));
    assert!(encoded.contains("operation=\"read\",outcome=\"unavailable\""));
    assert!(encoded.contains("operation=\"unknown\",outcome=\"unknown\""));
    assert!(!encoded.contains("attacker-selected"));
}

#[test]
fn queue_metrics_cap_counts_and_reject_unbounded_labels() {
    let metrics = Metrics::default();
    metrics.work_queue_state("ready", 50_000, Some(120));
    metrics.work_queue_state("dead", 3, Some(600));
    metrics.work_queue_state("arbitrary-user-input", 1, Some(1));
    metrics.work_queue_refresh(true, Some(1_800_000_000));
    let encoded = metrics.encode().unwrap();
    assert!(encoded.contains("state=\"ready\"} 10001"));
    assert!(encoded.contains("state=\"ready\"} 120"));
    assert!(encoded.contains("state=\"dead\"} 600"));
    assert!(encoded.contains("outcome=\"ok\""));
    assert!(!encoded.contains("arbitrary-user-input"));
}
