//! HTTP admission tests. Every quote is rejected before provider transport.
mod common;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::TestDatabase;
use honey_server::{
    config::AuthConfig, identity::Identity, metrics::Metrics, providers::uniswap::UniswapQuotes,
    redis_store::RedisStore, routes::swaps,
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
    let path = std::env::temp_dir().join(format!("honey-uniswap-{}.json", Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    write!(file, "{}", json!({"apiKey":"public-test-fixture", "accountScope":"fixture", "intervalMs":167,
        "chainId":1,"router":address(4),"permit2":address(5),
        "tokens":[{"address":address(2),"symbol":"IN","decimals":6},{"address":address(3),"symbol":"OUT","decimals":18}],
        "integratorFees":[],"registryRevision":"fixture-v1","feePolicyRevision":"none-v1"})).unwrap();
    drop(file);
    // No valid request reaches Redis or the provider; an unavailable port catches regressions.
    let redis = RedisStore::new(
        redis::Client::open("redis://127.0.0.1:1").unwrap(),
        "swap-http-fixture".into(),
        Duration::from_millis(50),
    );
    let quotes = UniswapQuotes::from_file(
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
    let app = swaps::router(Some(identity), Some(Arc::new(quotes)));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/swaps/configuration")
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
            .uri("/swaps/quote")
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
    let base = json!({"tokenIn":address(2),"tokenOut":address(3),"amountRaw":"0","slippageBps":50});
    for (field, value) in [
        ("amountRaw", json!("0")),
        ("amountRaw", json!("01")),
        ("amountRaw", json!(1)),
        (
            "amountRaw",
            json!("1461501637330902918203684832716283019655932542975"),
        ),
        ("signer", json!(address(9))),
        ("privateKey", json!("rejected-fixture")),
        ("slippageBps", json!(1001)),
        ("tokenIn", json!(address(9))),
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
