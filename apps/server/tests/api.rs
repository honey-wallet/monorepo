use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use honey_server::{Config, build_router};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

/// Sends one request through a fresh router and parses the JSON body.
async fn send(request: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
    let response = build_router(&Config::default())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, serde_json::from_slice(&bytes).unwrap())
}

async fn get(uri: &str) -> (StatusCode, axum::http::HeaderMap, Value) {
    send(Request::get(uri).body(Body::empty()).unwrap()).await
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

#[tokio::test]
async fn chains_lists_all_five_with_capabilities() {
    let (status, _, body) = get("/api/v1/chains").await;
    assert_eq!(status, StatusCode::OK);
    let chains: Vec<&str> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["chain"].as_str().unwrap())
        .collect();
    assert_eq!(chains, ["evm", "solana", "bitcoin", "tron", "xrpl"]);

    let bitcoin = &body[2];
    assert_eq!(bitcoin["commitDelayReveal"], "no");
    assert_eq!(bitcoin["tierB"], "no");
    assert_eq!(bitcoin["sessionAnchor"], "identity_address");
}

#[tokio::test]
async fn skeleton_endpoints_return_501() {
    let request = Request::post("/api/v1/session-signatures/verify")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"chain":"evm","address":"0x0","message":"hi","signature":"0x0"}"#,
        ))
        .unwrap();
    let (status, _, body) = send(request).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(body["error"]["code"], "not_implemented");
}
