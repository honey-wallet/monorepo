//! Opt-in HTTP acceptance for the local Across execution boundary. This test
//! exercises API auth, quote binding and idempotency against disposable PG/Redis
//! plus a loopback quote fixture; it never signs or broadcasts transactions.
mod common;

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::Query,
    http::{Request, StatusCode},
    routing::get,
};
use common::TestDatabase;
use honey_server::{
    config::AuthConfig, identity::Identity, metrics::Metrics, redis_store::RedisStore,
    routes::across, work::OperationState,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap, io::Write, os::unix::fs::OpenOptionsExt, sync::Arc, time::Duration,
};
use tokio::net::TcpListener;
use tower::ServiceExt;
use uuid::Uuid;

fn address(n: u8) -> String {
    format!("0x{n:040x}")
}

fn replace_word(data: &mut String, index: usize, value: u64) {
    let start = 2 + 8 + index * 64;
    data.replace_range(start..start + 64, &format!("{value:064x}"));
}

fn provider_quote() -> Value {
    let evidence: Value =
        serde_json::from_str(include_str!("fixtures/across-direct-evidence.json")).unwrap();
    let now = time::OffsetDateTime::now_utc().unix_timestamp() as u64;
    let mut calldata = evidence["calldata"].as_str().unwrap().to_owned();
    replace_word(&mut calldata, 6, 31338);
    replace_word(&mut calldata, 8, now - 100);
    replace_word(&mut calldata, 9, now + 3600);
    calldata.push_str("1dc0deabcd73c0de");
    let input_token = json!({"address":address(3),"symbol":"USDC","decimals":6,"chainId":31337});
    let output_token = json!({"address":address(4),"symbol":"USDC","decimals":6,"chainId":31338});
    let fee = json!({"amount":"10000","pct":"10000000000000000","token":input_token});
    json!({
        "crossSwapType":"bridgeableToBridgeable", "amountType":"exactInput",
        "checks":{"allowance":{"token":address(3),"spender":address(5),"actual":"0","expected":"1000000"},
                   "balance":{"token":address(3),"actual":"2000000","expected":"1000000"}},
        "approvalTxns":null,
        "steps":{"bridge":{"provider":"across","inputAmount":"1000000","outputAmount":"990000",
            "tokenIn":input_token,"tokenOut":output_token,"fees":fee}},
        "inputToken":input_token,"outputToken":output_token,"refundToken":input_token,
        "fees":{"total":fee}, "inputAmount":"1000000","maxInputAmount":"1000000",
        "expectedOutputAmount":"990000","minOutputAmount":"990000","expectedFillTime":10,
        "id":"acceptance-quote", "swapTx":{"simulationSuccess":true,"chainId":31337,"to":address(5),
            "data":calldata,"value":"0","gas":"150000","maxFeePerGas":"200","maxPriorityFeePerGas":"2"}
    })
}

async fn quote_fixture(Query(_query): Query<HashMap<String, String>>) -> Json<Value> {
    Json(provider_quote())
}

fn write_private(path: &std::path::Path, value: &Value) {
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    f.write_all(value.to_string().as_bytes()).unwrap();
}

