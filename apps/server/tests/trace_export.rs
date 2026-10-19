//! Actual OTLP HTTP/protobuf export, redaction, internal metrics and failure isolation.
use axum::{
    Router,
    body::{Body, Bytes},
    http::Request,
    routing::post,
};
use honey_server::{
    Config,
    config::SecretUrl,
    runtime::{Infrastructure, RuntimeHealth},
    telemetry,
};
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTracePartialSuccess, ExportTraceServiceRequest, ExportTraceServiceResponse,
};
use prost::Message;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires loopback OTLP collector socket"]
async fn real_otlp_export_is_correlated_redacted_and_collector_failure_does_not_block_api() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let reject = Arc::new(AtomicBool::new(false));
    let collector_reject = reject.clone();
    let collector = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/v1/traces",
                post(move |bytes: Bytes| {
                    let tx = tx.clone();
                    let reject = collector_reject.clone();
                    async move {
                        let _ = tx.try_send(bytes);
                        Bytes::from(
                            ExportTraceServiceResponse {
                                partial_success: reject.load(Ordering::Relaxed).then(|| {
                                    ExportTracePartialSuccess {
                                        rejected_spans: 1,
                                        error_message: "private-collector-error".into(),
                                    }
                                }),
                            }
                            .encode_to_vec(),
                        )
                    }
                }),
            ),
        )
        .await
        .unwrap();
    });
    let config = Config {
        otlp_traces_endpoint: Some(SecretUrl::new(format!("http://{address}/v1/traces"))),
        trace_sample_per_mille: 1000,
        ..Config::default()
    };
    let infrastructure = Infrastructure::new(&config).unwrap();
    let telemetry = telemetry::init(&config, infrastructure.metrics().clone()).unwrap();
    let app = honey_server::build_router_with_infrastructure(
        &config,
        RuntimeHealth::new(&config),
        &infrastructure,
    )
    .unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::get("/api/v1/pairing/private-address/commit?private-query=true")
                .header("authorization", "private-token")
                .header("x-request-id", "private-request")
                .header(
                    "traceparent",
                    "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let trace_id = response.headers()["x-trace-id"]
        .to_str()
        .unwrap()
        .to_owned();
    assert_ne!(trace_id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let request_id = response.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let bytes = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let decoded = ExportTraceServiceRequest::decode(bytes.clone()).unwrap();
    let spans: Vec<_> = decoded
        .resource_spans
        .iter()
        .flat_map(|r| &r.scope_spans)
        .flat_map(|s| &s.spans)
        .collect();
    let http = spans.iter().find(|s| s.name == "http.request").unwrap();
    assert_eq!(hex::encode(&http.trace_id), trace_id);
    assert!(http.parent_span_id.is_empty());
    let debug = format!("{decoded:?}");
    assert!(debug.contains("/api/v1/pairing/{channel}/{slot}"));
    assert!(debug.contains(&request_id));
    assert!(!debug.contains("private-"));
    // OTLP can reject spans in an HTTP 200 response; it must not count as success.
    reject.store(true, Ordering::Relaxed);
    app.clone()
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if infrastructure
                .metrics()
                .encode()
                .unwrap()
                .contains("honey_trace_exports_total{outcome=\"failed\"} 1")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    collector.abort();
    let _ = collector.await;
    let started = std::time::Instant::now();
    for _ in 0..50 {
        let r = app
            .clone()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    tokio::time::sleep(Duration::from_millis(1500)).await;
    telemetry.shutdown().await;
    let metrics = infrastructure.metrics().encode().unwrap();
    assert!(metrics.contains("honey_trace_exports_total{outcome=\"ok\"}"));
    assert!(metrics.contains("honey_trace_exports_total{outcome=\"failed\"}"));
}
