//! Disposable PostgreSQL only. Financial execution is separately verified by the
//! actual-contract harness; these tests exercise storage/ownership/crash boundaries.
mod common;
use common::TestDatabase;
use honey_server::{
    error::AppError,
    evm_envelope::{EvmEnvelopePolicy, verify_signed_bundle},
    preparation::{PreparationProvider, calls_hash},
    providers::evm_prepare::PreparedEvm,
    submissions::{NonceObservation, StageSubmission, SubmissionKeys},
    work::{Action, JobLease, NewOperation, OperationState, Topic, WorkStore},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;
use zeroize::Zeroizing;

fn now() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
fn source() -> Value {
    serde_json::from_str(include_str!("fixtures/sealed-swap-viem.json")).unwrap()
}
fn keys(id: &str, byte: u8) -> SubmissionKeys {
    SubmissionKeys::new(id.into(), [(id.into(), Zeroizing::new([byte; 32]))].into()).unwrap()
}
struct Fixture {
    store: WorkStore,
    user: Uuid,
    wallet: Uuid,
    id: Uuid,
    lease: JobLease,
    prepared: PreparedEvm,
}
async fn setup(db: &TestDatabase, previous: Option<&Fixture>) -> Fixture {
    let user = previous.map_or_else(Uuid::new_v4, |f| f.user);
    let wallet = previous.map_or_else(Uuid::new_v4, |f| f.wallet);
    let mut prepared: PreparedEvm = previous.map_or_else(
        || serde_json::from_value(source()["prepared"].clone()).unwrap(),
        |f| f.prepared.clone(),
    );
    if previous.is_none() {
        sqlx::query("INSERT INTO users(id) VALUES ($1)")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,31337,$3,'eoa')")
            .bind(wallet).bind(user).bind(hex::decode(&prepared.plan.signer[2..]).unwrap()).execute(&db.pool).await.unwrap();
        // Refresh storage clock fields only. Fixture transaction/permit bytes are
        // fixed; this is not a fresh provider validation or execution admission.
        prepared.plan.simulation.observed_at_ms = now() - 1;
        prepared.plan.expires_at_ms = now() + 120000;
    }
    let store = WorkStore::new(db.pool.clone());
    let op = store
        .create(NewOperation {
            user_id: user,
            wallet_id: wallet,
            action: Action::Swap,
            idempotency_key: &Uuid::new_v4().to_string(),
            intent: &json!({"provider":"uniswap","amountRaw":"1000"}),
        })
        .await
        .unwrap();
    prepared.plan.intent_hash =
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
    assert_eq!(lease.operation_id, op.id);
    Fixture {
        store,
        user,
        wallet,
        id: op.id,
        lease,
        prepared,
    }
}
async fn persist(f: &Fixture, key: &SubmissionKeys) {
    f.store
        .persist_sealed_swap_preparation(key, &f.lease, &f.prepared)
        .await
        .unwrap();
}
async fn open(f: &Fixture, key: &SubmissionKeys) -> Result<PreparedEvm, AppError> {
    f.store
        .load_sealed_swap_preparation(key, f.user, f.wallet, f.id)
        .await
}

