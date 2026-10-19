use super::*;
use crate::providers::uniswap::local_service_fixture;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, StatusCode},
    routing::post,
};
use serde_json::{Value, json};
use tower::ServiceExt;
mod common {
    use crate as honey_server;
    include!("../../tests/common/mod.rs");
}
use common::TestDatabase;
#[derive(Clone)]
struct Provider {
    quote: Value,
    build: Value,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}
async fn quote(State(p): State<Provider>, Json(v): Json<Value>) -> Json<Value> {
    assert_eq!(v["tokenInChainId"], 31337);
    assert_eq!(v["amount"], "1000");
    p.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Json(p.quote)
}
async fn build(
    State(p): State<Provider>,
    Json(v): Json<Value>,
) -> ([(String, String); 1], Json<Value>) {
    assert_eq!(v["quote"], p.quote["quote"]);
    assert_eq!(v["simulateTransaction"], false);
    assert!(v["signature"].as_str().unwrap().starts_with("0x"));
    p.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    (
        [("x-universal-router-version".into(), "2.1.2".into())],
        Json(p.build),
    )
}
async fn call(
    app: &Router,
    token: Option<&str>,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().uri(path);
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    if body.is_some() {
        req = req
            .method("POST")
            .header("content-type", "application/json")
            .header("idempotency-key", "service-test");
    }
    let res = app
        .clone()
        .oneshot(
            req.body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 300000).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn transactions(p: &PreparedEvm) -> Vec<String> {
    use alloy_consensus::{SignableTransaction, TxEip1559};
    use alloy_eips::eip2718::Encodable2718;
    let mut secret = [0u8; 32];
    secret[31] = 1;
    let key = k256::ecdsa::SigningKey::from_bytes((&secret).into()).unwrap();
    p.plan
        .steps
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let tx = TxEip1559 {
                chain_id: 31337,
                nonce: p.first_nonce.parse::<u64>().unwrap() + i as u64,
                gas_limit: p.gas_limits[i].parse().unwrap(),
                max_fee_per_gas: p.max_fee_per_gas.parse().unwrap(),
                max_priority_fee_per_gas: p.max_priority_fee_per_gas.parse().unwrap(),
                to: alloy_primitives::TxKind::Call(s.to.parse().unwrap()),
                value: U256::ZERO,
                input: hex::decode(&s.data[2..]).unwrap().into(),
                access_list: Default::default(),
            };
            let (sig, rec) = key
                .sign_prehash_recoverable(tx.signature_hash().as_slice())
                .unwrap();
            let signature =
                alloy_primitives::Signature::from_bytes_and_parity(&sig.to_bytes(), rec.is_y_odd());
            let signed = alloy_consensus::TxEnvelope::Eip1559(tx.into_signed(signature));
            format!("0x{}", hex::encode(signed.encoded_2718()))
        })
        .collect()
}
#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL and TEST_REDIS_URL"]
async fn http_worker_review_permit_prepare_and_signed_recovery() {
    let db = TestDatabase::new().await;
    let user = Uuid::new_v4();
    let wallet = Uuid::new_v4();
    let (config, context, quote_json, build_json) = local_service_fixture(now() - 1);
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let provider = Provider {
        quote: quote_json,
        build: build_json,
        calls: calls.clone(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/quote", post(quote))
                .route("/swap", post(build))
                .with_state(provider),
        )
        .await
        .unwrap()
    });
    let redis = crate::redis_store::RedisStore::new(
        redis::Client::open(std::env::var("TEST_REDIS_URL").unwrap()).unwrap(),
        format!("swap-service-{}", Uuid::new_v4().simple()),
        Duration::from_secs(2),
    );
    let quotes = Arc::new(UniswapQuotes::local_test_client(config, origin, redis));
    let (rpc, policy, rpc_task) =
        crate::providers::uniswap_execution::tests::service_rpc(context.review.clone()).await;
    let work = WorkStore::new(db.pool.clone());
    let service = Arc::new(UniswapService {
        work: work.clone(),
        rpc,
        policy,
        quotes: quotes.clone(),
        rounding: 0,
        keys: SubmissionKeys::new(
            "fixture".into(),
            [("fixture".into(), Zeroizing::new([1; 32]))].into(),
        )
        .unwrap(),
    });
    sqlx::query("INSERT INTO users(id) VALUES($1)")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES($1,$2,31337,$3,'eoa')").bind(wallet).bind(user).bind(hex::decode(&context.review.authority.owner[2..]).unwrap()).execute(&db.pool).await.unwrap();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,wallet_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '15 minutes')").bind(digest(token.as_bytes())).bind(user).bind(wallet).execute(&db.pool).await.unwrap();
    let identity = crate::identity::Identity::new(
        db.pool.clone(),
        crate::config::AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 31337,
        },
    )
    .unwrap();
    let app = crate::routes::swaps::router_with_execution(
        Some(identity),
        Some(quotes),
        Some(service.clone()),
    );
    let input = json!({"tokenIn":context.review.authority.token_in,"tokenOut":context.review.authority.token_out,"amountRaw":"1000","slippageBps":"500","minimumOutputRaw":"1900","deadline":context.review.authority.deadline,"maximumNetworkFeeRaw":"1000000000000000"});
    assert_eq!(
        call(&app, None, "/swaps/operations", Some(input.clone()))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, created) =
        call(&app, Some(&token), "/swaps/operations", Some(input.clone())).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let id = created["operation"]["id"].as_str().unwrap();
    assert_eq!(
        call(&app, Some(&token), "/swaps/operations", Some(input))
            .await
            .1["operation"]["id"],
        id
    );
    assert!(service.tick().await.unwrap());
    let (status, review) = call(
        &app,
        Some(&token),
        &format!("/operations/{id}/swap-review"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{review}");
    assert!(
        !review
            .to_string()
            .contains(context.signature.as_ref().unwrap().as_str())
    );
    assert!(!service.tick().await.unwrap());
    let permit = json!({"expectedVersion":review["operationVersion"],"reviewHash":review["reviewHash"],"signature":context.signature.as_ref().unwrap().as_str()});
    for field in ["expectedVersion", "reviewHash"] {
        let mut changed = permit.clone();
        changed[field] = if field == "expectedVersion" {
            json!("999")
        } else {
            json!("a".repeat(64))
        };
        assert_eq!(
            call(
                &app,
                Some(&token),
                &format!("/operations/{id}/swap-permit"),
                Some(changed)
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            work.get(user, wallet, id.parse().unwrap())
                .await
                .unwrap()
                .state,
            OperationState::AwaitingPermit
        );
    }
    let (status, accepted) = call(
        &app,
        Some(&token),
        &format!("/operations/{id}/swap-permit"),
        Some(permit.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{accepted}");
    assert_eq!(accepted["operation"]["state"], "building_swap");
    assert!(service.tick().await.unwrap());
    let (status, signing) = call(
        &app,
        Some(&token),
        &format!("/operations/{id}/swap-signing-request"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{signing}");
    assert_eq!(signing["reviewHash"], review["reviewHash"]);
    let p: PreparedEvm = serde_json::from_value(signing["prepared"].clone()).unwrap();
    assert_eq!(p.plan.steps.len(), 3);
    assert_eq!(
        call(
            &app,
            Some(&token),
            &format!("/operations/{id}/swap-permit"),
            Some(permit)
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    let submit = json!({"expectedVersion":signing["operationVersion"],"planHash":signing["planHash"],"signedTransactions":transactions(&p)});
    let (status, signed) = call(
        &app,
        Some(&token),
        &format!("/operations/{id}/swap-signed"),
        Some(submit.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{signed}");
    assert_eq!(signed["operation"]["state"], "signed");
    assert_eq!(
        call(
            &app,
            Some(&token),
            &format!("/operations/{id}/swap-signed"),
            Some(submit)
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert!(
        !signed
            .to_string()
            .contains(context.signature.as_ref().unwrap().as_str())
    );
    task.abort();
    rpc_task.abort();
    db.close().await;
}
