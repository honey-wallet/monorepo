use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use honey_server::{
    Config, build_router, build_router_with_infrastructure,
    config::{AuthConfig, SecretUrl},
    runtime::{Infrastructure, RuntimeHealth},
};
use http_body_util::BodyExt;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, time::Duration};
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

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL and loopback ConnectInfo"]
async fn production_router_applies_shared_ip_admission_to_private_and_public_groups() {
    let url = std::env::var("TEST_REDIS_URL").expect("set isolated TEST_REDIS_URL");
    let namespace = format!("test:{}", uuid::Uuid::new_v4().simple());
    let config = Config {
        database_url: Some(SecretUrl::new(
            "postgres://honey:honey_local_only@127.0.0.1:1/honey".into(),
        )),
        redis_url: Some(SecretUrl::new(url.clone())),
        redis_namespace: namespace.clone(),
        auth: Some(AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        }),
        ..Config::default()
    };
    let infrastructure = Infrastructure::new(&config).unwrap();
    let app =
        build_router_with_infrastructure(&config, RuntimeHealth::new(&config), &infrastructure)
            .unwrap();

    // Fill only this test peer's bucket in the exact Redis minute used by the
    // router. A rejected request then proves admission ran before either handler.
    let redis = honey_server::redis_store::RedisStore::new(
        redis::Client::open(url).unwrap(),
        namespace,
        Duration::from_secs(1),
    );
    let (seconds, _micros): (i64, i64) = redis.query(&mut redis::cmd("TIME")).await.unwrap();
    let subject_digest = hex::encode(Sha256::digest(b"198.51.100.42"));
    for domain in ["authenticated_api_ip", "polymarket_public_read"] {
        let subject_key = redis.key(domain, &format!("quota:subject:{subject_digest}"));
        let mut seed = redis::cmd("HSET");
        seed.arg(&subject_key)
            .arg("window")
            .arg(seconds / 60)
            .arg("count")
            .arg(6_000);
        let _: i64 = redis.query(&mut seed).await.unwrap();
        let mut expiry = redis::cmd("PEXPIRE");
        expiry.arg(subject_key).arg(120_000);
        let _: i64 = redis.query(&mut expiry).await.unwrap();
    }

    let request = |path: &str| {
        let mut request = Request::get(path).body(Body::empty()).unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "198.51.100.42:45000".parse::<SocketAddr>().unwrap(),
        ));
        request
    };
    assert_eq!(
        app.clone()
            .oneshot(request("/api/v1/operations"))
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS,
        "the production private group must reject before bearer/session lookup"
    );
    assert_eq!(
        app.oneshot(request("/api/v1/prediction/markets"))
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS,
        "the production public-market group must reject before cache/provider work"
    );
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
async fn polymarket_query_rejections_use_the_common_error_envelope() {
    for uri in [
        "/api/v1/prediction/markets?limit=not-a-number",
        "/api/v1/prediction/order-book",
    ] {
        let (status, _, body) = get(uri).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "bad_request");
        assert_eq!(body["error"]["message"], "invalid query parameters");
    }
}

#[tokio::test]
async fn responses_carry_request_id() {
    let (_, headers, _) = get("/health").await;
    assert!(headers.contains_key("x-request-id"));
}

#[tokio::test]
async fn replaces_untrusted_correlation_and_exposes_safe_headers_to_web_clients() {
    let request = Request::get("/api/v1/version?token=private")
        .header("x-request-id", "private-client-supplied-value")
        .header("origin", "http://localhost:5173")
        .body(Body::empty())
        .unwrap();
    let (_, headers, _) = send(request).await;
    assert_ne!(headers["x-request-id"], "private-client-supplied-value");
    assert!(uuid::Uuid::parse_str(headers["x-request-id"].to_str().unwrap()).is_ok());
    assert_eq!(headers["cache-control"], "no-store");
    let exposed = headers["access-control-expose-headers"].to_str().unwrap();
    assert!(exposed.contains("x-request-id"));
    assert!(exposed.contains("retry-after"));
}

#[tokio::test]
async fn enforces_actual_body_size_without_a_content_length_header() {
    let request = Request::post("/api/v1/accounts")
        .header("content-type", "application/json")
        .header("origin", "http://localhost:5173")
        .body(Body::from("x".repeat(65_537)))
        .unwrap();
    let (status, headers, body) = send(request).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"]["code"], "payload_too_large");
    assert!(headers.contains_key("x-request-id"));
    assert_eq!(
        headers["access-control-allow-origin"],
        "http://localhost:5173"
    );
}