#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL, TEST_REDIS_URL and loopback fixture listener"]
async fn authenticated_quote_create_replay_and_owner_bound_signing_gate() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
    let db = TestDatabase::new().await;
    let redis = RedisStore::new(
        redis::Client::open(std::env::var("TEST_REDIS_URL").expect("TEST_REDIS_URL")).unwrap(),
        format!("across-http-{}", Uuid::new_v4().simple()),
        Duration::from_secs(2),
    );
    let fixture_app = Router::new().route("/swap/approval", get(quote_fixture));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let fixture_task =
        tokio::spawn(async move { axum::serve(listener, fixture_app).await.unwrap() });

    let directory = std::env::temp_dir();
    let suffix = Uuid::new_v4().simple().to_string();
    let quote_path = directory.join(format!("honey-across-quote-{suffix}.json"));
    let service_path = directory.join(format!("honey-across-service-{suffix}.json"));
    let quote_config = json!({
        "apiKey":"local-fixture-only", "accountScope":"acceptance", "intervalMs":1,
        "sourceChainId":"31337", "integratorId":"0xabcd", "registryRevision":"fixture-v1",
        "routes":[{"id":"usdc-local","destinationChainId":"31338","sourceSpoke":address(5),
            "inputToken":{"assetId":"usdc-fixture","address":address(3),"symbol":"USDC","decimals":6},
            "outputToken":{"assetId":"usdc-fixture","address":address(4),"symbol":"USDC","decimals":6},
            "minimumInputRaw":"100000","maximumInputRaw":"100000000","maximumBridgeFeeBps":200,
            "maximumFillSeconds":3600,"maximumExclusivitySeconds":120}]
    });
    write_private(&quote_path, &quote_config);
    let pin = |n: u8| json!({"address":address(n),"codeHash":format!("0x{}", "11".repeat(32))});
    let service_config = json!({
        "mode":"local_fork", "rpcUrl":"http://127.0.0.1:1", "rpcBudget":{"scope":"across-source","intervalMs":1,"simulationCost":1},
        "destinationRpcUrl":"http://127.0.0.1:1", "destinationRpcBudget":{"scope":"across-destination","intervalMs":1,"simulationCost":1},
        "quoteConfigFile":quote_path, "quoteFixtureOrigin":origin, "statusFixtureOrigin":origin,
        "registryRevision":"fixture-v1",
        "sourcePolicy":{"chain":31337,"spoke":pin(5),"spokeImplementation":pin(7),"token":pin(3),"tokenImplementation":null,"wrappedNative":address(6)},
        "destinationPolicy":{"chain":31338,"spoke":pin(8),"spokeImplementation":pin(9),"token":pin(4),"tokenImplementation":null,"wrappedNative":address(10)},
        "decimals":6,"allowEmptyApprovalReturn":false,"maximumGasPerTransaction":500000,
        "activeKeyId":"fixture-key","dataKeys":{"fixture-key": "22".repeat(32)}
    });
    write_private(&service_path, &service_config);
    let work = honey_server::work::WorkStore::new(db.pool.clone());
    let service = Arc::new(
        honey_server::across_service::AcrossService::from_file(
            work.clone(),
            service_path.to_str().unwrap(),
            redis.clone(),
            Arc::new(Metrics::default()),
        )
        .unwrap(),
    );

    let user = Uuid::new_v4();
    let wallet = Uuid::new_v4();
    let other_wallet = Uuid::new_v4();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO users(id) VALUES($1)")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    for (id, addr) in [
        (wallet, hex::decode(&address(1)[2..]).unwrap()),
        (other_wallet, hex::decode(&address(2)[2..]).unwrap()),
    ] {
        sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES($1,$2,31337,$3,'eoa')")
            .bind(id).bind(user).bind(addr).execute(&db.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,wallet_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '15 minutes')")
        .bind(Sha256::digest(token.as_bytes()).to_vec()).bind(user).bind(wallet).execute(&db.pool).await.unwrap();
    let identity = Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 31337,
        },
    )
    .unwrap();
    let app = across::router(Some(identity), None, Some(service));
    let send = |method: &str, path: String, body: Value, auth: Option<&str>| {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("idempotency-key", "bridge-acceptance-1");
        if let Some(value) = auth {
            request = request.header("authorization", format!("Bearer {value}"));
        }
        app.clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
    };
    let quote_request = json!({"routeId":"usdc-local","amountRaw":"1000000","minimumOutputRaw":"980000","recipient":address(2)});
    // A malformed operation ID must not bypass the bearer check, and an
    // authenticated request must use Honey's stable JSON error envelope.
    assert_eq!(
        send(
            "GET",
            "/operations/not-a-uuid/across-intent".into(),
            json!({}),
            None,
        )
        .await
        .unwrap()
        .status(),
        StatusCode::UNAUTHORIZED
    );
    for (method, path, body) in [
        ("GET", "/operations/not-a-uuid/across-intent", json!({})),
        (
            "GET",
            "/operations/not-a-uuid/across-signing-request",
            json!({}),
        ),
        ("POST", "/operations/not-a-uuid/across-signed", json!({})),
    ] {
        let response = send(method, path.into(), body, Some(&token)).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let error: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(error["error"]["code"], "bad_request");
        assert_eq!(error["error"]["message"], "invalid operation ID");
    }

    assert_eq!(
        send(
            "POST",
            "/bridges/across/quote".into(),
            quote_request.clone(),
            None
        )
        .await
        .unwrap()
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let quote_response = send(
        "POST",
        "/bridges/across/quote".into(),
        quote_request.clone(),
        Some(&token),
    )
    .await
    .unwrap();
    let quote_status = quote_response.status();
    let bytes = to_bytes(quote_response.into_body(), 8192).await.unwrap();
    assert_eq!(
        quote_status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let public_quote: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(public_quote["quoteId"], "acceptance-quote");
    for forbidden in ["calldata", "swapTx", "approvalTxns", "local-fixture-only"] {
        assert!(!String::from_utf8_lossy(&bytes).contains(forbidden));
    }
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let create_body = json!({"routeId":"usdc-local","quoteId":"acceptance-quote","amountRaw":"1000000",
        "minimumOutputRaw":"980000","recipient":address(2),"deadline":(now+900).to_string(),"maximumNetworkFeeRaw":"100000000000000000"});
    let created = send(
        "POST",
        "/bridges/across/operations".into(),
        create_body.clone(),
        Some(&token),
    )
    .await
    .unwrap();
    let created_status = created.status();
    let created_bytes = to_bytes(created.into_body(), 8192).await.unwrap();
    assert_eq!(
        created_status,
        StatusCode::ACCEPTED,
        "{}",
        String::from_utf8_lossy(&created_bytes)
    );
    let recovery: Value = serde_json::from_slice(&created_bytes).unwrap();
    assert_eq!(recovery["operation"]["state"], "created");
    let operation_id = recovery["operation"]["id"].as_str().unwrap();

    // Real create uses the same validated immutable interpretation as monitor
    // attachment and destination settlement. It stores the service schema intact.
    let stored: String =
        sqlx::query_scalar("SELECT canonical_json FROM operation_intents WHERE operation_id=$1")
            .bind(Uuid::parse_str(operation_id).unwrap())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let stored_intent: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored_intent["service"], "across_local_v1");
    assert_eq!(stored_intent["terms"]["sourceChain"], "31337");
    assert_eq!(stored_intent["terms"]["destinationChain"], "31338");
    assert!(stored_intent.get("bridgeTracking").is_none());
    assert!(stored_intent.get("acrossDirectDeposit").is_none());

    let intent_path = format!("/operations/{operation_id}/across-intent");
    let intent_response = send("GET", intent_path.clone(), json!({}), Some(&token))
        .await
        .unwrap();
    assert_eq!(intent_response.status(), StatusCode::OK);
    let intent: Value =
        serde_json::from_slice(&to_bytes(intent_response.into_body(), 8192).await.unwrap())
            .unwrap();
    assert_eq!(intent["intent"]["quoteId"], "acceptance-quote");
    assert!(intent.get("terms").is_none() && intent.get("calldata").is_none());
    let signing_path = format!("/operations/{operation_id}/across-signing-request");
    assert_eq!(
        send("GET", signing_path.clone(), json!({}), Some(&token))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    // The immutable operation is the idempotency authority after the short-lived
    // Redis quote cache is gone; no provider request is needed for an exact retry.
    let _: i32 = redis
        .query(
            redis::cmd("DEL").arg(redis.key("across-quote", &format!("{wallet}:acceptance-quote"))),
        )
        .await
        .unwrap();
    let replay = send(
        "POST",
        "/bridges/across/operations".into(),
        create_body.clone(),
        Some(&token),
    )
    .await
    .unwrap();
    assert_eq!(replay.status(), StatusCode::ACCEPTED);
    let replay: Value =
        serde_json::from_slice(&to_bytes(replay.into_body(), 8192).await.unwrap()).unwrap();
    assert_eq!(replay["operation"]["id"], operation_id);
    assert_eq!(replay["operation"]["version"], "0");
    let mut altered = create_body.clone();
    altered["deadline"] = json!((now + 899).to_string());
    assert_eq!(
        send(
            "POST",
            "/bridges/across/operations".into(),
            altered,
            Some(&token)
        )
        .await
        .unwrap()
        .status(),
        StatusCode::CONFLICT
    );

    // A second wallet under the same principal cannot read the first wallet's
    // quote-created intent or access signing data.
    sqlx::query("UPDATE auth_sessions SET wallet_id=$2 WHERE token_hash=$1")
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .bind(other_wallet)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        send("GET", intent_path, json!({}), Some(&token))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send("GET", signing_path, json!({}), Some(&token))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let state: OperationState = work
        .get(user, wallet, Uuid::parse_str(operation_id).unwrap())
        .await
        .unwrap()
        .state;
    assert_eq!(state, OperationState::Created);

    fixture_task.abort();
    let _ = std::fs::remove_file(quote_path);
    let _ = std::fs::remove_file(service_path);
    db.close().await;
}
