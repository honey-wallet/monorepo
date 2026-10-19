//! HTTP admission tests. Every quote is rejected before provider transport.
mod common;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::TestDatabase;
use honey_server::{
    config::AuthConfig, identity::Identity, metrics::Metrics,
    providers::across_quotes::AcrossQuotes, redis_store::RedisStore, routes::across,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Write, os::unix::fs::OpenOptionsExt, sync::Arc, time::Duration};
use tower::ServiceExt;
use uuid::Uuid;

fn address(n: u8) -> String {
    format!("0x{}", format!("{n:02x}").repeat(20))
}

#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL"]
async fn quote_http_enforces_owner_chain_schema_and_rate_limit_without_exposing_credentials() {
    let db = TestDatabase::new().await;
    let user = Uuid::new_v4();
    let wallet = Uuid::new_v4();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO users(id) VALUES ($1)")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,1,$3,'eoa')")
        .bind(wallet).bind(user).bind(vec![0x11u8;20]).execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,wallet_id,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '15 minutes')")
        .bind(Sha256::digest(token.as_bytes()).to_vec()).bind(user).bind(wallet).execute(&db.pool).await.unwrap();
    let path = std::env::temp_dir().join(format!("honey-across-{}.json", Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    write!(
        file,
        "{}",
        json!({"apiKey":"public-test-fixture", "accountScope":"fixture", "intervalMs":167,
        "sourceChainId":"1","integratorId":"0xabcd","registryRevision":"fixture-v1",
        "routes":[{"id":"usdc-base","destinationChainId":"8453","sourceSpoke":address(4),
            "inputToken":{"assetId":"usdc","address":address(2),"symbol":"USDC","decimals":6},
            "outputToken":{"assetId":"usdc","address":address(3),"symbol":"USDC","decimals":6},
            "minimumInputRaw":"1","maximumInputRaw":"1000000","maximumBridgeFeeBps":100,
            "maximumFillSeconds":3600,"maximumExclusivitySeconds":300}]})
    )
    .unwrap();
    drop(file);
    // No valid request reaches Redis or the provider; an unavailable port catches regressions.
    let redis = RedisStore::new(
        redis::Client::open("redis://127.0.0.1:1").unwrap(),
        "across-http-fixture".into(),
        Duration::from_millis(50),
    );
    let quotes = AcrossQuotes::from_file(
        path.to_str().unwrap(),
        1,
        redis,
        Arc::new(Metrics::default()),
    )
    .unwrap();
    std::fs::remove_file(path).unwrap();
    let identity = Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        },
    )
    .unwrap();
    let app = across::router(Some(identity), Some(Arc::new(quotes)), None);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/bridges/across/configuration")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 8192).await.unwrap();
    let public: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(public["executionAvailable"], false);
    assert!(public.get("apiKey").is_none() && public.get("accountScope").is_none());
    assert!(!String::from_utf8_lossy(&bytes).contains("public-test-fixture"));
    let request = |body: Value, authenticated: bool| {
        let mut r = Request::builder()
            .method("POST")
            .uri("/bridges/across/quote")
            .header("content-type", "application/json");
        if authenticated {
            r = r.header("authorization", format!("Bearer {token}"));
        }
        r.body(Body::from(body.to_string())).unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(request(json!({}), false))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let base = json!({"routeId":"usdc-base","amountRaw":"0","minimumOutputRaw":"1","recipient":address(9)});
    for (field, value) in [
        ("amountRaw", json!("0")),
        ("amountRaw", json!("01")),
        ("amountRaw", json!(1)),
        ("amountRaw", json!("1000001")),
        ("sender", json!(address(9))),
        ("privateKey", json!("rejected-fixture")),
        ("minimumOutputRaw", json!("2")),
        ("recipient", json!(address(0))),
    ] {
        let mut body = base.clone();
        body["amountRaw"] = json!("1");
        body[field] = value;
        assert_eq!(
            app.clone()
                .oneshot(request(body, true))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    sqlx::query("UPDATE wallet_memberships SET chain_id=10 WHERE id=$1")
        .bind(wallet)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        app.clone()
            .oneshot(request(base.clone(), true))
            .await
            .unwrap()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    sqlx::query("UPDATE wallet_memberships SET chain_id=1 WHERE id=$1")
        .bind(wallet)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        app.clone()
            .oneshot(request(base.clone(), true))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        app.oneshot(request(base, true)).await.unwrap().status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn across_intent_recovery_quota_caps_aggregate_wallet_load() {
    let db = TestDatabase::new().await;
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id) VALUES ($1)")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    let mut tokens = Vec::new();
    for index in 1..=11u8 {
        let wallet = Uuid::new_v4();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,1,$3,'eoa')")
            .bind(wallet).bind(user).bind(vec![index; 20]).execute(&db.pool).await.unwrap();
        sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,wallet_id,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '15 minutes')")
            .bind(Sha256::digest(token.as_bytes()).to_vec()).bind(user).bind(wallet).execute(&db.pool).await.unwrap();
        tokens.push(token);
    }
    let identity = Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        },
    )
    .unwrap();
    let app = across::router(Some(identity), None, None);
    let request = |token: &str| {
        Request::get(format!("/operations/{}/across-intent", Uuid::new_v4()))
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    // The unavailable service yields 422 only after the quota admits the read.
    // Ten wallets can consume 60 each; the eleventh is rejected by the global
    // 600/minute cap, despite having an unused per-wallet allowance.
    for (wallet_index, token) in tokens[..10].iter().enumerate() {
        for _ in 0..60 {
            assert_eq!(
                app.clone().oneshot(request(token)).await.unwrap().status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
        if wallet_index == 0 {
            assert_eq!(
                app.clone().oneshot(request(token)).await.unwrap().status(),
                StatusCode::TOO_MANY_REQUESTS
            );
        }
    }
    // The eleventh wallet has unused subject allowance but hits the global cap.
    assert_eq!(
        app.oneshot(request(&tokens[10])).await.unwrap().status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    db.close().await;
}

#[tokio::test]
async fn unavailable_quotes_never_expose_signing_or_skip_authentication() {
    let app = across::router(None, None, None);
    for (method, path, body, expected) in [
        (
            "GET",
            "/bridges/across/configuration",
            "",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "POST",
            "/bridges/across/quote",
            "not-json",
            StatusCode::UNAUTHORIZED,
        ),
        (
            "POST",
            "/bridges/across/operations",
            "{}",
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
}
