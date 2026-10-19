//! Mock RPC plus real isolated PostgreSQL. No claim of live provider or actual
//! contract acceptance: this proves the reviewed operation's durability boundary.
use super::*;
use crate::{
    error::AppError,
    providers::uniswap::execution_context,
    submissions::SubmissionKeys,
    swap_review::{StageSwapPermit, SwapBuildContext},
    work::{Action, JobLease, NewOperation, OperationState, Topic, WorkStore},
};
use sqlx::Row;
use uuid::Uuid;
use zeroize::Zeroizing;
mod common {
    use crate as honey_server;
    include!("../../../../tests/common/mod.rs");
}
use common::TestDatabase;
fn keys(id: &str, byte: u8) -> SubmissionKeys {
    SubmissionKeys::new(id.into(), [(id.into(), Zeroizing::new([byte; 32]))].into()).unwrap()
}
struct Fixture {
    store: WorkStore,
    user: Uuid,
    wallet: Uuid,
    id: Uuid,
    lease: JobLease,
    context: SwapBuildContext,
    swap: PreparedSwap,
}
async fn fixture(db: &TestDatabase, no_permit: bool) -> Fixture {
    let key = keys("old", 1);
    let store = WorkStore::new(db.pool.clone());
    let user = Uuid::new_v4();
    let wallet = Uuid::new_v4();
    let route = no_permit.then_some("v3_direct");
    let (initial, _) = execution_context(now_ms() - 1, route, None);
    sqlx::query("INSERT INTO users(id) VALUES($1)")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES($1,$2,1,$3,'eoa')")
        .bind(wallet).bind(user).bind(hex::decode(&initial.review.authority.owner[2..]).unwrap()).execute(&db.pool).await.unwrap();
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
    let intent: String =
        sqlx::query_scalar("SELECT encode(intent_hash,'hex') FROM operations WHERE id=$1")
            .bind(op.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let (context, build) = execution_context(now_ms() - 1, route, Some(&intent));
    let (rpc, policy, review, build, _, task) = setup_from(context.review.clone(), build).await;
    let lease = store
        .claim(Topic::OperationCreated, 30)
        .await
        .unwrap()
        .unwrap();
    store
        .persist_swap_review(
            &key,
            &lease,
            &review,
            &serde_json::from_slice(&context.provider_quote).unwrap(),
        )
        .await
        .unwrap();
    if let Some(signature) = &context.signature {
        let observed = observe(&rpc, &policy, &review, build.source_block())
            .await
            .unwrap();
        let state = store.get(user, wallet, op.id).await.unwrap();
        store
            .stage_swap_permit(
                &key,
                StageSwapPermit {
                    user,
                    wallet,
                    operation: op.id,
                    expected_version: state.version.parse().unwrap(),
                    review_hash: &review.integrity_hash().unwrap(),
                    signature,
                    nonce: Some(&observed.permit_observation(&review).unwrap()),
                },
            )
            .await
            .unwrap();
    }
    let swap = prepare(&rpc, &policy, &review, &build).await.unwrap();
    task.abort();
    let lease = store
        .claim(Topic::OperationChanged, 30)
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
        context,
        swap,
    }
}
async fn persist(f: &Fixture) -> std::result::Result<(), AppError> {
    f.store
        .persist_reviewed_swap_preparation(&keys("old", 1), &f.lease, &f.swap)
        .await
}
async fn assert_unwritten(f: &Fixture, db: &TestDatabase) {
    assert_eq!(
        f.store.get(f.user, f.wallet, f.id).await.unwrap().state,
        OperationState::BuildingSwap
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM operation_preparations WHERE operation_id=$1"
        )
        .bind(f.id)
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM jobs WHERE id=$1")
            .bind(f.lease.id)
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        "leased"
    );
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn reviewed_build_atomic_race_restart_and_rotation() {
    let db = TestDatabase::new().await;
    let f = fixture(&db, false).await;
    assert!(
        f.store
            .persist_sealed_swap_preparation(&keys("old", 1), &f.lease, f.swap.prepared())
            .await
            .is_err()
    );
    let (a, b) = tokio::join!(persist(&f), persist(&f));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let recovered = f.store.recover(f.user, f.wallet, f.id).await.unwrap();
    assert_eq!(recovered.operation.state, OperationState::AwaitingSignature);
    assert_eq!(
        recovered.operation.version,
        (f.lease.operation_version + 1).to_string()
    );
    assert!(!recovered.execution_available);
    let public = serde_json::to_string(&recovered).unwrap();
    assert!(!public.contains(f.context.signature.as_ref().unwrap().as_str()));
    assert!(!public.contains(&f.swap.prepared().plan.steps.last().unwrap().data));
    let row = sqlx::query(
        "SELECT canonical_json,public_json FROM operation_preparations WHERE operation_id=$1",
    )
    .bind(f.id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(row.get::<Option<String>, _>("canonical_json").is_none());
    assert!(
        !row.get::<String, _>("public_json")
            .contains("buildRequestId")
    );
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
    let evidence = restarted
        .load_reviewed_swap_preparation(&rotated, f.user, f.wallet, f.id)
        .await
        .unwrap();
    assert_eq!(
        evidence.review.integrity_hash().unwrap(),
        f.swap.review_hash()
    );
    assert_eq!(evidence.build_request_id, f.swap.build_request_id());
    assert_eq!(
        serde_json::to_value(evidence.prepared).unwrap(),
        serde_json::to_value(f.swap.prepared()).unwrap()
    );
    // The generic signing/submission loader also traverses the authenticated link.
    assert!(
        restarted
            .load_preparation_with_keys(&rotated, f.user, f.wallet, f.id)
            .await
            .is_ok()
    );
    assert!(
        restarted
            .load_swap_build(&rotated, f.user, f.wallet, f.id)
            .await
            .is_err()
    );
    for (key, user, wallet) in [
        (keys("missing", 1), f.user, f.wallet),
        (keys("old", 2), f.user, f.wallet),
        (keys("old", 1), Uuid::new_v4(), f.wallet),
        (keys("old", 1), f.user, Uuid::new_v4()),
    ] {
        assert!(
            restarted
                .load_reviewed_swap_preparation(&key, user, wallet, f.id)
                .await
                .is_err()
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM evm_signing_requests WHERE operation_id=$1"
        )
        .bind(f.id)
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM jobs WHERE operation_id=$1 AND operation_version=$2"
        )
        .bind(f.id)
        .bind(f.lease.operation_version + 1)
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        1
    );
    // Corrupting review evidence (simulated privileged database access) is
    // detected by both the reviewed and generic signing loaders.
    sqlx::query("ALTER TABLE swap_reviews DISABLE TRIGGER immutable_swap_review")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE swap_reviews SET ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1) WHERE operation_id=$1").bind(f.id).execute(&db.pool).await.unwrap();
    assert!(
        restarted
            .load_sealed_swap_preparation(&rotated, f.user, f.wallet, f.id)
            .await
            .is_err()
    );
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn no_permit_build_uses_same_reviewed_transition() {
    let db = TestDatabase::new().await;
    let f = fixture(&db, true).await;
    assert!(f.context.signature.is_none());
    persist(&f).await.unwrap();
    let result = f
        .store
        .load_reviewed_swap_preparation(&keys("old", 1), f.user, f.wallet, f.id)
        .await
        .unwrap();
    assert!(result.review.permit.is_none());
    assert_eq!(
        result.prepared.plan.expires_at_ms,
        result.review.expires_at_ms
    );
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn changed_review_terms_and_stale_lease_do_not_install_preparation() {
    let db = TestDatabase::new().await;
    let mut f = fixture(&db, false).await;
    let original = f.swap.prepared.clone();
    for fault in 0..8 {
        f.swap.prepared = original.clone();
        match fault {
            0 => f.swap.prepared.plan.quote_reference = Some("another-quote".into()),
            1 => f.swap.prepared.plan.expires_at_ms += 1000,
            2 => {
                f.swap
                    .prepared
                    .plan
                    .minimum_receive
                    .as_mut()
                    .unwrap()
                    .amount_raw = "1899".into()
            }
            3 => f.swap.prepared.plan.registry_revision = "other-registry".into(),
            4 => f.swap.prepared.plan.maximum_spend.amount_raw = "1001".into(),
            5 => {
                f.swap.prepared.plan.steps[1].data = encode_call(
                    "approve(address,uint256)",
                    &[
                        word(addr(&f.context.review.permit2).unwrap()),
                        U256::MAX.to_be_bytes(),
                    ],
                );
                f.swap.prepared.plan.simulation.calls_hash =
                    calls_hash(&f.swap.prepared.plan.steps).unwrap();
            }
            6 => f.swap.prepared.plan.simulation.observed_at_ms = now_ms() - 61_000,
            7 => f.swap.prepared.plan.fee_policy_revision = "another-fee-policy".into(),
            _ => unreachable!(),
        }
        assert!(persist(&f).await.is_err(), "fault {fault}");
        assert_unwritten(&f, &db).await;
    }
    f.swap.prepared = original;
    f.swap.review_hash = "b".repeat(64);
    assert!(persist(&f).await.is_err());
    assert_unwritten(&f, &db).await;
    f.swap.review_hash = f.context.review.integrity_hash().unwrap();
    let old = f.lease.token;
    f.lease.token = Uuid::new_v4();
    assert!(persist(&f).await.is_err());
    assert_unwritten(&f, &db).await;
    f.lease.token = old;
    persist(&f).await.unwrap();
    db.close().await;
}
#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn enqueue_failure_rolls_back_evidence_state_and_lease() {
    let db = TestDatabase::new().await;
    let f = fixture(&db, false).await;
    sqlx::query("CREATE FUNCTION fail_successor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.topic='operation.changed' THEN RAISE EXCEPTION 'test successor failure'; END IF; RETURN NEW; END $$").execute(&db.pool).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_successor BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION fail_successor()").execute(&db.pool).await.unwrap();
    assert!(persist(&f).await.is_err());
    assert_unwritten(&f, &db).await;
    sqlx::query("DROP TRIGGER fail_successor ON jobs")
        .execute(&db.pool)
        .await
        .unwrap();
    persist(&f).await.unwrap();
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn lease_expiring_during_insert_rolls_back_preparation() {
    let db = TestDatabase::new().await;
    let f = fixture(&db, false).await;
    sqlx::query("CREATE FUNCTION expire_build_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE operation_id=NEW.operation_id AND state='leased'; RETURN NEW; END $$").execute(&db.pool).await.unwrap();
    sqlx::query("CREATE TRIGGER expire_build_lease BEFORE INSERT ON operation_preparations FOR EACH ROW EXECUTE FUNCTION expire_build_lease()").execute(&db.pool).await.unwrap();
    assert!(persist(&f).await.is_err());
    assert_unwritten(&f, &db).await;
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT lease_until>clock_timestamp() FROM jobs WHERE id=$1")
            .bind(f.lease.id)
            .fetch_one(&db.pool)
            .await
            .unwrap()
    );
    sqlx::query("DROP TRIGGER expire_build_lease ON operation_preparations")
        .execute(&db.pool)
        .await
        .unwrap();
    persist(&f).await.unwrap();
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn failed_unprepared_build_keeps_live_permit_guard_and_evidence() {
    let db = TestDatabase::new().await;
    let f = fixture(&db, false).await;
    f.store
        .transition(
            f.id,
            f.lease.operation_version,
            OperationState::Failed,
            &f.lease,
        )
        .await
        .unwrap();
    assert!(!f.store.complete(&f.lease).await.unwrap());
    assert_eq!(
        f.store.get(f.user, f.wallet, f.id).await.unwrap().state,
        OperationState::Failed
    );
    let ready_terminal_jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE operation_id=$1 AND topic='operation.changed' AND state='ready'",
    )
    .bind(f.id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(ready_terminal_jobs, 0);
    for table in [
        "swap_reviews",
        "swap_permit_signatures",
        "swap_permit_guards",
    ] {
        let n: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE operation_id=$1"
        ))
        .bind(f.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(n, 1);
    }
    assert!(persist(&f).await.is_err());
    db.close().await;
}
