use super::*;
use crate::{
    bridge_monitor::{BridgeBinding, BridgeMonitor},
    providers::across_evidence::{VerifiedAcrossFill, test_fill},
    work::{NewOperation, OperationState, Topic},
};
use serde_json::json;
mod common {
    use crate as honey_server;
    include!("../../tests/common/mod.rs");
}
use common::TestDatabase;

// Relational persistence fixtures only: fake encrypted plan/transaction bytes are
// never accepted by a signer/dispatcher. Fill proof itself comes from real RPC
// verifier execution, with independently viem-encoded receipt fixtures.
async fn seed(
    db: &TestDatabase,
    proof: &VerifiedAcrossFill,
    fault: &str,
    initial: &str,
) -> (WorkStore, Uuid, Uuid, Uuid, JobLease) {
    let work = WorkStore::new(db.pool.clone());
    let user = Uuid::new_v4();
    let wallet = Uuid::new_v4();
    let terms = proof.deposit().terms();
    let mut stored_terms = terms.clone();
    if fault == "terms" {
        stored_terms.recipient = alloy_primitives::Address::repeat_byte(99);
    }
    let signer = if fault == "signer" {
        vec![99; 20]
    } else {
        terms.depositor.as_slice().to_vec()
    };
    sqlx::query("INSERT INTO users(id) VALUES($1)")
        .bind(user)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES($1,$2,$4,$3,'eoa')").bind(wallet).bind(user).bind(&signer).bind(terms.source_chain as i64).execute(&db.pool).await.unwrap();
    let binding = BridgeBinding {
        provider: BridgeProvider::Across,
        provider_reference: proof.deposit().deposit_id(),
        source_chain_id: terms.source_chain.to_string(),
        destination_chain_id: terms.destination_chain.to_string(),
        refund_chain_id: terms.source_chain.to_string(),
        source_transaction_hash: format!("{:#x}", proof.deposit().source().transaction_hash),
    };
    let intent = if fault == "service" {
        crate::across_service::test_service_intent(&stored_terms)
    } else {
        json!({"bridgeTracking":binding.intent_terms().unwrap(),"acrossDirectDeposit":stored_terms})
    };
    let op = work
        .create(NewOperation {
            user_id: user,
            wallet_id: wallet,
            action: Action::Bridge,
            idempotency_key: "settlement",
            intent: &intent,
        })
        .await
        .unwrap();
    sqlx::query("INSERT INTO operation_preparations(operation_id,canonical_json,plan_hash,expires_at) VALUES($1,'{}',$2,clock_timestamp()+interval '5 minutes')").bind(op.id).bind(vec![3u8;32]).execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO evm_submissions(operation_id,wallet_id,chain_id,signer,plan_hash,first_nonce,step_count) VALUES($1,$2,$6,$3,$4,0,$5)").bind(op.id).bind(wallet).bind(&signer).bind(vec![3u8;32]).bind(if fault=="approval_reverted" {2i16} else {1i16}).bind(terms.source_chain as i64).execute(&db.pool).await.unwrap();
    let transaction = Uuid::new_v4();
    let hash = if fault == "source_hash" {
        vec![99u8; 32]
    } else {
        proof
            .deposit()
            .source()
            .transaction_hash
            .as_slice()
            .to_vec()
    };
    sqlx::query("INSERT INTO evm_signed_transactions(id,operation_id,step,chain_id,signer,nonce,tx_hash,key_id,encryption_nonce,ciphertext) VALUES($1,$2,$7,$8,$3,$7,$4,'fixture',$5,$6)").bind(transaction).bind(op.id).bind(&signer).bind(hash).bind(vec![0u8;24]).bind(vec![0u8;17]).bind(if fault=="approval_reverted" {1i16} else {0i16}).bind(terms.source_chain as i64).execute(&db.pool).await.unwrap();
    if fault == "approval_reverted" {
        sqlx::query("INSERT INTO evm_signed_transactions(id,operation_id,step,chain_id,signer,nonce,tx_hash,key_id,encryption_nonce,ciphertext) VALUES($1,$2,0,1,$3,0,$4,'fixture',$5,$6)").bind(Uuid::new_v4()).bind(op.id).bind(&signer).bind(vec![4u8;32]).bind(vec![0u8;24]).bind(vec![0u8;17]).execute(&db.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO evm_wallet_guards(wallet_id,operation_id) VALUES($1,$2)")
        .bind(wallet)
        .bind(op.id)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE operations SET state=$2 WHERE id=$1")
        .bind(op.id)
        .bind(initial)
        .execute(&db.pool)
        .await
        .unwrap();
    if fault.is_empty() || fault == "service" {
        BridgeMonitor::new(work.clone())
            .attach_across(op.id, proof.deposit())
            .await
            .unwrap();
    } else {
        let mut binding = binding;
        if fault == "destination" {
            binding.destination_chain_id = "10".into();
        }
        let canonical = serde_json::to_string(&binding).unwrap();
        sqlx::query("INSERT INTO bridge_status_watches(operation_id,source_transaction_id,provider,binding_json,binding_hash) VALUES($1,$2,'across',$3,$4)").bind(op.id).bind(transaction).bind(&canonical).bind(digest(canonical.as_bytes())).execute(&db.pool).await.unwrap();
    }
    let lease = work
        .claim(Topic::OperationCreated, 90)
        .await
        .unwrap()
        .unwrap();
    (work, user, wallet, op.id, lease)
}

async fn source_done(
    work: &WorkStore,
    id: Uuid,
    lease: &JobLease,
    proof: &VerifiedAcrossFill,
) -> JobLease {
    let count: i16 =
        sqlx::query_scalar("SELECT step_count FROM evm_submissions WHERE operation_id=$1")
            .bind(id)
            .fetch_one(&work.pool)
            .await
            .unwrap();
    work.record_reconciliation(
        lease,
        &crate::reconciliation::test_finalized_bridge_report(id, proof, count == 2),
    )
    .await
    .unwrap();
    work.claim(Topic::OperationChanged, 90)
        .await
        .unwrap()
        .unwrap()
}
async fn assert_pending(db: &TestDatabase, id: Uuid) {
    let (state,count,stopped):(String,i64,bool)=sqlx::query_as("SELECT o.state,(SELECT count(*) FROM across_settlements WHERE operation_id=o.id),w.stopped_at IS NOT NULL FROM operations o JOIN bridge_status_watches w ON w.operation_id=o.id WHERE o.id=$1").bind(id).fetch_one(&db.pool).await.unwrap();
    assert_eq!(state, "bridging");
    assert_eq!(count, 0);
    assert!(!stopped);
}

#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL and loopback RPC fixture"]
async fn source_finality_is_bridging_and_only_verified_delivery_atomically_succeeds() {
    let db = TestDatabase::new().await;
    let proof = test_fill().await;
    let (work, user, wallet, id, source_lease) = seed(&db, &proof, "", "signed").await;
    let lease = source_done(&work, id, &source_lease, &proof).await;
    assert_eq!(
        work.get(user, wallet, id).await.unwrap().state,
        OperationState::Bridging
    );
    assert!(
        BridgeMonitor::new(work.clone())
            .recover(user, wallet, id)
            .await
            .unwrap()
            .verified_delivery
            .is_none()
    );
    assert_pending(&db, id).await;
    assert!(
        work.across_delivery(user, wallet, id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        work.across_delivery(Uuid::new_v4(), wallet, id).await,
        Err(AppError::NotFound)
    ));
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM evm_wallet_guards WHERE operation_id=$1)"
        )
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap()
    );
    assert!(
        work.transition(
            id,
            lease.operation_version,
            OperationState::Succeeded,
            &lease
        )
        .await
        .is_err()
    );
    assert!(
        sqlx::query("UPDATE operations SET state='succeeded' WHERE id=$1")
            .bind(id)
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE operations SET state='failed',version=version+1 WHERE id=$1")
            .bind(id)
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query(
            "UPDATE bridge_status_watches SET stopped_at=clock_timestamp() WHERE operation_id=$1"
        )
        .bind(id)
        .execute(&db.pool)
        .await
        .is_err()
    );
    work.complete_across_delivery(&lease, &proof).await.unwrap();
    work.complete_across_delivery(&lease, &proof).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(10_050)).await;
    work.complete_across_delivery(&lease, &proof).await.unwrap();
    let operation = work.get(user, wallet, id).await.unwrap();
    assert_eq!(operation.state, OperationState::Succeeded);
    assert_eq!(operation.version, "2");
    let ready_terminal_jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE operation_id=$1 AND topic='operation.changed' AND state='ready'",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(ready_terminal_jobs, 0);
    let recovery = BridgeMonitor::new(work.clone())
        .recover(user, wallet, id)
        .await
        .unwrap();
    let delivery = recovery.verified_delivery.unwrap();
    assert_eq!(delivery.evidence_version, "1");
    assert_eq!(delivery.operation_version, "2");
    assert_eq!(
        delivery.source_chain_id,
        proof.deposit().terms().source_chain.to_string()
    );
    assert_eq!(
        delivery.destination_chain_id,
        proof.deposit().terms().destination_chain.to_string()
    );
    assert_eq!(
        delivery.source_transaction_hash,
        format!("{:#x}", proof.deposit().source().transaction_hash)
    );
    assert_eq!(
        delivery.destination_transaction_hash,
        format!("{:#x}", proof.destination().transaction_hash)
    );
    assert_eq!(
        delivery.recipient,
        format!("{:#x}", proof.deposit().terms().recipient)
    );
    assert_eq!(
        delivery.output_token,
        format!("{:#x}", proof.deposit().terms().output_token)
    );
    assert_eq!(
        delivery.delivered_amount_raw,
        proof.deposit().terms().output_amount.to_string()
    );
    assert_eq!(delivery.verified_at_ms, proof.checked_at_ms());
    assert_eq!(
        delivery.source.block_number,
        proof.deposit().source().block_number.to_string()
    );
    assert_eq!(
        delivery.source.block_hash,
        format!("{:#x}", proof.deposit().source().block_hash)
    );
    assert_eq!(
        delivery.source.finalized_number,
        proof.deposit().source().finalized_number.to_string()
    );
    assert_eq!(
        delivery.source.finalized_hash,
        format!("{:#x}", proof.deposit().source().finalized_hash)
    );
    assert_eq!(
        delivery.destination.block_number,
        proof.destination().block_number.to_string()
    );
    assert_eq!(
        delivery.destination.block_hash,
        format!("{:#x}", proof.destination().block_hash)
    );
    assert_eq!(
        delivery.destination.finalized_number,
        proof.destination().finalized_number.to_string()
    );
    assert_eq!(
        delivery.destination.finalized_hash,
        format!("{:#x}", proof.destination().finalized_hash)
    );
    let delivery = WorkStore::new(db.pool.clone())
        .across_delivery(user, wallet, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(delivery.delivered_amount_raw, "990000");
    assert_eq!(delivery.destination_chain_id, "8453");
    assert_eq!(
        delivery.source_transaction_hash,
        format!("{:#x}", proof.deposit().source().transaction_hash)
    );
    assert_eq!(
        delivery.destination_transaction_hash,
        format!("{:#x}", proof.destination().transaction_hash)
    );
    assert_eq!(delivery.operation_version, "2");
    assert!(matches!(
        work.across_delivery(user, Uuid::new_v4(), id).await,
        Err(AppError::NotFound)
    ));
    assert!(
        BridgeMonitor::new(work.clone())
            .recover(user, wallet, id)
            .await
            .unwrap()
            .verified_delivery
            .is_some()
    );
    let (count,version,stopped):(i64,i64,bool)=sqlx::query_as("SELECT (SELECT count(*) FROM across_settlements WHERE operation_id=$1),w.poll_version,w.stopped_at IS NOT NULL FROM bridge_status_watches w WHERE operation_id=$1").bind(id).fetch_one(&db.pool).await.unwrap();
    assert_eq!((count, version, stopped), (1, 1, true));
    let client = crate::providers::bridge_status::BridgeStatusClient::across(
        zeroize::Zeroizing::new("fixture".into()),
        "0xabcd".into(),
        crate::providers::rpc_budget::RpcBudgetConfig {
            scope: "settlement-test".into(),
            interval_ms: 1,
            simulation_cost: 1,
        },
        crate::redis_store::RedisStore::new(
            redis::Client::open("redis://127.0.0.1:1").unwrap(),
            "unused-stopped-watch".into(),
            std::time::Duration::from_millis(50),
        ),
        std::sync::Arc::new(crate::metrics::Metrics::default()),
    )
    .unwrap();
    // A stopped watch must not even acquire a provider quota or perform IO.
    assert!(
        !BridgeMonitor::with_client(work.clone(), client)
            .tick()
            .await
            .unwrap()
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE operation_id=$1 AND operation_version=2",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    // Successful settlement is terminal, so it must not leave an unclaimable
    // operation.changed job at the new operation version.
    assert_eq!(count, 0);
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    let changed = test_fill().await;
    assert!(
        work.complete_across_delivery(&lease, &changed)
            .await
            .is_err()
    );
    let forged = JobLease {
        token: Uuid::new_v4(),
        ..lease
    };
    assert!(
        work.complete_across_delivery(&forged, &proof)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE across_settlements SET proof_json='{}' WHERE operation_id=$1")
            .bind(id)
            .execute(&db.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE bridge_status_watches SET stopped_at=NULL WHERE operation_id=$1")
            .bind(id)
            .execute(&db.pool)
            .await
            .is_err()
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL and loopback RPC fixture"]
async fn reverted_approval_with_successful_final_deposit_still_requires_delivery() {
    let db = TestDatabase::new().await;
    let proof = test_fill().await;
    let (work, user, wallet, id, source_lease) =
        seed(&db, &proof, "approval_reverted", "signed").await;
    let lease = source_done(&work, id, &source_lease, &proof).await;
    assert_pending(&db, id).await;
    work.complete_across_delivery(&lease, &proof).await.unwrap();
    assert_eq!(
        work.get(user, wallet, id).await.unwrap().state,
        OperationState::Succeeded
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL and loopback RPC fixture"]
async fn mismatched_terms_sender_source_hash_destination_and_finalized_anchor_fail_closed() {
    for fault in [
        "terms",
        "signer",
        "source_hash",
        "destination",
        "source_anchor",
    ] {
        let db = TestDatabase::new().await;
        let proof = test_fill().await;
        let (work, _, _, id, lease) = seed(&db, &proof, fault, "signed").await;
        // A corrupted signed-hash fixture cannot pass source receipt reconciliation.
        // Seed a Bridging state only for this writer's independent binding check.
        let lease = if fault == "source_hash" {
            sqlx::query("UPDATE operations SET state='bridging' WHERE id=$1")
                .bind(id)
                .execute(&db.pool)
                .await
                .unwrap();
            lease
        } else {
            source_done(&work, id, &lease, &proof).await
        };
        if fault == "source_anchor" {
            sqlx::query(
                "UPDATE evm_reconciliation_current SET finalized_hash=$2 WHERE operation_id=$1",
            )
            .bind(id)
            .bind(vec![99u8; 32])
            .execute(&db.pool)
            .await
            .unwrap();
        }
        assert!(
            work.complete_across_delivery(&lease, &proof).await.is_err(),
            "{fault}"
        );
        assert_pending(&db, id).await;
        db.close().await;
    }
}

#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL and loopback RPC fixture"]
async fn stale_lease_and_proof_aged_while_waiting_for_lock_cannot_settle() {
    let db = TestDatabase::new().await;
    let proof = test_fill().await;
    let (work, _, _, id, source_lease) = seed(&db, &proof, "", "signed").await;
    let lease = source_done(&work, id, &source_lease, &proof).await;
    sqlx::query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(lease.id)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(work.complete_across_delivery(&lease, &proof).await.is_err());
    let renewed = work
        .claim(Topic::OperationChanged, 90)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renewed.id, lease.id);
    assert!(work.complete_across_delivery(&lease, &proof).await.is_err());
    let lease = renewed;
    let stale = JobLease {
        id: lease.id,
        operation_id: id,
        operation_version: lease.operation_version,
        token: Uuid::new_v4(),
        attempts: lease.attempts,
    };
    assert!(work.complete_across_delivery(&stale, &proof).await.is_err());
    let mut lock = db.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE")
        .bind(lease.id)
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    let waiting = tokio::spawn(async move { work.complete_across_delivery(&lease, &proof).await });
    tokio::time::sleep(std::time::Duration::from_millis(10_100)).await;
    lock.commit().await.unwrap();
    assert!(waiting.await.unwrap().is_err());
    assert_pending(&db, id).await;
    db.close().await;
}

#[tokio::test]
#[ignore = "requires disposable TEST_DATABASE_URL and loopback RPC fixture"]
async fn service_intent_attaches_settles_and_recovers_without_rewriting_consent() {
    let db = TestDatabase::new().await;
    let proof = crate::providers::across_evidence::test_local_fill().await;
    let (work, user, wallet, id, source_lease) = seed(&db, &proof, "service", "signed").await;
    let before: (String, Vec<u8>) = sqlx::query_as(
        "SELECT i.canonical_json,o.intent_hash FROM operation_intents i JOIN operations o ON o.id=i.operation_id WHERE i.operation_id=$1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let lease = source_done(&work, id, &source_lease, &proof).await;
    work.complete_across_delivery(&lease, &proof).await.unwrap();
    assert_eq!(
        work.get(user, wallet, id).await.unwrap().state,
        OperationState::Succeeded
    );
    assert!(
        work.across_delivery(user, wallet, id)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        BridgeMonitor::new(work)
            .recover(user, wallet, id)
            .await
            .unwrap()
            .verified_delivery
            .is_some()
    );
    let after: (String, Vec<u8>) = sqlx::query_as(
        "SELECT i.canonical_json,o.intent_hash FROM operation_intents i JOIN operations o ON o.id=i.operation_id WHERE i.operation_id=$1",
    )
    .bind(id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    db.close().await;
}
