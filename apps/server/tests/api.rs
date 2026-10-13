use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use honey_server::{Config, build_router};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

async fn get(uri: &str) -> (StatusCode, axum::http::HeaderMap, Value) {
    let app = build_router(&Config::default());
    let response = app
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();

    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn health_returns_ok() {
    let (status, _, body) = get("/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn version_returns_package_metadata() {
    let (status, _, body) = get("/api/v1/version").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["name"], "honey-server");
    assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn unknown_route_returns_json_404() {
    let (status, _, body) = get("/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not_found");
}

#[tokio::test]
async fn responses_carry_request_id() {
    let (_, headers, _) = get("/health").await;
    assert!(headers.contains_key("x-request-id"));
}
