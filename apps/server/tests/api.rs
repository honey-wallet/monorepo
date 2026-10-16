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

mod pairing {
    use super::*;
    use sha2::{Digest, Sha256};

    const TOKEN: &str = "3f9a1c7e5b2d4086aa71c3e9f0b6d218";

    fn channel_for(token: &str) -> String {
        Sha256::digest(token.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn put_json(uri: &str, token: Option<&str>, body: &str) -> Request<Body> {
        let mut request = Request::put(uri).header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("x-pair-token", token);
        }
        request.body(Body::from(body.to_owned())).unwrap()
    }

    fn get_with(uri: &str, token: &str) -> Request<Body> {
        Request::get(uri)
            .header("x-pair-token", token)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn delivers_a_message_once_and_never_takes_another() {
        // One router for the whole exchange: the mailbox lives in its state.
        let app = build_router(&Config::default());
        let uri = format!("/api/v1/pairing/{}/commit", channel_for(TOKEN));

        let empty = app.clone().oneshot(get_with(&uri, TOKEN));
        assert_eq!(empty.await.unwrap().status(), StatusCode::NOT_FOUND);

        let sent = app
            .clone()
            .oneshot(put_json(&uri, Some(TOKEN), r#"{"data":"Y29tbWl0"}"#));
        assert_eq!(sent.await.unwrap().status(), StatusCode::NO_CONTENT);

        let got = app.clone().oneshot(get_with(&uri, TOKEN)).await.unwrap();
        assert_eq!(got.status(), StatusCode::OK);
        let bytes = got.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["data"], "Y29tbWl0");

        let gone = app.clone().oneshot(get_with(&uri, TOKEN));
        assert_eq!(gone.await.unwrap().status(), StatusCode::NOT_FOUND);

        // Read already, but the slot stays taken: no second message slips in.
        let again = app.oneshot(put_json(&uri, Some(TOKEN), r#"{"data":"b3RoZXI"}"#));
        assert_eq!(again.await.unwrap().status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn needs_the_token_behind_the_channel() {
        let app = build_router(&Config::default());
        let uri = format!("/api/v1/pairing/{}/commit", channel_for(TOKEN));

        let missing = app
            .clone()
            .oneshot(put_json(&uri, None, r#"{"data":"eA"}"#));
        assert_eq!(missing.await.unwrap().status(), StatusCode::FORBIDDEN);

        let wrong = "0000000000000000000000000000000000";
        let other = app
            .clone()
            .oneshot(put_json(&uri, Some(wrong), r#"{"data":"eA"}"#));
        assert_eq!(other.await.unwrap().status(), StatusCode::FORBIDDEN);

        let read = app.oneshot(get_with(&uri, wrong));
        assert_eq!(read.await.unwrap().status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn rejects_bad_channels_slots_and_sizes() {
        let (status, _, _) = send(put_json(
            "/api/v1/pairing/short/commit",
            Some(TOKEN),
            r#"{"data":"eA"}"#,
        ))
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let uri = format!("/api/v1/pairing/{}/secrets", channel_for(TOKEN));
        let response = build_router(&Config::default())
            .oneshot(put_json(&uri, Some(TOKEN), r#"{"data":"eA"}"#))
            .await
            .unwrap();
        assert!(response.status().is_client_error());

        let huge = format!(r#"{{"data":"{}"}}"#, "a".repeat(20_000));
        let uri = format!("/api/v1/pairing/{}/payload", channel_for(TOKEN));
        let (status, _, _) = send(put_json(&uri, Some(TOKEN), &huge)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn limits_how_much_one_client_can_hold() {
        let app = build_router(&Config::default());
        let mut statuses = Vec::new();
        for i in 0..30 {
            let token = format!("flood-token-{i:04}-xxxxxxxx");
            let uri = format!("/api/v1/pairing/{}/commit", channel_for(&token));
            let response = app
                .clone()
                .oneshot(put_json(&uri, Some(&token), r#"{"data":"eA"}"#))
                .await
                .unwrap();
            statuses.push(response.status());
        }
        assert!(statuses[..24].iter().all(|s| *s == StatusCode::NO_CONTENT));
        assert!(
            statuses[24..]
                .iter()
                .all(|s| *s == StatusCode::TOO_MANY_REQUESTS)
        );
    }

    #[tokio::test]
    async fn counts_forwarded_clients_separately_behind_a_trusted_proxy() {
        let config = Config {
            trust_proxy_headers: true,
            ..Config::default()
        };
        let app = build_router(&config);
        for i in 0..30 {
            let token = format!("proxy-token-{i:04}-xxxxxxxx");
            let uri = format!("/api/v1/pairing/{}/commit", channel_for(&token));
            let mut request = put_json(&uri, Some(&token), r#"{"data":"eA"}"#);
            request.headers_mut().insert(
                "x-forwarded-for",
                format!("203.0.113.{i}, 10.0.0.1").parse().unwrap(),
            );
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
        }
    }
}
