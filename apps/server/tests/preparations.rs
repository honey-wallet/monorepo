//! Real PostgreSQL persistence/rollback/recovery tests; use disposable services only.
mod common;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::TestDatabase;
use honey_server::{
    config::{AuthConfig, SecretUrl},
    error::AppError,
    preparation::{
        AssetAmount, CallPurpose, EvmCall, EvmPreparation, PreparationProvider, SimulationRecord,
        calls_hash,
    },
    work::{Action, JobLease, NewOperation, OperationState, Topic, WorkStore},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use uuid::Uuid;

const ADDRESS: &str = "0x1111111111111111111111111111111111111111";
const TARGET: &str = "0x2222222222222222222222222222222222222222";
fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
fn plan() -> EvmPreparation {
    let steps = vec![EvmCall {
        purpose: CallPurpose::Action,
        to: TARGET.into(),
        value_raw: "0".into(),
        data: "0x12345678".into(),
    }];
    EvmPreparation {
        schema_version: 1,
        provider: PreparationProvider::AaveV3,
        chain_id: "1".into(),
        signer: ADDRESS.into(),
        intent_hash: "a".repeat(64),
        registry_revision: "test-registry-v1".into(),
        fee_policy_revision: "test-no-app-fee-v1".into(),
        quote_reference: None,
        expires_at_ms: now_ms() + 120000,
        maximum_network_fee_raw: "1000000000000000".into(),
        maximum_spend: AssetAmount {
            asset_address: Some(TARGET.into()),
            amount_raw: "9007199254740993".into(),
            recipient: ADDRESS.into(),
        },
        minimum_receive: None,
        fees: vec![],
        simulation: SimulationRecord {
            block_number: "18446744073709551615".into(),
            block_hash: format!("0x{}", "b".repeat(64)),
            calls_hash: calls_hash(&steps).unwrap(),
            observed_at_ms: now_ms(),
        },
        steps,
    }
}
#[test]
fn bounded_exact_preparations_reject_ambiguous_or_changed_calls() {
    let original = plan();
    original.validate().unwrap();
    let mutations: &[fn(&mut EvmPreparation)] = &[
        |p| p.maximum_spend.amount_raw = "9007199254740993.1".into(),
        |p| p.maximum_spend.amount_raw = "01".into(),
        |p| p.maximum_spend.amount_raw = "9".repeat(79),
        |p| p.maximum_spend.recipient = "0x00".into(),
        |p| p.chain_id = "01".into(),
        |p| p.chain_id = "9223372036854775808".into(),
        |p| p.steps[0].to = ADDRESS.into(),
        |p| p.steps[0].data = "0x123".into(),
        |p| p.steps[0].data = format!("0x{}", "ff".repeat(4097)),
        |p| p.steps = vec![p.steps[0].clone(); 9],
        |p| p.provider = PreparationProvider::Uniswap,
        |p| p.registry_revision = "untrusted\nlog".into(),
        |p| p.simulation.block_number = "18446744073709551616".into(),
        |p| p.steps.clear(),
        |p| p.schema_version = 2,
    ];
    for mutate in mutations {
        let mut p = original.clone();
        mutate(&mut p);
        assert!(p.validate().is_err(), "{p:?}");
    }
    let mut unknown = serde_json::to_value(&original).unwrap();
    unknown["privateKey"] = json!("never accepted");
    assert!(serde_json::from_value::<EvmPreparation>(unknown).is_err());
    let mut numeric = serde_json::to_value(&original).unwrap();
    numeric["maximumSpend"]["amountRaw"] = json!(9007199254740993u64);
    assert!(serde_json::from_value::<EvmPreparation>(numeric).is_err());
}
struct Fixture {
    store: WorkStore,
    user: Uuid,
    wallet: Uuid,
    id: Uuid,
    lease: JobLease,
    plan: EvmPreparation,
    token: String,
}
async fn setup(db: &TestDatabase) -> Fixture {
    let user = Uuid::new_v4();
    let wallet = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id) VALUES ($1)")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,1,$3,'eoa')")
        .bind(wallet).bind(user).bind(vec![0x11u8;20]).execute(&db.pool).await.unwrap();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,wallet_id,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '15 minutes')")
        .bind(Sha256::digest(token.as_bytes()).to_vec()).bind(user).bind(wallet).execute(&db.pool).await.unwrap();
    let store = WorkStore::new(db.pool.clone());
    let op = store
        .create(NewOperation {
            user_id: user,
            wallet_id: wallet,
            action: Action::Earn,
            idempotency_key: "prepare-test",
            intent: &json!({"amountRaw":"9007199254740993","asset":TARGET,"receiver":ADDRESS}),
        })
        .await
        .unwrap();
    let mut plan = plan();
    plan.intent_hash =
        sqlx::query_scalar("SELECT encode(intent_hash,'hex') FROM operations WHERE id=$1")
            .bind(op.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let lease = store
        .claim(Topic::OperationCreated, 30)
        .await
        .unwrap()
        .unwrap();
    Fixture {
        store,
        user,
        wallet,
        id: op.id,
        lease,
        plan,
        token,
    }
}
async fn counts(db: &TestDatabase) -> (i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM operation_preparations), (SELECT count(*) FROM jobs), (SELECT version FROM operations LIMIT 1)")
        .fetch_one(&db.pool).await.unwrap()
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn prepare_race_commits_one_immutable_plan_and_successor_and_recovers_after_restart() {
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    let (a, b) = tokio::join!(
        f.store.persist_preparation(&f.lease, &f.plan),
        f.store.persist_preparation(&f.lease, &f.plan)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(counts(&db).await, (1, 2, 1));
    assert!(!f.store.complete(&f.lease).await.unwrap());
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect_with((*db.pool.connect_options()).clone())
        .await
        .unwrap();
    let restarted = WorkStore::new(pool.clone());
    let result = restarted.recover(f.user, f.wallet, f.id).await.unwrap();
    assert_eq!(result.operation.state, OperationState::AwaitingSignature);
    assert!(result.intent_available && !result.execution_available);
    assert!(!result.preparation.unwrap().expired);
    let restored = restarted
        .load_preparation(f.user, f.wallet, f.id)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(&f.plan).unwrap()
    );
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    assert!(
        f.store
            .transition(f.id, 1, OperationState::Submitted, &lease)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE operation_preparations SET canonical_json='{}'")
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM operation_intents")
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert_eq!(counts(&db).await, (1, 2, 1));
    // Simulate corrupted restore/operator bypass, not a supported application write.
    sqlx::query("ALTER TABLE operation_preparations DISABLE TRIGGER USER")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE operation_preparations SET plan_hash=$1")
        .bind(vec![0u8; 32])
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        restarted.recover(f.user, f.wallet, f.id).await,
        Err(AppError::Busy)
    ));
    pool.close().await;
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn preparation_binds_identity_intent_action_simulation_age_and_expiry() {
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    let mutations: &[fn(&mut EvmPreparation)] = &[
        |p| p.chain_id = "2".into(),
        |p| p.signer = TARGET.into(),
        |p| p.intent_hash = "b".repeat(64),
        |p| p.provider = PreparationProvider::NativeTransfer,
        |p| p.expires_at_ms = now_ms() - 1,
        |p| p.expires_at_ms = now_ms() + 901000,
        |p| p.simulation.observed_at_ms = now_ms() - 61000,
        |p| p.simulation.observed_at_ms = now_ms() + 10000,
    ];
    for mutate in mutations {
        let mut p = f.plan.clone();
        mutate(&mut p);
        assert!(f.store.persist_preparation(&f.lease, &p).await.is_err());
        assert_eq!(counts(&db).await, (0, 1, 0));
    }
    f.store
        .persist_preparation(&f.lease, &f.plan)
        .await
        .unwrap();
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn failed_outbox_write_rolls_back_plan_state_and_job_acknowledgement() {
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    // Existing created job can be acknowledged, but the successor insert must fail.
    sqlx::query("ALTER TABLE jobs ADD CONSTRAINT test_outbox_failure CHECK (topic <> 'operation.changed') NOT VALID").execute(&db.pool).await.unwrap();
    assert!(
        f.store
            .persist_preparation(&f.lease, &f.plan)
            .await
            .is_err()
    );
    assert_eq!(counts(&db).await, (0, 1, 0));
    let state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id=$1")
        .bind(f.lease.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(state, "leased");
    sqlx::query("ALTER TABLE jobs DROP CONSTRAINT test_outbox_failure")
        .execute(&db.pool)
        .await
        .unwrap();
    f.store
        .persist_preparation(&f.lease, &f.plan)
        .await
        .unwrap();
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn lease_expiring_while_waiting_for_operation_lock_cannot_install_plan() {
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    sqlx::query("UPDATE jobs SET lease_until=clock_timestamp()+interval '500 milliseconds'")
        .execute(&db.pool)
        .await
        .unwrap();
    let mut lock = db.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM operations WHERE id=$1 FOR UPDATE")
        .bind(f.id)
        .execute(&mut *lock)
        .await
        .unwrap();
    let task = tokio::spawn(async move { f.store.persist_preparation(&f.lease, &f.plan).await });
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    lock.commit().await.unwrap();
    assert!(task.await.unwrap().is_err());
    assert_eq!(counts(&db).await, (0, 1, 0));
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn legacy_digest_only_records_stay_readable_but_cannot_be_prepared() {
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO operations(id,user_id,wallet_id,action,idempotency_key,intent_hash) VALUES ($1,$2,$3,'earn','legacy',$4)")
        .bind(id).bind(f.user).bind(f.wallet).bind(vec![0u8;32]).execute(&db.pool).await.unwrap();
    let result = f.store.recover(f.user, f.wallet, id).await.unwrap();
    assert!(!result.intent_available);
    assert!(result.preparation.is_none());
    assert!(matches!(
        f.store.load_preparation(f.user, f.wallet, id).await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        f.store.recover(Uuid::new_v4(), f.wallet, f.id).await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        f.store.recover(f.user, Uuid::new_v4(), f.id).await,
        Err(AppError::NotFound)
    ));
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn production_recovery_route_is_authenticated_scoped_and_never_returns_signable_payload() {
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    f.store
        .persist_preparation(&f.lease, &f.plan)
        .await
        .unwrap();
    let config = honey_server::Config {
        database_url: Some(SecretUrl::new(
            sqlx::ConnectOptions::to_url_lossy(db.pool.connect_options().as_ref()).to_string(),
        )),
        auth: Some(AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        }),
        ..honey_server::Config::default()
    };
    let infrastructure = honey_server::runtime::Infrastructure::new(&config).unwrap();
    let health = honey_server::runtime::RuntimeHealth::new(&config);
    let app =
        honey_server::build_router_with_infrastructure(&config, health, &infrastructure).unwrap();
    let request = |token: Option<&str>, id: String| {
        let mut r = Request::builder().uri(format!("/api/v1/operations/{id}"));
        if let Some(token) = token {
            r = r.header("authorization", format!("Bearer {token}"));
        }
        r.body(Body::empty()).unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(request(None, f.id.to_string()))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(request(Some(&f.token), Uuid::new_v4().to_string()))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let other_user = Uuid::new_v4();
    let other_wallet = Uuid::new_v4();
    let other_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id) VALUES ($1)")
        .bind(other_user)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,1,$3,'eoa')")
        .bind(other_wallet).bind(other_user).bind(vec![0x33u8;20]).execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO operations(id,user_id,wallet_id,action,idempotency_key,intent_hash) VALUES ($1,$2,$3,'earn','other',$4)")
        .bind(other_id).bind(other_user).bind(other_wallet).bind(vec![0u8;32]).execute(&db.pool).await.unwrap();
    assert_eq!(
        app.clone()
            .oneshot(request(Some(&f.token), other_id.to_string()))
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let response = app
        .clone()
        .oneshot(request(Some(&f.token), f.id.to_string()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().contains_key("x-request-id"));
    assert_eq!(response.headers()["cache-control"], "no-store");
    let v: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap()).unwrap();
    assert_eq!(v["executionAvailable"], false);
    assert_eq!(v["preparation"]["stepCount"], 1);
    assert_eq!(v["operation"]["version"], "1");
    for private in ["steps", "intent", "signer", "token", "maximumSpend", "data"] {
        assert!(!v.to_string().contains(&format!("\"{private}\"")));
    }
    sqlx::query("UPDATE auth_sessions SET revoked_at=clock_timestamp()")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        app.oneshot(request(Some(&f.token), f.id.to_string()))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    infrastructure.close().await;
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn expired_preparation_remains_recoverable_without_reopening_execution() {
    let db = TestDatabase::new().await;
    let mut f = setup(&db).await;
    f.plan.expires_at_ms = now_ms() + 1000;
    f.store
        .persist_preparation(&f.lease, &f.plan)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let recovered = f.store.recover(f.user, f.wallet, f.id).await.unwrap();
    assert!(recovered.preparation.unwrap().expired);
    assert!(!recovered.execution_available);
    assert_eq!(recovered.operation.state, OperationState::AwaitingSignature);
    assert!(
        f.store
            .load_preparation(f.user, f.wallet, f.id)
            .await
            .is_ok()
    );
    assert!(
        f.store
            .persist_preparation(&f.lease, &f.plan)
            .await
            .is_err()
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn authenticated_runtime_requires_the_new_explicit_schema_migration() {
    use honey_server::runtime::{DependencyStatus, Infrastructure, ReadinessStatus, RuntimeHealth};
    let db = TestDatabase::new().await;
    let config = honey_server::Config {
        database_url: Some(SecretUrl::new(
            sqlx::ConnectOptions::to_url_lossy(db.pool.connect_options().as_ref()).to_string(),
        )),
        auth: Some(AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        }),
        ..honey_server::Config::default()
    };
    // Simulate a release for which the required migration has not succeeded.
    sqlx::query("UPDATE _sqlx_migrations SET success=false WHERE version=$1")
        .bind(honey_server::database::LATEST_SCHEMA_VERSION)
        .execute(&db.pool)
        .await
        .unwrap();
    let infrastructure = std::sync::Arc::new(Infrastructure::new(&config).unwrap());
    let health = RuntimeHealth::new(&config);
    let monitor = infrastructure.clone().start_monitor(health.clone());
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while health.readiness().dependencies.postgres != DependencyStatus::Down {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        health.readiness().status,
        ReadinessStatus::NotReady
    ));
    sqlx::query("UPDATE _sqlx_migrations SET success=true WHERE version=$1")
        .bind(honey_server::database::LATEST_SCHEMA_VERSION)
        .execute(&db.pool)
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !matches!(health.readiness().status, ReadinessStatus::Ready) {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    monitor.abort();
    let _ = monitor.await;
    infrastructure.close().await;
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn aave_signing_terms_commit_atomically_and_remain_immutable() {
    use honey_server::providers::aave_execution::PreparedAave;
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    let mut plan = f.plan.clone();
    plan.maximum_network_fee_raw = "21000".into();
    let mut prepared = PreparedAave {
        plan,
        first_nonce: "0".into(),
        gas_limits: vec!["21000".into()],
        max_fee_per_gas: "1".into(),
        max_priority_fee_per_gas: "1".into(),
    };
    prepared.gas_limits[0] = "21001".into();
    assert!(
        f.store
            .persist_aave_preparation(&f.lease, &prepared)
            .await
            .is_err()
    );
    assert_eq!(
        f.store.get(f.user, f.wallet, f.id).await.unwrap().state,
        OperationState::Created
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM evm_signing_requests")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    prepared.gas_limits[0] = "21000".into();
    f.store
        .persist_aave_preparation(&f.lease, &prepared)
        .await
        .unwrap();
    let saved: String =
        sqlx::query_scalar("SELECT canonical_json FROM evm_signing_requests WHERE operation_id=$1")
            .bind(f.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(saved, serde_json::to_string(&prepared).unwrap());
    let before: (String, Vec<u8>) = sqlx::query_as(
        "SELECT canonical_json, request_hash FROM evm_signing_requests WHERE operation_id=$1",
    )
    .bind(f.id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    // Recreate the previous metadata names around populated evidence, then apply
    // the actual forward migration. No payloads or migration ledger are edited.
    sqlx::raw_sql(
        "ALTER TABLE evm_signing_requests RENAME TO aave_signing_requests;
         ALTER TRIGGER immutable_evm_signing ON aave_signing_requests RENAME TO immutable_aave_signing;
         ALTER INDEX earn_intent_service RENAME TO aave_intent_service;",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../migrations/202610180007_earn_signing.sql"))
        .execute(&db.pool)
        .await
        .unwrap();
    let after: (String, Vec<u8>) = sqlx::query_as(
        "SELECT canonical_json, request_hash FROM evm_signing_requests WHERE operation_id=$1",
    )
    .bind(f.id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        f.store.get(f.user, f.wallet, f.id).await.unwrap().state,
        OperationState::AwaitingSignature
    );
    assert!(
        sqlx::query("UPDATE evm_signing_requests SET canonical_json='{}' WHERE operation_id=$1")
            .bind(f.id)
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM evm_signing_requests WHERE operation_id=$1")
            .bind(f.id)
            .execute(&db.pool)
            .await
            .is_err()
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn aave_api_authentication_idempotency_ownership_and_strict_bodies() {
    use honey_server::{aave_service::AaveService, identity::Identity};
    use std::sync::Arc;
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    sqlx::query("UPDATE wallet_memberships SET chain_id=31337 WHERE id=$1")
        .bind(f.wallet)
        .execute(&db.pool)
        .await
        .unwrap();
    let path = std::env::temp_dir().join(format!("honey-aave-config-{}.json", Uuid::new_v4()));
    let mut config = json!({"mode":"local_fork","rpcUrl":"http://127.0.0.1:1","chainId":"31337","pool":TARGET,"asset":ADDRESS,"aToken":"0x3333333333333333333333333333333333333333","decimals":6,"poolCodeHash":format!("0x{}","aa".repeat(32)),"assetCodeHash":format!("0x{}","aa".repeat(32)),"aTokenCodeHash":format!("0x{}","aa".repeat(32)),"registryRevision":"test","zeroFeePolicyRevision":"test-zero","maximumGasPerTransaction":500000,"maximumAtokenRoundingRaw":"2","activeKeyId":"fixture","dataKeys":{"fixture":"55".repeat(32)}});
    config["rpcBudget"] = json!({"scope":"aave-test", "intervalMs":10, "simulationCost":10});
    for key in [
        "poolImplementation",
        "assetImplementation",
        "aTokenImplementation",
    ] {
        config[key] = json!({"address":"0x4444444444444444444444444444444444444444", "codeHash":format!("0x{}", "aa".repeat(32))});
    }
    let redis = honey_server::redis_store::RedisStore::new(
        redis::Client::open("redis://127.0.0.1:1").unwrap(),
        "aave-config-test".into(),
        std::time::Duration::from_millis(50),
    );
    let metrics = Arc::new(honey_server::metrics::Metrics::default());
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&path)
        .unwrap()
        .write_all(serde_json::to_string(&config).unwrap().as_bytes())
        .unwrap();
    let service = Arc::new(
        AaveService::from_file(
            f.store.clone(),
            path.to_str().unwrap(),
            redis.clone(),
            metrics.clone(),
        )
        .unwrap(),
    );
    for (field, value) in [
        ("mode", json!("production")),
        (
            "rpcBudget",
            json!({"scope":"bad-scope", "intervalMs":0, "simulationCost":1}),
        ),
        (
            "poolImplementation",
            json!({"address":"0x0000000000000000000000000000000000000000", "codeHash":format!("0x{}", "aa".repeat(32))}),
        ),
        ("assetImplementation", json!(null)),
        ("chainId", json!("1")),
        ("rpcUrl", json!("https://eth.drpc.org")),
        ("rpcUrl", json!("http://localhost:28545")),
        ("rpcUrl", json!("http://user:password@127.0.0.1:28545")),
        ("dataKeys", json!({})),
        ("activeKeyId", json!("missing")),
        ("dataKeys", json!({"fixture":"short"})),
    ] {
        let mut invalid = config.clone();
        invalid[field] = value;
        std::fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(
            AaveService::from_file(
                f.store.clone(),
                path.to_str().unwrap(),
                redis.clone(),
                metrics.clone()
            )
            .is_err(),
            "{field}"
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            AaveService::from_file(
                f.store.clone(),
                path.to_str().unwrap(),
                redis.clone(),
                metrics.clone()
            )
            .is_err()
        );
    }
    std::fs::remove_file(path).unwrap();
    let app = honey_server::routes::aave::router(
        Some(
            Identity::new(
                db.pool.clone(),
                AuthConfig {
                    origin: "http://localhost:5173".into(),
                    additional_origins: vec![],
                    chain_id: 31337,
                },
            )
            .unwrap(),
        ),
        Some(service),
    );
    let configuration = app
        .clone()
        .oneshot(
            Request::get("/earn/aave/execution")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(configuration.status(), StatusCode::OK);
    let configuration: Value =
        serde_json::from_slice(&to_bytes(configuration.into_body(), 16_384).await.unwrap())
            .unwrap();
    assert_eq!(configuration["maximumAtokenRoundingRaw"], "2");
    assert!(configuration.get("rpcUrl").is_none());
    assert!(configuration.get("dataKeys").is_none());
    let body =
        json!({"action":"supply","amountRaw":"1000000","maximumNetworkFeeRaw":"1000000000000000"});
    let request = |token: &str, key: &str, body: Value| {
        Request::post("/earn/aave/operations")
            .header("authorization", format!("Bearer {token}"))
            .header("idempotency-key", key)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(request("invalid", "one", body.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let result = app
        .clone()
        .oneshot(request(&f.token, "one", body.clone()))
        .await
        .unwrap();
    assert_eq!(result.status(), StatusCode::ACCEPTED);
    let first: Value =
        serde_json::from_slice(&to_bytes(result.into_body(), 65536).await.unwrap()).unwrap();
    let repeat = app
        .clone()
        .oneshot(request(&f.token, "one", body.clone()))
        .await
        .unwrap();
    let second: Value =
        serde_json::from_slice(&to_bytes(repeat.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(first["operation"]["id"], second["operation"]["id"]);
    let mut changed = body.clone();
    changed["amountRaw"] = json!("1");
    assert_eq!(
        app.clone()
            .oneshot(request(&f.token, "one", changed))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    for bad in [
        json!({"action":"supply","amountRaw":1,"maximumNetworkFeeRaw":"1"}),
        json!({"action":"supply","amountRaw":"1","maximumNetworkFeeRaw":"1","recipient":ADDRESS}),
    ] {
        assert_eq!(
            app.clone()
                .oneshot(request(&f.token, "invalid", bad))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let typed_id = first["operation"]["id"].as_str().unwrap();
    let recovered = app
        .clone()
        .oneshot(
            Request::get(format!("/operations/{typed_id}/aave-intent"))
                .header("authorization", format!("Bearer {}", f.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(recovered.status(), StatusCode::OK);
    let typed: Value =
        serde_json::from_slice(&to_bytes(recovered.into_body(), 16384).await.unwrap()).unwrap();
    assert_eq!(typed["intent"], body);
    assert_eq!(typed["signer"], ADDRESS);
    assert!(typed.get("idempotencyKey").is_none());
    let mut prepared = honey_server::providers::aave_execution::PreparedAave {
        plan: f.plan.clone(),
        first_nonce: "0".into(),
        gas_limits: vec!["21000".into()],
        max_fee_per_gas: "1".into(),
        max_priority_fee_per_gas: "1".into(),
    };
    prepared.plan.chain_id = "31337".into();
    prepared.plan.maximum_network_fee_raw = "21000".into();
    f.store
        .persist_aave_preparation(&f.lease, &prepared)
        .await
        .unwrap();
    let id = f.id.to_string();
    let allowed = app
        .clone()
        .oneshot(
            Request::get(format!("/operations/{id}/signing-request"))
                .header("authorization", format!("Bearer {}", f.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
    let other = setup(&db).await;
    let denied = app
        .clone()
        .oneshot(
            Request::get(format!("/operations/{id}/signing-request"))
                .header("authorization", format!("Bearer {}", other.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    let denied_intent = app
        .oneshot(
            Request::get(format!("/operations/{typed_id}/aave-intent"))
                .header("authorization", format!("Bearer {}", other.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied_intent.status(), StatusCode::NOT_FOUND);

    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn wallet_history_keysets_keep_full_precision_and_exclude_other_wallets() {
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    let mut ids = vec![f.id];
    for n in 0..7 {
        let op = f
            .store
            .create(NewOperation {
                user_id: f.user,
                wallet_id: f.wallet,
                action: Action::Earn,
                idempotency_key: &format!("history-{n}"),
                intent: &json!({"privateIntent":"not in summaries"}),
            })
            .await
            .unwrap();
        ids.push(op.id);
    }
    // Four timestamp ties plus four distinct sub-millisecond times. Display
    // timestamps collide, but pagination must retain the database's precision.
    for (n, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE operations SET created_at='2026-01-01T00:00:00Z'::timestamptz+make_interval(secs=>$2::double precision),updated_at=clock_timestamp() WHERE id=$1").bind(id).bind(if n<4 {0.0}else{n as f64/1_000_000.0}).execute(&db.pool).await.unwrap();
    }
    let other_wallet = Uuid::new_v4();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,2,$3,'eoa')").bind(other_wallet).bind(f.user).bind(vec![0x22u8;20]).execute(&db.pool).await.unwrap();
    let other = f
        .store
        .create(NewOperation {
            user_id: f.user,
            wallet_id: other_wallet,
            action: Action::Earn,
            idempotency_key: "other-wallet",
            intent: &json!({"amount":"1"}),
        })
        .await
        .unwrap();
    let expected:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM operations WHERE user_id=$1 AND wallet_id=$2 ORDER BY created_at DESC,id DESC").bind(f.user).bind(f.wallet).fetch_all(&db.pool).await.unwrap();
    let first = f
        .store
        .list_operations(f.user, f.wallet, None, 2)
        .await
        .unwrap();
    assert_eq!(first.items.len(), 2);
    let mut seen: Vec<_> = first.items.iter().map(|i| i.operation.id).collect();
    let mut cursor = first.next_cursor;
    // A newer insertion and mutable state update must not shift the older pages.
    let newest = f
        .store
        .create(NewOperation {
            user_id: f.user,
            wallet_id: f.wallet,
            action: Action::Earn,
            idempotency_key: "newer",
            intent: &json!({"amount":"1"}),
        })
        .await
        .unwrap();
    sqlx::query("UPDATE operations SET state='failed',version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(expected.last().unwrap()).execute(&db.pool).await.unwrap();
    while let Some(c) = cursor {
        let page = f
            .store
            .list_operations(f.user, f.wallet, Some(c), 2)
            .await
            .unwrap();
        seen.extend(page.items.iter().map(|i| i.operation.id));
        cursor = page.next_cursor;
    }
    assert_eq!(seen, expected);
    assert_eq!(
        f.store
            .list_operations(f.user, f.wallet, None, 1)
            .await
            .unwrap()
            .items[0]
            .operation
            .id,
        newest.id
    );
    assert!(matches!(
        f.store
            .list_operations(f.user, f.wallet, Some(other.id), 2)
            .await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        f.store
            .list_operations(f.user, f.wallet, Some(Uuid::new_v4()), 2)
            .await,
        Err(AppError::NotFound)
    ));
    assert!(
        f.store
            .list_operations(Uuid::new_v4(), f.wallet, None, 20)
            .await
            .unwrap()
            .items
            .is_empty()
    );
    for limit in [0, 51, u16::MAX] {
        assert!(matches!(
            f.store.list_operations(f.user, f.wallet, None, limit).await,
            Err(AppError::BadRequest(_))
        ));
    }
    let serialized = serde_json::to_string(
        &f.store
            .list_operations(f.user, f.wallet, None, 50)
            .await
            .unwrap(),
    )
    .unwrap();
    for excluded in [
        "privateIntent",
        "idempotency",
        "intentHash",
        "signer",
        "signedTransactions",
        "lease",
    ] {
        assert!(!serialized.contains(excluded));
    }
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn history_http_requires_auth_and_rejects_unscoped_or_malformed_cursors() {
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    let app = honey_server::routes::operations::router(
        Some(
            honey_server::identity::Identity::new(
                db.pool.clone(),
                AuthConfig {
                    origin: "http://localhost:5173".into(),
                    additional_origins: vec![],
                    chain_id: 1,
                },
            )
            .unwrap(),
        ),
        Some(f.store.clone()),
    );
    let request = |path: &str, token: &str| {
        Request::get(path)
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(request("/operations", "invalid"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    for query in [
        "limit=0",
        "limit=51",
        "limit=-1",
        "limit=1&limit=2",
        "cursor=invalid",
        "user_id=override",
    ] {
        assert_eq!(
            app.clone()
                .oneshot(request(&format!("/operations?{query}"), &f.token))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let response = app
        .clone()
        .oneshot(request("/operations?limit=1", &f.token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap()).unwrap();
    assert_eq!(body["items"][0]["operation"]["id"], f.id.to_string());
    assert_eq!(body["nextCursor"], Value::Null);
    let other_wallet = Uuid::new_v4();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,2,$3,'eoa')").bind(other_wallet).bind(f.user).bind(vec![0x33u8;20]).execute(&db.pool).await.unwrap();
    let other = f
        .store
        .create(NewOperation {
            user_id: f.user,
            wallet_id: other_wallet,
            action: Action::Earn,
            idempotency_key: "other-wallet",
            intent: &json!({"amount":"1"}),
        })
        .await
        .unwrap();
    assert_eq!(
        app.oneshot(request(
            &format!("/operations?cursor={}", other.id),
            &f.token
        ))
        .await
        .unwrap()
        .status(),
        StatusCode::NOT_FOUND
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn deep_history_page_uses_wallet_index_on_a_large_fixture() {
    let db = TestDatabase::new().await;
    let f = setup(&db).await;
    // Local database fixture only; no provider work is scheduled for these rows.
    sqlx::query("INSERT INTO operations(id,user_id,wallet_id,action,idempotency_key,intent_hash,created_at) SELECT gen_random_uuid(),$1,$2,'earn','scale-'||n,decode(repeat('aa',32),'hex'),'2026-01-01'::timestamptz+make_interval(secs=>n::double precision) FROM generate_series(1,100000) n").bind(f.user).bind(f.wallet).execute(&db.pool).await.unwrap();
    let other_wallet = Uuid::new_v4();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,2,$3,'eoa')").bind(other_wallet).bind(f.user).bind(vec![0x33u8;20]).execute(&db.pool).await.unwrap();
    sqlx::query("UPDATE operations SET wallet_id=$2 WHERE user_id=$1 AND idempotency_key LIKE 'scale-%' AND split_part(idempotency_key,'-',2)::integer % 100 <> 0").bind(f.user).bind(other_wallet).execute(&db.pool).await.unwrap();
    sqlx::query("ANALYZE operations")
        .execute(&db.pool)
        .await
        .unwrap();
    let anchor:(Uuid,time::OffsetDateTime)=sqlx::query_as("SELECT id,created_at FROM operations WHERE user_id=$1 AND wallet_id=$2 ORDER BY created_at DESC,id DESC OFFSET 900 LIMIT 1").bind(f.user).bind(f.wallet).fetch_one(&db.pool).await.unwrap();
    let explain:Value=sqlx::query_scalar("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,wallet_id,action,state,version FROM operations WHERE user_id=$1 AND wallet_id=$2 AND (created_at,id)<($3,$4) ORDER BY created_at DESC,id DESC LIMIT 11").bind(f.user).bind(f.wallet).bind(anchor.1).bind(anchor.0).fetch_one(&db.pool).await.unwrap();
    assert!(
        explain.to_string().contains("operations_wallet_page"),
        "{explain}"
    );
    assert_eq!(explain[0]["Plan"]["Actual Rows"], 11);
    println!(
        "HISTORY_QUERY_EVIDENCE: {}",
        json!({"scope":"disposable PostgreSQL; 100001 operation rows across two wallets; one principal; warm local query; not concurrent user capacity","selectedWalletRows":1001,"pageDepth":900,"limitWithLookahead":11,"explain":explain})
    );
    let page = f
        .store
        .list_operations(f.user, f.wallet, Some(anchor.0), 10)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 10);
    assert!(page.next_cursor.is_some());
    db.close().await;
}