#[tokio::test]
async fn capabilities_never_advertise_unimplemented_trading() {
    let (status, _, body) = get("/api/v1/capabilities").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["schemaVersion"], 3);
    let features = body["features"].as_array().unwrap();
    assert_eq!(features.len(), 15);
    assert!(features.iter().all(|f| {
        f["available"] == false
            && f["scope"] == "unavailable"
            && f["reason"]
                == if matches!(
                    f["id"].as_str(),
                    Some(
                        "swap"
                            | "bridge"
                            | "earn"
                            | "swap_quotes"
                            | "bridge_quotes"
                            | "earn_catalog"
                            | "prediction_markets"
                            | "price_stream"
                    )
                ) {
                    "not_configured"
                } else if f["id"] == "perps_account" {
                    "authentication_not_configured"
                } else {
                    "not_implemented"
                }
    }));
    assert_eq!(
        features.iter().find(|f| f["id"] == "earn").unwrap()["providers"],
        serde_json::json!(["morpho", "aave"])
    );
    assert_eq!(
        features
            .iter()
            .find(|f| f["id"] == "bridge_quotes")
            .unwrap()["configuredProviders"],
        serde_json::json!([])
    );
}

#[tokio::test]
async fn readiness_is_separate_from_liveness_and_drain_rejects_new_work() {
    use honey_server::{build_router_with_health, runtime::RuntimeHealth};
    let config = Config::default();
    let health = RuntimeHealth::new(&config);
    let app = build_router_with_health(&config, health.clone());
    assert_eq!(
        app.clone()
            .oneshot(Request::get("/ready").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    health.begin_drain();
    assert_eq!(
        app.clone()
            .oneshot(Request::get("/ready").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        app.clone()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let response = app
        .oneshot(Request::get("/api/v1/version").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()["retry-after"], "1");
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
        .body(Body::from("{"))
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
        let mut request = request.body(Body::from(body.to_owned())).unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 40_000))));
        request
    }

    fn get_with(uri: &str, token: &str) -> Request<Body> {
        let mut request = Request::get(uri)
            .header("x-pair-token", token)
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 40_000))));
        request
    }

    fn get_from(uri: &str, token: &str, peer: SocketAddr) -> Request<Body> {
        let mut request = Request::get(uri)
            .header("x-pair-token", token)
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(peer));
        request
    }

    #[tokio::test]
    #[ignore = "requires isolated TEST_REDIS_URL"]
    async fn receive_quota_follows_client_across_valid_channels() {
        let url = std::env::var("TEST_REDIS_URL").expect("set isolated TEST_REDIS_URL");
        let namespace = format!("test:{}", uuid::Uuid::new_v4().simple());
        let redis = honey_server::redis_store::RedisStore::new(
            redis::Client::open(url).unwrap(),
            namespace,
            Duration::from_secs(1),
        );
        let app = honey_server::routes::pairing::router_with_store(
            false,
            Some(honey_server::pairing_store::PairingStore::new(redis)),
        );
        let first_token = "first-pairing-channel-token-0001";
        let second_token = "second-pairing-channel-token-0002";
        let first = format!("/pairing/{}/commit", channel_for(first_token));
        let second = format!("/pairing/{}/commit", channel_for(second_token));
        let peer = SocketAddr::from(([198, 51, 100, 7], 40_000));

        for _ in 0..120 {
            let response = app
                .clone()
                .oneshot(get_from(&first, first_token, peer))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
        assert_eq!(
            app.clone()
                .oneshot(get_from(&second, second_token, peer))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS,
            "changing a valid channel must not create a new client poll bucket"
        );
        assert_eq!(
            app.oneshot(get_from(
                &second,
                second_token,
                SocketAddr::from(([198, 51, 100, 8], 40_000)),
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::NOT_FOUND,
            "a distinct resolved client IP keeps its own poll bucket"
        );
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
            trusted_proxy_cidrs: vec![
                honey_server::config::TrustedProxyCidr::parse("127.0.0.1/32").unwrap(),
            ],
            ..Config::default()
        };
        let app = build_router(&config);
        for i in 0..30 {
            let token = format!("proxy-token-{i:04}-xxxxxxxx");
            let uri = format!("/api/v1/pairing/{}/commit", channel_for(&token));
            let mut request = put_json(&uri, Some(&token), r#"{"data":"eA"}"#);
            // The proxy appends the real client IP; whatever the client put before it is ignored.
            request.headers_mut().insert(
                "x-forwarded-for",
                format!("198.51.100.7, 203.0.113.{i}").parse().unwrap(),
            );
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
        }
    }

    #[tokio::test]
    async fn ignores_forged_forwarded_entries_and_groups_ipv6_by_64() {
        let config = Config {
            trust_proxy_headers: true,
            trusted_proxy_cidrs: vec![
                honey_server::config::TrustedProxyCidr::parse("127.0.0.1/32").unwrap(),
            ],
            ..Config::default()
        };
        for (label, forwarded) in [
            // A client forging a fresh left-most entry each time is still one client.
            ("forged", "192.0.2.{i}, 203.0.113.9"),
            // Rotating addresses inside one IPv6 /64 is still one client.
            ("ipv6", "2001:db8:1:2::{i}"),
        ] {
            let app = build_router(&config);
            let mut statuses = Vec::new();
            for i in 0..30 {
                let token = format!("{label}-token-{i:04}-xxxxxxxxxx");
                let uri = format!("/api/v1/pairing/{}/commit", channel_for(&token));
                let mut request = put_json(&uri, Some(&token), r#"{"data":"eA"}"#);
                let value = forwarded.replace("{i}", &format!("{:x}", i + 1));
                request
                    .headers_mut()
                    .insert("x-forwarded-for", value.parse().unwrap());
                statuses.push(app.clone().oneshot(request).await.unwrap().status());
            }
            assert!(
                statuses[..24].iter().all(|s| *s == StatusCode::NO_CONTENT),
                "{label}"
            );
            assert!(
                statuses[24..]
                    .iter()
                    .all(|s| *s == StatusCode::TOO_MANY_REQUESTS),
                "{label}"
            );
        }
    }

    #[tokio::test]
    async fn ignores_forwarded_headers_from_untrusted_socket_peers() {
        let config = Config {
            trust_proxy_headers: true,
            trusted_proxy_cidrs: vec![
                honey_server::config::TrustedProxyCidr::parse("10.20.0.0/16").unwrap(),
            ],
            ..Config::default()
        };
        let app = build_router(&config);
        let mut statuses = Vec::new();
        for i in 0..30 {
            let token = format!("untrusted-token-{i:04}-xxxxxxxx");
            let uri = format!("/api/v1/pairing/{}/commit", channel_for(&token));
            let mut request = put_json(&uri, Some(&token), r#"{"data":"eA"}"#);
            request.headers_mut().insert(
                "x-forwarded-for",
                format!("198.51.100.{i}").parse().unwrap(),
            );
            statuses.push(app.clone().oneshot(request).await.unwrap().status());
        }
        assert!(
            statuses[..24]
                .iter()
                .all(|status| *status == StatusCode::NO_CONTENT)
        );
        assert!(
            statuses[24..]
                .iter()
                .all(|status| *status == StatusCode::TOO_MANY_REQUESTS)
        );
    }

    #[tokio::test]
    async fn reads_the_last_forwarded_header_line_and_rejects_missing_ones() {
        let config = Config {
            trust_proxy_headers: true,
            trusted_proxy_cidrs: vec![
                honey_server::config::TrustedProxyCidr::parse("127.0.0.1/32").unwrap(),
            ],
            ..Config::default()
        };
        let app = build_router(&config);
        let mut statuses = Vec::new();
        for i in 0..30 {
            let token = format!("lines-token-{i:04}-xxxxxxxxxx");
            let uri = format!("/api/v1/pairing/{}/commit", channel_for(&token));
            let mut request = put_json(&uri, Some(&token), r#"{"data":"eA"}"#);
            // The client's own header line comes first; the proxy appends another.
            let headers = request.headers_mut();
            headers.append("x-forwarded-for", format!("192.0.2.{i}").parse().unwrap());
            headers.append("x-forwarded-for", "203.0.113.9".parse().unwrap());
            statuses.push(app.clone().oneshot(request).await.unwrap().status());
        }
        assert!(statuses[..24].iter().all(|s| *s == StatusCode::NO_CONTENT));
        assert!(
            statuses[24..]
                .iter()
                .all(|s| *s == StatusCode::TOO_MANY_REQUESTS)
        );

        let token = "no-header-token-xxxxxxxxxx";
        let uri = format!("/api/v1/pairing/{}/commit", channel_for(token));
        let response = app
            .oneshot(put_json(&uri, Some(token), r#"{"data":"eA"}"#))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
