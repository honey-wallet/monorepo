use super::*;
mod common {
    use crate as honey_server;
    include!("../../tests/common/mod.rs");
}
use common::TestDatabase;
#[test]
fn dynamic_source_hash_and_across_deposit_id_are_not_required_before_signing() {
    let mut b = BridgeBinding {
        provider: BridgeProvider::Across,
        provider_reference: "7".into(),
        source_chain_id: "1".into(),
        destination_chain_id: "8453".into(),
        refund_chain_id: "1".into(),
        source_transaction_hash: format!("0x{}", "11".repeat(32)),
    };
    let terms = b.intent_terms().unwrap();
    assert!(terms.get("sourceTransactionHash").is_none());
    assert!(terms.get("providerReference").is_none());
    b.provider = BridgeProvider::Relay;
    assert_eq!(b.intent_terms().unwrap()["providerReference"], "7");
    assert!(b.lookup().is_ok());
}

fn binding() -> BridgeBinding {
    BridgeBinding {
        provider: BridgeProvider::Relay,
        provider_reference: "test-order".into(),
        source_chain_id: "1".into(),
        destination_chain_id: "8453".into(),
        refund_chain_id: "1".into(),
        source_transaction_hash: format!("0x{}", "22".repeat(32)),
    }
}
// Relational fixtures only. These are deliberately not a valid signed financial
// plan; transport/lease tests never call a dispatcher or claim contract acceptance.
async fn seed(db: &TestDatabase, b: &BridgeBinding, signed: bool) -> (Uuid, Uuid, Uuid) {
    seed_terms(db, b, signed, None).await
}
async fn seed_terms(
    db: &TestDatabase,
    b: &BridgeBinding,
    signed: bool,
    terms: Option<&crate::providers::across_evidence::DirectDepositTerms>,
) -> (Uuid, Uuid, Uuid) {
    let user = Uuid::new_v4();
    let wallet = Uuid::new_v4();
    let mut address = wallet.as_bytes().to_vec();
    address.extend_from_slice(&[0; 4]);
    if let Some(terms) = terms {
        address = terms.depositor.as_slice().to_vec();
    }
    sqlx::query("INSERT INTO users(id) VALUES($1)")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES($1,$2,1,$3,'eoa')").bind(wallet).bind(user).bind(address.clone()).execute(&db.pool).await.unwrap();
    let op = WorkStore::new(db.pool.clone())
        .create(crate::work::NewOperation {
            user_id: user,
            wallet_id: wallet,
            action: crate::work::Action::Bridge,
            idempotency_key: "bridge-fixture",
            intent: &serde_json::json!({"bridgeTracking":b.intent_terms().unwrap(),"acrossDirectDeposit":terms}),
        })
        .await
        .unwrap();
    if signed {
        sqlx::query("INSERT INTO operation_preparations(operation_id,canonical_json,plan_hash,expires_at) VALUES($1,'{}',$2,clock_timestamp()+interval '5 minutes')").bind(op.id).bind(vec![3u8;32]).execute(&db.pool).await.unwrap();
        sqlx::query("INSERT INTO evm_submissions(operation_id,wallet_id,chain_id,signer,plan_hash,first_nonce,step_count) VALUES($1,$2,1,$3,$4,0,2)").bind(op.id).bind(wallet).bind(address.clone()).bind(vec![3u8;32]).execute(&db.pool).await.unwrap();
        for step in 0..2i16 {
            let hash = if step == 1 {
                hex::decode(&b.source_transaction_hash[2..]).unwrap()
            } else {
                vec![4u8; 32]
            };
            sqlx::query("INSERT INTO evm_signed_transactions(id,operation_id,step,chain_id,signer,nonce,tx_hash,key_id,encryption_nonce,ciphertext) VALUES($1,$2,$3,1,$4,$3,$5,'fixture',$6,$7)")
                .bind(Uuid::new_v4()).bind(op.id).bind(step).bind(address.clone()).bind(hash).bind(vec![0u8;24]).bind(vec![0u8;17]).execute(&db.pool).await.unwrap();
        }
    }
    (user, wallet, op.id)
}