#[test]
fn calldata_debug_is_redacted_and_provider_size_bounds_remain_distinct() {
    let mut p: PreparedEvm = serde_json::from_value(source()["prepared"].clone()).unwrap();
    p.validate_signing_terms().unwrap();
    let debug = format!("{:?}", p.plan);
    assert!(!debug.contains(source()["signature"].as_str().unwrap()));
    assert!(!debug.contains(&p.plan.steps[0].data));
    assert!(debug.contains("[redacted]"));
    // Storage/envelope bounds only; arbitrary bytes are not a valid router route.
    p.plan.steps[0].data = format!("0x{}", "ab".repeat(65536));
    p.plan.simulation.calls_hash = calls_hash(&p.plan.steps).unwrap();
    p.validate_signing_terms().unwrap();
    p.plan.provider = PreparationProvider::AaveV3;
    assert!(p.validate_signing_terms().is_err());
    p.plan.provider = PreparationProvider::Uniswap;
    p.plan.steps[0].data.push_str("00");
    p.plan.simulation.calls_hash = calls_hash(&p.plan.steps).unwrap();
    assert!(p.validate_signing_terms().is_err());
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn encrypted_swap_survives_restart_rotation_submission_and_dispatch() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("old", 1);
    assert!(
        f.store
            .persist_preparation(&f.lease, &f.prepared.plan)
            .await
            .is_err()
    );
    assert!(
        f.store
            .persist_evm_preparation(&f.lease, &f.prepared)
            .await
            .is_err()
    );
    let (a, b) = tokio::join!(
        f.store
            .persist_sealed_swap_preparation(&key, &f.lease, &f.prepared),
        f.store
            .persist_sealed_swap_preparation(&key, &f.lease, &f.prepared),
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let row = sqlx::query("SELECT canonical_json,public_json,ciphertext FROM operation_preparations WHERE operation_id=$1")
        .bind(f.id).fetch_one(&db.pool).await.unwrap();
    assert!(row.get::<Option<String>, _>("canonical_json").is_none());
    let public: String = row.get("public_json");
    let signature = source()["signature"].as_str().unwrap().to_owned();
    for forbidden in [
        &signature,
        &f.prepared.plan.steps[0].data,
        "sigDeadline",
        "gasLimits",
    ] {
        assert!(!public.contains(forbidden));
    }
    let cipher: Vec<u8> = row.get("ciphertext");
    assert!(
        !cipher
            .windows(signature.len())
            .any(|v| v == signature.as_bytes())
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM evm_signing_requests")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    assert!(
        f.store
            .load_preparation(f.user, f.wallet, f.id)
            .await
            .is_err()
    );
    for (user, wallet) in [(Uuid::new_v4(), f.wallet), (f.user, Uuid::new_v4())] {
        assert!(matches!(
            f.store
                .load_sealed_swap_preparation(&key, user, wallet, f.id)
                .await,
            Err(AppError::NotFound)
        ));
    }
    assert!(matches!(
        open(&f, &keys("missing", 1)).await,
        Err(AppError::Busy)
    ));
    assert!(matches!(
        open(&f, &keys("old", 2)).await,
        Err(AppError::Busy)
    ));
    let rotated = SubmissionKeys::new(
        "new".into(),
        [
            ("old".into(), Zeroizing::new([1; 32])),
            ("new".into(), Zeroizing::new([2; 32])),
        ]
        .into(),
    )
    .unwrap();
    let restarted = WorkStore::new(db.pool.clone());
    let loaded = restarted
        .load_sealed_swap_preparation(&rotated, f.user, f.wallet, f.id)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&loaded).unwrap(),
        serde_json::to_value(&f.prepared).unwrap()
    );
    let recovered = restarted.recover(f.user, f.wallet, f.id).await.unwrap();
    assert_eq!(recovered.operation.state, OperationState::AwaitingSignature);
    assert!(
        !serde_json::to_string(&recovered)
            .unwrap()
            .contains(&signature)
    );
    assert!(!recovered.execution_available);
    for (name, variant) in source()["variants"].as_object().unwrap() {
        let nonce = if name == "changedNonce" { 8 } else { 7 };
        // These are valid EOA envelopes within the overall fee cap; exact persisted
        // signing terms must reject them before any nonce guard or ciphertext write.
        let altered = verify_signed_bundle(
            &loaded.plan,
            EvmEnvelopePolicy {
                first_nonce: nonce,
                maximum_gas_per_transaction: 500000,
            },
            &[variant.as_str().unwrap().to_owned()],
            now(),
        )
        .unwrap();
        assert!(
            restarted
                .stage_signed(
                    &rotated,
                    StageSubmission {
                        user: f.user,
                        wallet: f.wallet,
                        operation: f.id,
                        expected_version: 1,
                        bundle: &altered,
                        nonce: NonceObservation {
                            nonce,
                            observed_at_ms: now()
                        },
                    }
                )
                .await
                .is_err()
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM evm_submissions")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    let raw = vec![source()["signed"].as_str().unwrap().to_owned()];
    let bundle = verify_signed_bundle(
        &loaded.plan,
        EvmEnvelopePolicy {
            first_nonce: 7,
            maximum_gas_per_transaction: 500000,
        },
        &raw,
        now(),
    )
    .unwrap();
    let submit = || StageSubmission {
        user: f.user,
        wallet: f.wallet,
        operation: f.id,
        expected_version: 1,
        bundle: &bundle,
        nonce: NonceObservation {
            nonce: 7,
            observed_at_ms: now(),
        },
    };
    let a = restarted.stage_signed(&rotated, submit()).await.unwrap();
    let b = restarted.stage_signed(&rotated, submit()).await.unwrap();
    assert_eq!(a, b);
    assert_eq!(
        a.transaction_hashes,
        vec![source()["transactionHash"].as_str().unwrap()]
    );
    restarted
        .reconciliation_context(&rotated, f.id)
        .await
        .unwrap();
    let lease = restarted
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    let attempt = restarted
        .begin_initial_dispatch(
            &rotated,
            &lease,
            NonceObservation {
                nonce: 7,
                observed_at_ms: now(),
            },
        )
        .await
        .unwrap();
    assert_eq!(attempt.transaction_hash(), a.transaction_hashes[0]);
    assert_eq!(
        attempt.expose_signed_bytes(),
        hex::decode(&raw[0][2..]).unwrap()
    );
    assert_eq!(
        restarted
            .recover(f.user, f.wallet, f.id)
            .await
            .unwrap()
            .operation
            .state,
        OperationState::Unknown
    );
    assert!(
        restarted
            .begin_initial_dispatch(
                &rotated,
                &lease,
                NonceObservation {
                    nonce: 7,
                    observed_at_ms: now()
                }
            )
            .await
            .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM evm_wallet_guards")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    // No RPC send occurs: the durable ambiguous state and guard are intentional.
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn immutable_ciphertext_cannot_be_transplanted_between_identical_operations() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("old", 1);
    persist(&f, &key).await;
    let other = setup(&db, Some(&f)).await;
    persist(&other, &key).await;
    assert_eq!(
        f.prepared.plan.integrity_hash().unwrap(),
        other.prepared.plan.integrity_hash().unwrap()
    );
    // Normal application mutation is forbidden by the evidence trigger.
    assert!(
        sqlx::query("UPDATE operation_preparations SET key_id='new' WHERE operation_id=$1")
            .bind(f.id)
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM operation_preparations WHERE operation_id=$1")
            .bind(f.id)
            .execute(&db.pool)
            .await
            .is_err()
    );
    // Privileged corruption in this isolated database tests AEAD, not SQL permissions.
    sqlx::query(
        "ALTER TABLE operation_preparations DISABLE TRIGGER immutable_operation_preparation",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE operation_preparations target SET ciphertext=source.ciphertext,encryption_nonce=source.encryption_nonce FROM operation_preparations source WHERE target.operation_id=$1 AND source.operation_id=$2")
        .bind(other.id).bind(f.id).execute(&db.pool).await.unwrap();
    assert!(matches!(open(&other, &key).await, Err(AppError::Busy)));
    open(&f, &key).await.unwrap();
    sqlx::query("UPDATE operation_preparations SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE operation_id=$1")
        .bind(f.id).execute(&db.pool).await.unwrap();
    assert!(matches!(open(&f, &key).await, Err(AppError::Busy)));
    // Public discovery remains possible without decrypting, but cannot authorize execution.
    assert!(
        !f.store
            .recover(f.user, f.wallet, f.id)
            .await
            .unwrap()
            .execution_available
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn sealed_preparation_and_successor_job_roll_back_together() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    sqlx::raw_sql("CREATE FUNCTION fail_swap_successor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.topic='operation.changed' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER fail_swap_successor BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION fail_swap_successor();")
        .execute(&db.pool).await.unwrap();
    assert!(
        f.store
            .persist_sealed_swap_preparation(&keys("key", 1), &f.lease, &f.prepared)
            .await
            .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM operation_preparations")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        f.store.get(f.user, f.wallet, f.id).await.unwrap().state,
        OperationState::Created
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM jobs WHERE id=$1")
            .bind(f.lease.id)
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "leased"
    );
    sqlx::query("DROP TRIGGER fail_swap_successor ON jobs")
        .execute(&db.pool)
        .await
        .unwrap();
    persist(&f, &keys("key", 1)).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM jobs WHERE topic='operation.changed'")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn metadata_and_key_identifiers_are_authenticated_even_when_checksums_match() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key", 1);
    persist(&f, &key).await;
    let original: String =
        sqlx::query_scalar("SELECT public_json FROM operation_preparations WHERE operation_id=$1")
            .bind(f.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let mut public: Value = serde_json::from_str(&original).unwrap();
    public["preparation"]["feePolicyRevision"] = json!("forged-but-well-formed");
    let forged = public.to_string();
    sqlx::query(
        "ALTER TABLE operation_preparations DISABLE TRIGGER immutable_operation_preparation",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE operation_preparations SET public_json=$2,public_hash=$3 WHERE operation_id=$1",
    )
    .bind(f.id)
    .bind(&forged)
    .bind(Sha256::digest(forged.as_bytes()).to_vec())
    .execute(&db.pool)
    .await
    .unwrap();
    // Keyless metadata recovery is checksummed only, and stays execution-disabled.
    assert!(
        !f.store
            .recover(f.user, f.wallet, f.id)
            .await
            .unwrap()
            .execution_available
    );
    assert!(matches!(open(&f, &key).await, Err(AppError::Busy)));
    sqlx::query("UPDATE operation_preparations SET public_json=$2,public_hash=$3,key_id='alias' WHERE operation_id=$1")
        .bind(f.id).bind(&original).bind(Sha256::digest(original.as_bytes()).to_vec()).execute(&db.pool).await.unwrap();
    // Same encryption bytes under a different key identifier still violate the AAD.
    assert!(matches!(
        open(&f, &keys("alias", 1)).await,
        Err(AppError::Busy)
    ));
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn large_swap_calldata_is_sealed_and_expiry_remains_historical_only() {
    let db = TestDatabase::new().await;
    let mut f = setup(&db, None).await;
    f.prepared.plan.steps[0].data = format!("0x{}", "ab".repeat(65536));
    f.prepared.plan.simulation.calls_hash = calls_hash(&f.prepared.plan.steps).unwrap();
    f.prepared.plan.expires_at_ms = now() + 1500;
    let key = keys("key", 1);
    persist(&f, &key).await;
    assert_eq!(
        open(&f, &key).await.unwrap().plan.steps[0].data,
        f.prepared.plan.steps[0].data
    );
    tokio::time::sleep(std::time::Duration::from_millis(1550)).await;
    let recovery = f.store.recover(f.user, f.wallet, f.id).await.unwrap();
    assert!(recovery.preparation.unwrap().expired);
    assert!(!recovery.execution_available);
    assert_eq!(
        open(&f, &key).await.unwrap().plan.expires_at_ms,
        f.prepared.plan.expires_at_ms
    );
    // Reads do not renew an expired authorization or overwrite immutable evidence.
    assert!(
        f.store
            .persist_sealed_swap_preparation(&key, &f.lease, &f.prepared)
            .await
            .is_err()
    );
    db.close().await;
}

#[test]
fn swap_envelope_accepts_full_router_bound_and_other_providers_keep_the_old_bound() {
    use alloy_consensus::{SignableTransaction, TxEnvelope, transaction::SignerRecoverable};
    use alloy_eips::eip2718::{Decodable2718, Encodable2718};
    let source = source();
    let raw = hex::decode(&source["signed"].as_str().unwrap()[2..]).unwrap();
    let TxEnvelope::Eip1559(original) = TxEnvelope::decode_2718_exact(&raw).unwrap() else {
        panic!("fixture type")
    };
    let (mut tx, signature, _) = original.into_parts();
    // For this size-bound test, recover the signer of the changed message under
    // the fixture's valid (r,s) pair. It is not a claim of wallet ownership or a
    // financially authorized route and is never persisted or sent.
    tx.input = vec![0xab; 65536].into();
    tx.gas_limit = 2_000_000;
    let envelope = TxEnvelope::Eip1559(tx.into_signed(signature));
    let mut prepared: PreparedEvm = serde_json::from_value(source["prepared"].clone()).unwrap();
    prepared.plan.signer = format!(
        "{:#x}",
        SignerRecoverable::recover_signer(&envelope).unwrap()
    );
    prepared.plan.steps[0].data = format!("0x{}", "ab".repeat(65536));
    prepared.plan.simulation.calls_hash = calls_hash(&prepared.plan.steps).unwrap();
    prepared.plan.maximum_network_fee_raw = "4000000000000000".into();
    let signed = vec![format!("0x{}", hex::encode(envelope.encoded_2718()))];
    let policy = EvmEnvelopePolicy {
        first_nonce: 7,
        maximum_gas_per_transaction: 2_000_000,
    };
    verify_signed_bundle(
        &prepared.plan,
        policy,
        &signed,
        prepared.plan.simulation.observed_at_ms,
    )
    .unwrap();
    prepared.plan.provider = PreparationProvider::AaveV3;
    assert!(
        verify_signed_bundle(
            &prepared.plan,
            policy,
            &signed,
            prepared.plan.simulation.observed_at_ms
        )
        .is_err()
    );
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn authenticated_http_recovery_never_reads_the_encrypted_signing_payload() {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use honey_server::{config::AuthConfig, identity::Identity};
    use tower::ServiceExt;
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    persist(&f, &keys("key", 1)).await;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,wallet_id,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '15 minutes')")
        .bind(Sha256::digest(token.as_bytes()).to_vec()).bind(f.user).bind(f.wallet).execute(&db.pool).await.unwrap();
    let app = honey_server::routes::operations::router(
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
        Some(f.store.clone()),
    );
    let request = |token: &str| {
        Request::get(format!("/operations/{}", f.id))
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(request("invalid"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = app.oneshot(request(&token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 8192).await.unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["preparation"]["provider"], "uniswap");
    assert_eq!(value["executionAvailable"], false);
    let text = String::from_utf8(body.to_vec()).unwrap();
    for forbidden in [
        "ciphertext",
        "keyId",
        "gasLimits",
        "sigDeadline",
        source()["signature"].as_str().unwrap(),
    ] {
        assert!(!text.contains(forbidden));
    }
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn additive_migration_preserves_existing_plaintext_earn_evidence() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    // Reconstruct the v7 preparation schema in this owned database only.
    sqlx::raw_sql("ALTER TABLE operation_preparations DROP CONSTRAINT preparation_storage_shape;
        ALTER TABLE operation_preparations DROP COLUMN public_json,DROP COLUMN public_hash,
        DROP COLUMN request_hash,DROP COLUMN key_id,DROP COLUMN encryption_nonce,DROP COLUMN ciphertext;
        ALTER TABLE operation_preparations ALTER COLUMN canonical_json SET NOT NULL;
        ALTER TABLE evm_signed_transactions DROP CONSTRAINT evm_signed_transactions_ciphertext_check;
        ALTER TABLE evm_signed_transactions ADD CONSTRAINT evm_signed_transactions_ciphertext_check CHECK(octet_length(ciphertext) BETWEEN 17 AND 8208);")
        .execute(&db.pool).await.unwrap();
    let operation = f
        .store
        .create(NewOperation {
            user_id: f.user,
            wallet_id: f.wallet,
            action: Action::Earn,
            idempotency_key: "legacy-earn",
            intent: &json!({"provider":"aave_v3","amountRaw":"1000"}),
        })
        .await
        .unwrap();
    let mut legacy = f.prepared.clone();
    legacy.plan.provider = PreparationProvider::AaveV3;
    legacy.plan.quote_reference = None;
    legacy.plan.steps[0].data = "0x1234".into();
    legacy.plan.simulation.calls_hash = calls_hash(&legacy.plan.steps).unwrap();
    legacy.plan.intent_hash =
        sqlx::query_scalar("SELECT encode(intent_hash,'hex') FROM operations WHERE id=$1")
            .bind(operation.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let lease = f
        .store
        .claim(Topic::OperationCreated, 30)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.operation_id, operation.id);
    f.store
        .persist_evm_preparation(&lease, &legacy)
        .await
        .unwrap();
    let before:(String,Vec<u8>,String,Vec<u8>) = sqlx::query_as("SELECT p.canonical_json,p.plan_hash,s.canonical_json,s.request_hash FROM operation_preparations p JOIN evm_signing_requests s USING(operation_id) WHERE operation_id=$1")
        .bind(operation.id).fetch_one(&db.pool).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/202610180008_sealed_preparations.sql"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    let after:(String,Vec<u8>,String,Vec<u8>) = sqlx::query_as("SELECT p.canonical_json,p.plan_hash,s.canonical_json,s.request_hash FROM operation_preparations p JOIN evm_signing_requests s USING(operation_id) WHERE operation_id=$1")
        .bind(operation.id).fetch_one(&db.pool).await.unwrap();
    assert_eq!(before, after);
    let loaded = f
        .store
        .load_preparation_with_keys(&keys("key", 1), f.user, f.wallet, operation.id)
        .await
        .unwrap();
    assert_eq!(
        loaded.integrity_hash().unwrap(),
        legacy.plan.integrity_hash().unwrap()
    );
    db.close().await;
}
