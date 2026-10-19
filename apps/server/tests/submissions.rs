//! Only unique databases in the explicitly configured disposable test service.
mod common;
use common::TestDatabase;
use honey_server::{
    evm_envelope::{EvmEnvelopePolicy, VerifiedEvmBundle, verify_signed_bundle},
    preparation::EvmPreparation,
    submissions::{DispatchObservation, NonceObservation, StageSubmission, SubmissionKeys},
    work::{Action, NewOperation, OperationState, Topic, WorkStore},
};
use serde_json::{Value, json};
use uuid::Uuid;
use zeroize::Zeroizing;
fn now() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
fn keys(id: &str, n: u8) -> SubmissionKeys {
    SubmissionKeys::new(id.into(), [(id.into(), Zeroizing::new([n; 32]))].into()).unwrap()
}
struct Fixture {
    store: WorkStore,
    user: Uuid,
    wallet: Uuid,
    operation: Uuid,
    bundle: VerifiedEvmBundle,
    raw: Vec<String>,
}
impl Fixture {
    fn input(&self) -> StageSubmission<'_> {
        StageSubmission {
            user: self.user,
            wallet: self.wallet,
            operation: self.operation,
            expected_version: 1,
            bundle: &self.bundle,
            nonce: NonceObservation {
                nonce: 7,
                observed_at_ms: now(),
            },
        }
    }
}
async fn setup(db: &TestDatabase, existing: Option<(Uuid, Uuid)>) -> Fixture {
    let source: Value =
        serde_json::from_str(include_str!("fixtures/evm-envelopes-viem.json")).unwrap();
    let user = existing.map_or_else(Uuid::new_v4, |v| v.0);
    let wallet = existing.map_or_else(Uuid::new_v4, |v| v.1);
    let mut plan: EvmPreparation = serde_json::from_value(source["plan"].clone()).unwrap();
    if existing.is_none() {
        sqlx::query("INSERT INTO users(id) VALUES ($1)")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,31337,$3,'eoa')")
            .bind(wallet).bind(user).bind(hex::decode(&plan.signer[2..]).unwrap()).execute(&db.pool).await.unwrap();
    }
    let store = WorkStore::new(db.pool.clone());
    let op = store
        .create(NewOperation {
            user_id: user,
            wallet_id: wallet,
            action: Action::Earn,
            idempotency_key: &Uuid::new_v4().to_string(),
            intent: &json!({"amountRaw":"9007199254740993"}),
        })
        .await
        .unwrap();
    plan.intent_hash =
        sqlx::query_scalar("SELECT encode(intent_hash,'hex') FROM operations WHERE id=$1")
            .bind(op.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    plan.simulation.observed_at_ms = now() - 1;
    plan.expires_at_ms = now() + 120000;
    let lease = store
        .claim(Topic::OperationCreated, 30)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.operation_id, op.id);
    store.persist_preparation(&lease, &plan).await.unwrap();
    let raw: Vec<String> = serde_json::from_value(source["signed"].clone()).unwrap();
    let bundle = verify_signed_bundle(
        &plan,
        EvmEnvelopePolicy {
            first_nonce: 7,
            maximum_gas_per_transaction: 500000,
        },
        &raw,
        now(),
    )
    .unwrap();
    Fixture {
        store,
        user,
        wallet,
        operation: op.id,
        bundle,
        raw,
    }
}
async fn counts(db: &TestDatabase) -> (i64, i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM evm_submissions),(SELECT count(*) FROM evm_signed_transactions),(SELECT count(*) FROM evm_wallet_guards),(SELECT count(*) FROM evm_dispatch_attempts)").fetch_one(&db.pool).await.unwrap()
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn concurrent_signed_acceptance_is_atomic_encrypted_idempotent_and_restart_safe() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key1", 1);
    let (a, b) = tokio::join!(
        f.store.stage_signed(&key, f.input()),
        f.store.stage_signed(&key, f.input())
    );
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(counts(&db).await, (1, 2, 1, 0));
    let recovered = f
        .store
        .recover(f.user, f.wallet, f.operation)
        .await
        .unwrap();
    assert_eq!(
        recovered.submission.unwrap().transaction_hashes,
        f.bundle
            .transactions()
            .iter()
            .map(|t| format!("{:#x}", t.hash()))
            .collect::<Vec<_>>()
    );
    assert!(
        f.store
            .recover(Uuid::new_v4(), f.wallet, f.operation)
            .await
            .is_err()
    );
    let cipher: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT ciphertext FROM evm_signed_transactions ORDER BY step")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    for (c, raw) in cipher.iter().zip(&f.raw) {
        assert_ne!(c, &hex::decode(&raw[2..]).unwrap());
    }
    let store = WorkStore::new(db.pool.clone());
    assert_eq!(
        store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .state,
        OperationState::Signed
    );
    let lease = store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.operation_version, 2);
    // Rotate active writer, retain old decrypt key. Restart must recover old bytes.
    let rotated = SubmissionKeys::new(
        "key2".into(),
        [
            ("key1".into(), Zeroizing::new([1; 32])),
            ("key2".into(), Zeroizing::new([2; 32])),
        ]
        .into(),
    )
    .unwrap();
    let attempt = store
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
    assert_eq!(
        attempt.expose_signed_bytes(),
        hex::decode(&f.raw[0][2..]).unwrap()
    );
    assert_eq!(
        attempt.transaction_hash(),
        format!("{:#x}", f.bundle.transactions()[0].hash())
    );
    assert_eq!(
        store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .state,
        OperationState::Unknown
    );
    store
        .observe_dispatch(&attempt, DispatchObservation::Acknowledged)
        .await
        .unwrap();
    store
        .observe_dispatch(&attempt, DispatchObservation::Acknowledged)
        .await
        .unwrap();
    assert!(
        store
            .observe_dispatch(&attempt, DispatchObservation::Unknown)
            .await
            .is_err()
    );
    // RPC acknowledgement must never assert successful inclusion or release guard.
    assert_eq!(
        store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .state,
        OperationState::Unknown
    );
    assert!(!store.complete(&lease).await.unwrap());
    let reconcile = store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    assert!(
        store
            .begin_initial_dispatch(
                &key,
                &reconcile,
                NonceObservation {
                    nonce: 7,
                    observed_at_ms: now()
                }
            )
            .await
            .is_err()
    );
    assert_eq!(counts(&db).await, (1, 2, 1, 1));
    // The original request can recover idempotently even after the state advances.
    store
        .stage_signed(&keys("unrelated", 3), f.input())
        .await
        .unwrap();
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn wallet_nonce_guard_rejects_overlapping_operation_and_does_not_expire() {
    let db = TestDatabase::new().await;
    let a = setup(&db, None).await;
    let b = setup(&db, Some((a.user, a.wallet))).await;
    let key = keys("key1", 1);
    let (one, two) = tokio::join!(
        a.store.stage_signed(&key, a.input()),
        b.store.stage_signed(&key, b.input())
    );
    assert_eq!(usize::from(one.is_ok()) + usize::from(two.is_ok()), 1);
    assert_eq!(counts(&db).await, (1, 2, 1, 0));
    let states: Vec<String> = sqlx::query_scalar("SELECT state FROM operations ORDER BY state")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(states, vec!["awaiting_signature", "signed"]);
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn stale_nonce_wrong_owner_and_failed_commit_leave_no_signed_state() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key1", 1);
    let mut input = f.input();
    input.nonce.observed_at_ms = now() - 10001;
    assert!(f.store.stage_signed(&key, input).await.is_err());
    let mut input = f.input();
    input.nonce.nonce = 8;
    assert!(f.store.stage_signed(&key, input).await.is_err());
    let mut input = f.input();
    input.user = Uuid::new_v4();
    assert!(f.store.stage_signed(&key, input).await.is_err());
    // Force the successor outbox write to fail after encryption and inserts.
    sqlx::query("CREATE FUNCTION reject_signed_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_version=2 THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$").execute(&db.pool).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_signed_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_signed_job()").execute(&db.pool).await.unwrap();
    assert!(f.store.stage_signed(&key, f.input()).await.is_err());
    assert_eq!(counts(&db).await, (0, 0, 0, 0));
    assert_eq!(
        f.store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .version,
        "1"
    );
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn missing_or_wrong_key_and_expired_lease_never_create_dispatch_intent() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key1", 1);
    f.store.stage_signed(&key, f.input()).await.unwrap();
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    for bad in [keys("wrong-id", 1), keys("key1", 2)] {
        assert!(
            f.store
                .begin_initial_dispatch(
                    &bad,
                    &lease,
                    NonceObservation {
                        nonce: 7,
                        observed_at_ms: now()
                    }
                )
                .await
                .is_err()
        );
    }
    assert_eq!(counts(&db).await, (1, 2, 1, 0));
    sqlx::query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(lease.id)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(
        f.store
            .begin_initial_dispatch(
                &key,
                &lease,
                NonceObservation {
                    nonce: 7,
                    observed_at_ms: now()
                }
            )
            .await
            .is_err()
    );
    assert_eq!(counts(&db).await, (1, 2, 1, 0));
    // Evidence cannot be edited by ordinary writes.
    assert!(
        sqlx::query("UPDATE evm_signed_transactions SET key_id='other'")
            .execute(&db.pool)
            .await
            .is_err()
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn dispatch_lock_wait_expiry_rolls_back_intent_and_fences_old_worker() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key1", 1);
    f.store.stage_signed(&key, f.input()).await.unwrap();
    let lease = f
        .store
        .claim(Topic::OperationChanged, 1)
        .await
        .unwrap()
        .unwrap();
    let mut blocker = db.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM operations WHERE id=$1 FOR UPDATE")
        .bind(f.operation)
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let worker = f.store.begin_initial_dispatch(
        &key,
        &lease,
        NonceObservation {
            nonce: 7,
            observed_at_ms: now(),
        },
    );
    let release = async {
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        blocker.commit().await.unwrap();
    };
    let (result, ()) = tokio::join!(worker, release);
    assert!(result.is_err());
    assert_eq!(counts(&db).await, (1, 2, 1, 0));
    assert_eq!(
        f.store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .state,
        OperationState::Signed
    );
    let next = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(next.token, lease.token);
    assert!(
        f.store
            .begin_initial_dispatch(
                &key,
                &lease,
                NonceObservation {
                    nonce: 7,
                    observed_at_ms: now()
                }
            )
            .await
            .is_err()
    );
    f.store
        .begin_initial_dispatch(
            &key,
            &next,
            NonceObservation {
                nonce: 7,
                observed_at_ms: now(),
            },
        )
        .await
        .unwrap();
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn dispatch_outbox_failure_cannot_return_broadcastable_bytes() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key1", 1);
    f.store.stage_signed(&key, f.input()).await.unwrap();
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    sqlx::query("CREATE FUNCTION reject_dispatch_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_version=3 THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$").execute(&db.pool).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_dispatch_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_dispatch_job()").execute(&db.pool).await.unwrap();
    assert!(
        f.store
            .begin_initial_dispatch(
                &key,
                &lease,
                NonceObservation {
                    nonce: 7,
                    observed_at_ms: now()
                }
            )
            .await
            .is_err()
    );
    assert_eq!(counts(&db).await, (1, 2, 1, 0));
    assert_eq!(
        f.store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .state,
        OperationState::Signed
    );
    db.close().await;
}

#[derive(Clone)]
struct ReceiptFixture {
    mode: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    hashes: Vec<String>,
    sender: String,
    recipients: Vec<String>,
}
fn block_hash(number: u64) -> String {
    format!("0x{}", format!("{:02x}", number as u8).repeat(32))
}
async fn receipt_rpc(
    axum::extract::State(f): axum::extract::State<ReceiptFixture>,
    axum::Json(v): axum::Json<Value>,
) -> axum::Json<Value> {
    use std::sync::atomic::Ordering;
    let mode = f.mode.load(Ordering::Relaxed);
    let h = |number: u64| {
        if (mode == 12 || mode == 22) && number == 90 {
            block_hash(91)
        } else {
            block_hash(number)
        }
    };
    let result = match v["method"].as_str().unwrap() {
        "eth_chainId" => json!("0x7a69"),
        "eth_getBlockByNumber" => {
            let tag = v["params"][0].as_str().unwrap();
            let number = match tag {
                "latest" => 101,
                "finalized" => match mode {
                    3 | 6 | 22 => 100,
                    24..=26 => 99,
                    11 => 89,
                    _ => 90,
                },
                _ => u64::from_str_radix(&tag[2..], 16).unwrap(),
            };
            let transactions = if number == 99 {
                vec![f.hashes[0].clone()]
            } else if number == 100 {
                vec![f.hashes[1].clone()]
            } else {
                vec![]
            };
            json!({"number":format!("0x{number:x}"),"hash":h(number),"baseFeePerGas":"0x0","timestamp":format!("0x{:x}",now()/1000),"transactions":transactions})
        }
        "eth_getTransactionReceipt" => {
            let hash = v["params"][0].as_str().unwrap();
            let step = f.hashes.iter().position(|h| h == hash).unwrap();
            if mode == 0 || mode == 4 || mode == 25 || (step == 1 && ![2, 3, 6].contains(&mode)) {
                Value::Null
            } else {
                let number = 99 + step as u64;
                json!({"transactionHash":if mode==7 {block_hash(1)}else{hash.into()},"from":f.sender,"to":f.recipients[step],"type":"0x2","contractAddress":null,
                    "blockNumber":format!("0x{number:x}"),"blockHash":if mode==8 {block_hash(1)}else{h(number)},
                    "transactionIndex":if mode==10 {"0x1"}else{"0x0"},"gasUsed":if mode==9 {"0x200000"}else{"0xc350"},"effectiveGasPrice":if mode==23 {"0x1"}else{"0x3b9aca00"},
                    "status":if mode==5||mode==26||(mode==6&&step==1) {"0x0"}else if mode==14 {"0x2"}else{"0x1"}})
            }
        }
        _ => panic!("unexpected reconciliation RPC"),
    };
    axum::Json(json!({"jsonrpc":"2.0","id":1,"result":result}))
}
async fn receipt_fixture(
    f: &Fixture,
) -> (
    honey_server::providers::evm_rpc::EvmReadRpc,
    ReceiptFixture,
    tokio::task::JoinHandle<()>,
) {
    let plan = f
        .store
        .load_preparation(f.user, f.wallet, f.operation)
        .await
        .unwrap();
    let fixture = ReceiptFixture {
        mode: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        hashes: f
            .bundle
            .transactions()
            .iter()
            .map(|t| format!("{:#x}", t.hash()))
            .collect(),
        sender: plan.signer,
        recipients: plan.steps.iter().map(|s| s.to.clone()).collect(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc = honey_server::providers::evm_rpc::EvmReadRpc::new(&format!(
        "http://{}",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let app = axum::Router::new()
        .route("/", axum::routing::post(receipt_rpc))
        .with_state(fixture.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (rpc, fixture, task)
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL and loopback RPC"]
async fn canonical_approval_allows_next_step_and_only_full_finality_releases_guard() {
    use std::sync::atomic::Ordering;
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key1", 1);
    f.store.stage_signed(&key, f.input()).await.unwrap();

    let (rpc, fixture, server) = receipt_fixture(&f).await;
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    assert!(
        f.store
            .begin_dispatch_step(
                &key,
                &lease,
                NonceObservation {
                    nonce: 8,
                    observed_at_ms: now()
                },
                1
            )
            .await
            .is_err()
    );
    f.store
        .begin_initial_dispatch(
            &key,
            &lease,
            NonceObservation {
                nonce: 7,
                observed_at_ms: now(),
            },
        )
        .await
        .unwrap();
    fixture.mode.store(1, Ordering::Relaxed);
    let proof = collect_current(&rpc, &f, &key).await.unwrap();
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    f.store.record_reconciliation(&lease, &proof).await.unwrap();
    assert_eq!(
        f.store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .state,
        OperationState::Confirming
    );
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    let second = f
        .store
        .begin_dispatch_step(
            &key,
            &lease,
            NonceObservation {
                nonce: 8,
                observed_at_ms: now(),
            },
            1,
        )
        .await
        .unwrap();
    assert_eq!(
        second.expose_signed_bytes(),
        hex::decode(&f.raw[1][2..]).unwrap()
    );
    let mut terminal_lease = None;
    for (mode, state) in [
        (2, OperationState::Confirming),
        (3, OperationState::Succeeded),
    ] {
        fixture.mode.store(mode, Ordering::Relaxed);
        let proof = collect_current(&rpc, &f, &key).await.unwrap();
        let lease = f
            .store
            .claim(Topic::OperationChanged, 30)
            .await
            .unwrap()
            .unwrap();
        f.store.record_reconciliation(&lease, &proof).await.unwrap();
        assert_eq!(
            f.store
                .get(f.user, f.wallet, f.operation)
                .await
                .unwrap()
                .state,
            state
        );
        assert_eq!(counts(&db).await.2, if mode == 3 { 0 } else { 1 });
        if mode == 3 {
            terminal_lease = Some(lease);
        }
    }
    assert_eq!(counts(&db).await.3, 2);
    // An old worker/report cannot reverse terminal settlement.
    assert!(
        f.store
            .claim(Topic::OperationChanged, 30)
            .await
            .unwrap()
            .is_none()
    );
    let lease = terminal_lease.unwrap();
    assert!(
        f.store
            .record_reconciliation(&lease, &collect_current(&rpc, &f, &key).await.unwrap())
            .await
            .is_err()
    );
    fixture.mode.store(4, Ordering::Relaxed);
    assert!(collect_current(&rpc, &f, &key).await.is_err());
    server.abort();
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL and loopback RPC"]
async fn reorg_with_missing_receipts_retains_guard_and_unchanged_poll_does_not_grow_history() {
    use std::sync::atomic::Ordering;
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key1", 1);
    f.store.stage_signed(&key, f.input()).await.unwrap();

    let (rpc, fixture, server) = receipt_fixture(&f).await;
    fixture.mode.store(1, Ordering::Relaxed);
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    f.store
        .record_reconciliation(&lease, &collect_current(&rpc, &f, &key).await.unwrap())
        .await
        .unwrap();
    fixture.mode.store(4, Ordering::Relaxed);
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    f.store
        .record_reconciliation(&lease, &collect_current(&rpc, &f, &key).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        f.store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .state,
        OperationState::Unknown
    );
    let version = f
        .store
        .get(f.user, f.wallet, f.operation)
        .await
        .unwrap()
        .version;
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    assert!(
        f.store
            .begin_dispatch_step(
                &key,
                &lease,
                NonceObservation {
                    nonce: 8,
                    observed_at_ms: now()
                },
                1
            )
            .await
            .is_err()
    );
    f.store
        .record_reconciliation(&lease, &collect_current(&rpc, &f, &key).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        f.store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .version,
        version
    );
    assert!(
        f.store
            .claim(Topic::OperationChanged, 30)
            .await
            .unwrap()
            .is_none()
    );
    let batches: i64 = sqlx::query_scalar("SELECT count(*) FROM evm_reconciliation_batches")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(batches, 2);
    assert_eq!(counts(&db).await.2, 1);
    server.abort();
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL and loopback RPC"]
async fn malformed_chain_receipts_and_finality_regression_never_authorize_dispatch() {
    use std::sync::atomic::Ordering;
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key1", 1);
    f.store.stage_signed(&key, f.input()).await.unwrap();

    let (rpc, fixture, server) = receipt_fixture(&f).await;
    for mode in [7, 8, 9, 10, 14, 23] {
        fixture.mode.store(mode, Ordering::Relaxed);
        assert!(
            collect_current(&rpc, &f, &key).await.is_err(),
            "mode {mode}"
        );
    }
    fixture.mode.store(1, Ordering::Relaxed);
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    f.store
        .record_reconciliation(&lease, &collect_current(&rpc, &f, &key).await.unwrap())
        .await
        .unwrap();
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    for mode in [11, 12, 22] {
        fixture.mode.store(mode, Ordering::Relaxed);
        assert!(collect_current(&rpc, &f, &key).await.is_err());
    }
    // A stale proof cannot authorize a next step even when receipt data remains.
    sqlx::query(
        "UPDATE evm_reconciliation_current SET checked_at=clock_timestamp()-interval '11 seconds'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    assert!(
        f.store
            .begin_dispatch_step(
                &key,
                &lease,
                NonceObservation {
                    nonce: 8,
                    observed_at_ms: now()
                },
                1
            )
            .await
            .is_err()
    );
    assert_eq!(counts(&db).await.2, 1);
    assert_eq!(counts(&db).await.3, 0);
    server.abort();
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL and loopback RPC"]
async fn reverted_approval_blocks_action_and_terminal_revert_requires_all_signed_slots_finalized() {
    use std::sync::atomic::Ordering;
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key1", 1);
    f.store.stage_signed(&key, f.input()).await.unwrap();

    let (rpc, fixture, server) = receipt_fixture(&f).await;
    fixture.mode.store(5, Ordering::Relaxed);
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    f.store
        .record_reconciliation(&lease, &collect_current(&rpc, &f, &key).await.unwrap())
        .await
        .unwrap();
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    assert!(
        f.store
            .begin_dispatch_step(
                &key,
                &lease,
                NonceObservation {
                    nonce: 8,
                    observed_at_ms: now()
                },
                1
            )
            .await
            .is_err()
    );
    assert_eq!(counts(&db).await.2, 1);
    fixture.mode.store(6, Ordering::Relaxed);
    f.store
        .record_reconciliation(&lease, &collect_current(&rpc, &f, &key).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        f.store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .state,
        OperationState::Failed
    );
    assert_eq!(counts(&db).await.2, 0);
    server.abort();
    db.close().await;
}

async fn collect_current(
    rpc: &honey_server::providers::evm_rpc::EvmReadRpc,
    f: &Fixture,
    key: &SubmissionKeys,
) -> Result<
    honey_server::reconciliation::VerifiedReconciliation,
    honey_server::reconciliation::ReceiptError,
> {
    let context = f
        .store
        .reconciliation_context(key, f.operation)
        .await
        .unwrap();
    honey_server::reconciliation::collect(rpc, &context).await
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL and loopback RPC"]
async fn finalized_predecessor_cannot_disappear_or_change_outcome_while_action_is_pending() {
    use std::sync::atomic::Ordering;
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let key = keys("key1", 1);
    f.store.stage_signed(&key, f.input()).await.unwrap();
    let (rpc, fixture, server) = receipt_fixture(&f).await;
    fixture.mode.store(24, Ordering::Relaxed);
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    f.store
        .record_reconciliation(&lease, &collect_current(&rpc, &f, &key).await.unwrap())
        .await
        .unwrap();
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    for mode in [25, 26] {
        fixture.mode.store(mode, Ordering::Relaxed);
        assert!(
            f.store
                .record_reconciliation(&lease, &collect_current(&rpc, &f, &key).await.unwrap())
                .await
                .is_err()
        );
    }
    let recovered = f
        .store
        .recover(f.user, f.wallet, f.operation)
        .await
        .unwrap();
    assert_eq!(recovered.operation.state, OperationState::Confirming);
    assert!(
        recovered.reconciliation.unwrap().transactions[0]
            .inclusion
            .as_ref()
            .unwrap()
            .finalized
    );
    assert_eq!(counts(&db).await.2, 1);
    server.abort();
    db.close().await;
}

/// Exercise an actual logical backup into a different database, never the service
/// named by TEST_DATABASE_URL. No provider or broadcast process runs in this drill.
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL and pg_dump/pg_restore on PATH"]
async fn logical_backup_restores_encrypted_unknown_operations_without_broadcast() {
    use std::{fs::OpenOptions, os::unix::fs::OpenOptionsExt, process::Command};
    struct Backup(std::path::PathBuf);
    impl Drop for Backup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let source = TestDatabase::new().await;
    let target = TestDatabase::empty().await;
    let f = setup(&source, None).await;
    let key = keys("key1", 1);
    f.store.stage_signed(&key, f.input()).await.unwrap();
    let lease = f
        .store
        .claim(Topic::OperationChanged, 30)
        .await
        .unwrap()
        .unwrap();
    // Commit the journal, then simulate loss before learning any RPC outcome.
    let _attempt = f
        .store
        .begin_initial_dispatch(
            &key,
            &lease,
            NonceObservation {
                nonce: 7,
                observed_at_ms: now(),
            },
        )
        .await
        .unwrap();
    assert_eq!(counts(&source).await, (1, 2, 1, 1));
    let source_name: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&source.pool)
        .await
        .unwrap();
    let target_name: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&target.pool)
        .await
        .unwrap();
    assert_ne!(source_name, target_name);
    let connection = std::env::var("TEST_DATABASE_URL").unwrap();
    let options: sqlx::postgres::PgConnectOptions = connection.parse().unwrap();
    let url = reqwest::Url::parse(&connection).unwrap();
    // URL userinfo is percent-encoded. Decode without treating '+' as a space.
    let encoded = url.password().unwrap_or("").as_bytes();
    let mut password = Vec::new();
    let mut i = 0;
    while i < encoded.len() {
        if encoded[i] == b'%' {
            password.push(
                u8::from_str_radix(std::str::from_utf8(&encoded[i + 1..i + 3]).unwrap(), 16)
                    .unwrap(),
            );
            i += 3;
        } else {
            password.push(encoded[i]);
            i += 1;
        }
    }
    let password = String::from_utf8(password).unwrap();
    let pg = |program: &str, database: &str| {
        let mut cmd = Command::new(program);
        // Credentials stay in the child environment, never argv or test output.
        cmd.env("PGHOST", options.get_host())
            .env("PGPORT", options.get_port().to_string())
            .env("PGUSER", options.get_username())
            .env("PGPASSWORD", &password)
            .env("PGDATABASE", database)
            .env("PGCONNECT_TIMEOUT", "10");
        cmd
    };
    let backup =
        Backup(std::env::temp_dir().join(format!("honey-restore-{}.dump", Uuid::new_v4())));
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&backup.0)
        .unwrap();
    let dumped = pg("pg_dump", &source_name)
        .args(["--format=custom", "--no-owner", "--no-privileges"])
        .stdout(file)
        .output()
        .unwrap();
    assert!(
        dumped.status.success(),
        "pg_dump: {}",
        String::from_utf8_lossy(&dumped.stderr)
    );
    // A post-backup write must be absent, explicitly demonstrating the RPO gap.
    let lost_user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id) VALUES ($1)")
        .bind(lost_user)
        .execute(&source.pool)
        .await
        .unwrap();
    let restored = pg("pg_restore", &target_name)
        .args([
            "--dbname",
            &target_name,
            "--exit-on-error",
            "--no-owner",
            "--no-privileges",
        ])
        .stdin(std::fs::File::open(&backup.0).unwrap())
        .output()
        .unwrap();
    assert!(
        restored.status.success(),
        "pg_restore: {}",
        String::from_utf8_lossy(&restored.stderr)
    );
    honey_server::database::migrate(&target.pool).await.unwrap();
    let missing: bool = sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM users WHERE id=$1)")
        .bind(lost_user)
        .fetch_one(&target.pool)
        .await
        .unwrap();
    assert!(missing);
    let store = WorkStore::new(target.pool.clone());
    assert_eq!(counts(&target).await, (1, 2, 1, 1));
    assert_eq!(
        store
            .get(f.user, f.wallet, f.operation)
            .await
            .unwrap()
            .state,
        OperationState::Unknown
    );
    let recovery = store.recover(f.user, f.wallet, f.operation).await.unwrap();
    assert_eq!(
        recovery.submission.unwrap().transaction_hashes,
        f.bundle
            .transactions()
            .iter()
            .map(|t| format!("{:#x}", t.hash()))
            .collect::<Vec<_>>()
    );
    assert!(
        store
            .recover(Uuid::new_v4(), f.wallet, f.operation)
            .await
            .is_err()
    );
    store
        .reconciliation_context(&key, f.operation)
        .await
        .unwrap();
    assert!(
        store
            .reconciliation_context(&keys("key2", 2), f.operation)
            .await
            .is_err()
    );
    assert!(
        store
            .reconciliation_context(&keys("key1", 2), f.operation)
            .await
            .is_err()
    );
    store.stage_signed(&key, f.input()).await.unwrap();
    assert!(
        store
            .begin_initial_dispatch(
                &key,
                &lease,
                NonceObservation {
                    nonce: 7,
                    observed_at_ms: now()
                }
            )
            .await
            .is_err()
    );
    assert_eq!(counts(&target).await, (1, 2, 1, 1));
    target.close().await;
    source.close().await;
}