#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL and loopback RPC fixture"]
async fn across_registration_requires_verified_source_and_matching_financial_intent() {
    let proof = crate::providers::across_evidence::test_deposit().await;
    let terms = proof.terms();
    let b = BridgeBinding {
        provider: BridgeProvider::Across,
        provider_reference: proof.deposit_id(),
        source_chain_id: terms.source_chain.to_string(),
        destination_chain_id: terms.destination_chain.to_string(),
        refund_chain_id: terms.source_chain.to_string(),
        source_transaction_hash: format!("{:#x}", proof.source().transaction_hash),
    };
    let db = TestDatabase::new().await;
    let monitor = BridgeMonitor::new(WorkStore::new(db.pool.clone()));
    let (user, wallet, id) = seed_terms(&db, &b, true, Some(terms)).await;
    assert!(monitor.attach(id, &b).await.is_err());
    monitor.attach_across(id, &proof).await.unwrap();
    monitor.attach_across(id, &proof).await.unwrap();
    let recovered = monitor.recover(user, wallet, id).await.unwrap();
    assert_eq!(recovered.binding.provider_reference, "7");
    assert!(recovered.observation.is_none());
    assert!(recovered.stale);
    assert_eq!(
        monitor.work.get(user, wallet, id).await.unwrap().state,
        crate::work::OperationState::Created
    );
    db.close().await;
    let db = TestDatabase::new().await;
    let monitor = BridgeMonitor::new(WorkStore::new(db.pool.clone()));
    let mut different = terms.clone();
    different.depositor = alloy_primitives::Address::repeat_byte(99);
    let (_, _, wrong) = seed_terms(&db, &b, true, Some(&different)).await;
    assert!(monitor.attach_across(wrong, &proof).await.is_err());
    db.close().await;
    let db = TestDatabase::new().await;
    let monitor = BridgeMonitor::new(WorkStore::new(db.pool.clone()));
    let (_, _, missing) = seed(&db, &b, true).await;
    assert!(monitor.attach_across(missing, &proof).await.is_err());
    db.close().await;
}
fn report(b: &BridgeBinding) -> BridgeStatusReport {
    use crate::providers::bridge_status::{CandidateRole, CandidateTransaction, ReportedOutcome};
    BridgeStatusReport {
        provider: b.provider,
        reported_outcome: ReportedOutcome::FillReported,
        source_transaction_seen: true,
        candidates: vec![CandidateTransaction {
            chain_id: b.destination_chain_id.clone(),
            transaction_hash: format!("0x{}", "55".repeat(32)),
            role: CandidateRole::DestinationFill,
        }],
        observed_at_ms: now(),
        provider_updated_at_ms: None,
        verification_required: true,
        poll_after_ms: 10000,
    }
}
async fn due(db: &TestDatabase, id: Uuid) {
    sqlx::query("UPDATE bridge_status_watches SET next_poll_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1").bind(id).execute(&db.pool).await.unwrap();
}
fn client() -> BridgeStatusClient {
    let redis = crate::redis_store::RedisStore::new(
        redis::Client::open("redis://127.0.0.1:26379").unwrap(),
        "unused-bridge-test".into(),
        Duration::from_secs(1),
    );
    BridgeStatusClient::relay(
        Zeroizing::new("fixture".into()),
        RpcBudgetConfig {
            scope: "fixture".into(),
            interval_ms: 1,
            simulation_cost: 1,
        },
        redis,
        Arc::new(crate::metrics::Metrics::default()),
    )
    .unwrap()
}
#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL"]
async fn immutable_signed_binding_owner_isolation_leases_and_advisory_only() {
    let db = TestDatabase::new().await;
    let b = binding();
    let (user, wallet, id) = seed(&db, &b, true).await;
    let monitor = BridgeMonitor {
        work: WorkStore::new(db.pool.clone()),
        clients: vec![client()],
    };
    monitor.attach(id, &b).await.unwrap();
    monitor.attach(id, &b).await.unwrap();
    let mut other = b.clone();
    other.provider_reference = "changed-order".into();
    assert!(monitor.attach(id, &other).await.is_err());
    other = b.clone();
    other.source_transaction_hash = format!("0x{}", "04".repeat(32));
    assert!(monitor.attach(id, &other).await.is_err());
    assert!(matches!(
        monitor.recover(Uuid::new_v4(), wallet, id).await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        monitor.recover(user, Uuid::new_v4(), id).await,
        Err(AppError::NotFound)
    ));
    let (a, z) = tokio::join!(monitor.claim(), monitor.claim());
    let leases: Vec<_> = [a.unwrap(), z.unwrap()].into_iter().flatten().collect();
    assert_eq!(leases.len(), 1);
    let stale = &leases[0];
    sqlx::query("UPDATE bridge_status_watches SET lease_until=clock_timestamp()-interval '1 second' WHERE operation_id=$1").bind(id).execute(&db.pool).await.unwrap();
    let current = monitor.claim().await.unwrap().unwrap();
    assert!(monitor.record(stale, Ok(report(&b))).await.is_err());
    monitor.record(&current, Ok(report(&b))).await.unwrap();
    let first = monitor.recover(user, wallet, id).await.unwrap();
    assert!(!first.stale);
    assert_eq!(first.poll_version, "1");
    assert!(first.observation.as_ref().unwrap().verification_required);
    let operation = monitor.work.get(user, wallet, id).await.unwrap();
    assert_eq!(operation.state, crate::work::OperationState::Created);
    assert_eq!(operation.version, "0");
    let restarted = BridgeMonitor::new(WorkStore::new(db.pool.clone()));
    assert_eq!(
        serde_json::to_value(restarted.recover(user, wallet, id).await.unwrap()).unwrap(),
        serde_json::to_value(&first).unwrap()
    );
    assert!(restarted.claim().await.unwrap().is_none());
    due(&db, id).await;
    let lease = monitor.claim().await.unwrap().unwrap();
    monitor
        .record(&lease, Err(StatusError::Unavailable))
        .await
        .unwrap();
    let latest = monitor.recover(user, wallet, id).await.unwrap();
    assert_eq!(latest.last_error_code.as_deref(), Some("unavailable"));
    assert_eq!(
        latest.observation.unwrap().observed_at_ms,
        first.observation.unwrap().observed_at_ms
    );
    assert!(
        sqlx::query("UPDATE bridge_status_watches SET binding_json='{}' WHERE operation_id=$1")
            .bind(id)
            .execute(&db.pool)
            .await
            .is_err()
    );
    let (_, _, unsigned) = seed(&db, &b, false).await;
    assert!(monitor.attach(unsigned, &b).await.is_err());
    db.close().await;
}
#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL and TEST_REDIS_URL"]
async fn worker_persists_provider_candidate_and_http_read_requires_owner_session() {
    use axum::{
        Json, Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode},
        routing::get,
    };
    use tower::ServiceExt;
    let db = TestDatabase::new().await;
    let b = binding();
    let (user, wallet, id) = seed(&db, &b, true).await;
    let body = serde_json::json!({"status":"success","originChainId":1,"destinationChainId":8453,"inTxHashes":[b.source_transaction_hash],"txHashes":[format!("0x{}","55".repeat(32))]});
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/intents/status/v3", get(move || async { Json(body) })),
        )
        .await
        .unwrap()
    });
    let redis = crate::redis_store::RedisStore::new(
        redis::Client::open(std::env::var("TEST_REDIS_URL").unwrap()).unwrap(),
        format!("bridge-worker-{}", Uuid::new_v4().simple()),
        Duration::from_secs(2),
    );
    let client = BridgeStatusClient::relay(
        Zeroizing::new("fixture".into()),
        RpcBudgetConfig {
            scope: "fixture".into(),
            interval_ms: 1,
            simulation_cost: 1,
        },
        redis.clone(),
        Arc::new(crate::metrics::Metrics::default()),
    )
    .unwrap()
    .with_test_origin(origin);
    let monitor = Arc::new(BridgeMonitor {
        work: WorkStore::new(db.pool.clone()),
        clients: vec![client],
    });
    monitor.attach(id, &b).await.unwrap();
    assert!(monitor.tick().await.unwrap());
    assert!(!monitor.tick().await.unwrap());
    let identity = crate::identity::Identity::new(
        db.pool.clone(),
        crate::config::AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        },
    )
    .unwrap();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,wallet_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '15 minutes')").bind(digest(token.as_bytes())).bind(user).bind(wallet).execute(&db.pool).await.unwrap();
    let app = crate::routes::bridges::router(Some(identity), Some(monitor));
    let path = format!("/operations/{id}/bridge-status");
    assert_eq!(
        app.clone()
            .oneshot(Request::get(&path).body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = app
        .oneshot(
            Request::get(path)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 10000).await.unwrap()).unwrap();
    assert_eq!(response["operationId"], id.to_string());
    assert_eq!(response["verifiedDelivery"], serde_json::Value::Null);
    assert_eq!(response["observation"]["reportedOutcome"], "fill_reported");
    assert_eq!(response["observation"]["verificationRequired"], true);
    assert!(!response.to_string().contains(&token));
    task.abort();
    let _: i32 = redis
        .query(
            redis::cmd("DEL")
                .arg(redis.key("rpc-budget-relay-fixture", "policy"))
                .arg(redis.key("rpc-budget-relay-fixture", "next")),
        )
        .await
        .unwrap();
    db.close().await;
}
