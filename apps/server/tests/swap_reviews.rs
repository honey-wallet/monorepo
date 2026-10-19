//! Local PostgreSQL persistence tests. Public scalar 1 is a disposable fixture,
//! never an account used by a deployed wallet. RPC observations below are synthetic.
mod common;
use common::TestDatabase;
use honey_server::{
    error::AppError,
    providers::{permit2::PermitTerms, uniswap_economics::SwapAuthority},
    submissions::SubmissionKeys,
    swap_review::{PermitNonceObservation, StageSwapPermit, SwapReview},
    work::{Action, JobLease, NewOperation, OperationState, Topic, WorkStore},
};
use k256::ecdsa::SigningKey;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;
use zeroize::Zeroizing;
fn now() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
fn address(n: u8) -> String {
    format!("0x{n:040x}")
}
fn keys(id: &str, n: u8) -> SubmissionKeys {
    SubmissionKeys::new(id.into(), [(id.into(), Zeroizing::new([n; 32]))].into()).unwrap()
}
fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn terms() -> (SwapReview, Value) {
    let time = now() - 1;
    let deadline = ((time / 1000) + 600).to_string();
    let owner = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_owned();
    let quote = json!({"quoteId":"local-fixture", "chainId":31337,"swapper":owner,
        "input":{"token":address(20),"amount":"1000"},"output":{"token":address(30),"amount":"2000"},
        "privateFixtureMarker":"opaque-provider-data"});
    let permit = PermitTerms {
        chain_id: "31337".into(),
        permit2: address(60),
        owner: owner.clone(),
        token: address(20),
        amount_raw: "1000".into(),
        spender: address(40),
        nonce: "7".into(),
        expiration: deadline.clone(),
        sig_deadline: deadline.clone(),
    };
    (
        SwapReview {
            schema_version: 1,
            intent_hash: "a".repeat(64),
            quote_id: "local-fixture".into(),
            provider_quote_hash: sha(serde_json::to_string(&quote).unwrap().as_bytes()),
            registry_revision: "test-v1".into(),
            fee_policy_revision: "none-v1".into(),
            authority: SwapAuthority {
                chain_id: "31337".into(),
                owner,
                router: address(40),
                token_in: address(20),
                token_out: address(30),
                maximum_input_raw: "1000".into(),
                minimum_output_raw: "1900".into(),
                deadline: deadline.clone(),
                fee_basis: "settlement_balance".into(),
                tokens: vec![address(20), address(30)],
                fees: vec![],
            },
            permit2: address(60),
            permit: Some(permit),
            maximum_network_fee_raw: "1000000000000000".into(),
            quote_observed_at_ms: time,
            reviewed_at_ms: time,
            expires_at_ms: deadline.parse::<i64>().unwrap() * 1000,
        },
        quote,
    )
}
fn sign(review: &SwapReview) -> String {
    let digest = review
        .permit
        .as_ref()
        .unwrap()
        .digest((review.reviewed_at_ms / 1000) as u64)
        .unwrap();
    let mut raw = [0u8; 32];
    raw[31] = 1;
    let signer = SigningKey::from_bytes((&raw).into()).unwrap();
    let (signature, recovery) = signer.sign_prehash_recoverable(digest.as_slice()).unwrap();
    format!(
        "0x{}{:02x}",
        hex::encode(signature.to_bytes()),
        recovery.to_byte() + 27
    )
}
fn observation(review: &SwapReview) -> PermitNonceObservation {
    let p = review.permit.as_ref().unwrap();
    PermitNonceObservation {
        chain_id: p.chain_id.parse().unwrap(),
        permit2: p.permit2.parse().unwrap(),
        owner: p.owner.parse().unwrap(),
        token: p.token.parse().unwrap(),
        spender: p.spender.parse().unwrap(),
        nonce: p.nonce.parse().unwrap(),
        observed_at_ms: now() - 1,
        finalized_block_timestamp: ((now() / 1000) - 60) as u64,
    }
}
struct Fixture {
    store: WorkStore,
    user: Uuid,
    wallet: Uuid,
    id: Uuid,
    lease: JobLease,
    review: SwapReview,
    quote: Value,
}
async fn setup(db: &TestDatabase, previous: Option<&Fixture>) -> Fixture {
    let (mut review, quote) = terms();
    let user = previous.map_or_else(Uuid::new_v4, |v| v.user);
    let wallet = previous.map_or_else(Uuid::new_v4, |v| v.wallet);
    if previous.is_none() {
        sqlx::query("INSERT INTO users(id) VALUES($1)")
            .bind(user)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES($1,$2,31337,$3,'eoa')")
            .bind(wallet).bind(user).bind(hex::decode(&review.authority.owner[2..]).unwrap()).execute(&db.pool).await.unwrap();
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
    review.intent_hash =
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
        review,
        quote,
    }
}
async fn persist(f: &Fixture, k: &SubmissionKeys) {
    f.store
        .persist_swap_review(k, &f.lease, &f.review, &f.quote)
        .await
        .unwrap();
}
async fn stage(
    f: &Fixture,
    k: &SubmissionKeys,
    signature: &str,
    nonce: Option<&PermitNonceObservation>,
) -> Result<honey_server::work::Operation, AppError> {
    f.store
        .stage_swap_permit(
            k,
            StageSwapPermit {
                user: f.user,
                wallet: f.wallet,
                operation: f.id,
                expected_version: 1,
                review_hash: &f.review.integrity_hash().unwrap(),
                signature,
                nonce,
            },
        )
        .await
}
async fn count(db: &TestDatabase, table: &str) -> i64 {
    // Only literal table names supplied by these tests.
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

#[test]
fn bounded_public_review_binds_permit_and_economics_before_signature() {
    let (r, _) = terms();
    r.validate().unwrap();
    let original = serde_json::to_value(&r).unwrap();
    for (path, value) in [
        (vec!["schemaVersion"], json!(2)),
        (vec!["maximumNetworkFeeRaw"], json!("01")),
        (vec!["authority", "minimumOutputRaw"], json!("0")),
        (vec!["authority", "deadline"], json!("1")),
        (vec!["permit", "amountRaw"], json!("999")),
        (vec!["permit", "owner"], json!(address(1))),
        (vec!["permit2"], json!(address(1))),
        (vec!["expiresAtMs"], json!(r.expires_at_ms + 1)),
        (vec!["quoteObservedAtMs"], json!(r.reviewed_at_ms - 30001)),
    ] {
        let mut v = original.clone();
        let mut field = &mut v;
        for p in path {
            field = &mut field[p];
        }
        *field = value;
        assert!(
            serde_json::from_value::<SwapReview>(v)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    let signature = sign(&r);
    r.permit
        .as_ref()
        .unwrap()
        .verify_signature(&signature, (r.reviewed_at_ms / 1000) as u64)
        .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn concurrent_admission_restart_rotation_and_public_recovery() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let k = keys("old", 1);
    let (a, b) = tokio::join!(
        f.store
            .persist_swap_review(&k, &f.lease, &f.review, &f.quote),
        f.store
            .persist_swap_review(&k, &f.lease, &f.review, &f.quote)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let recovery = f.store.recover(f.user, f.wallet, f.id).await.unwrap();
    assert_eq!(recovery.operation.state, OperationState::AwaitingPermit);
    assert!(recovery.preparation.is_none());
    assert_eq!(count(&db, "jobs WHERE state='ready'").await, 0);
    let signature = sign(&f.review);
    let obs = observation(&f.review);
    let (a, b) = tokio::join!(
        stage(&f, &k, &signature, Some(&obs)),
        stage(&f, &k, &signature, Some(&obs))
    );
    for r in [a, b] {
        let r = r.unwrap();
        assert_eq!(r.state, OperationState::BuildingSwap);
        assert_eq!(r.version, "2");
    }
    assert_eq!(count(&db, "swap_permit_signatures").await, 1);
    assert_eq!(count(&db, "swap_permit_guards").await, 1);
    assert_eq!(count(&db, "jobs WHERE state='ready'").await, 1);
    assert_eq!(stage(&f, &k, &signature, None).await.unwrap().version, "2");
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
    let context = restarted
        .load_swap_build(&rotated, f.user, f.wallet, f.id)
        .await
        .unwrap();
    assert_eq!(context.signature.as_ref().unwrap().as_str(), signature);
    assert_eq!(
        serde_json::from_slice::<Value>(&context.provider_quote).unwrap(),
        f.quote
    );
    for key in [keys("missing", 1), keys("old", 2)] {
        assert!(
            restarted
                .load_swap_review(&key, f.user, f.wallet, f.id)
                .await
                .is_err()
        );
    }
    assert!(matches!(
        restarted
            .load_swap_review(&k, Uuid::new_v4(), f.wallet, f.id)
            .await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        restarted
            .load_swap_build(&k, f.user, Uuid::new_v4(), f.id)
            .await,
        Err(AppError::NotFound)
    ));
    let row=sqlx::query("SELECT r.canonical_json,r.ciphertext AS quote,s.ciphertext AS signature FROM swap_reviews r JOIN swap_permit_signatures s USING(operation_id)").fetch_one(&db.pool).await.unwrap();
    let public: String = row.get("canonical_json");
    assert!(!public.contains(&signature));
    assert!(!public.contains("opaque-provider-data"));
    let raw = hex::decode(&signature[2..]).unwrap();
    assert!(
        !row.get::<Vec<u8>, _>("signature")
            .windows(raw.len())
            .any(|v| v == raw)
    );
    let recovery =
        serde_json::to_string(&restarted.recover(f.user, f.wallet, f.id).await.unwrap()).unwrap();
    for secret in [signature.as_str(), "opaque-provider-data", "sigDeadline"] {
        assert!(!recovery.contains(secret));
    }
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn nonce_scope_rejects_competing_operation_but_allows_other_token() {
    let db = TestDatabase::new().await;
    let k = keys("old", 1);
    let f = setup(&db, None).await;
    persist(&f, &k).await;
    stage(&f, &k, &sign(&f.review), Some(&observation(&f.review)))
        .await
        .unwrap();
    let other = setup(&db, Some(&f)).await;
    persist(&other, &k).await;
    assert!(matches!(
        stage(
            &other,
            &k,
            &sign(&other.review),
            Some(&observation(&other.review))
        )
        .await,
        Err(AppError::Conflict(_))
    ));
    assert_eq!(
        other
            .store
            .get(other.user, other.wallet, other.id)
            .await
            .unwrap()
            .state,
        OperationState::AwaitingPermit
    );
    let mut token = setup(&db, Some(&f)).await;
    token.review.authority.token_in = address(21);
    token.review.authority.tokens[0] = address(21);
    token.review.permit.as_mut().unwrap().token = address(21);
    token.quote["input"]["token"] = json!(address(21));
    token.review.provider_quote_hash = sha(serde_json::to_string(&token.quote).unwrap().as_bytes());
    persist(&token, &k).await;
    stage(
        &token,
        &k,
        &sign(&token.review),
        Some(&observation(&token.review)),
    )
    .await
    .unwrap();
    assert_eq!(count(&db, "swap_permit_guards").await, 2);
    assert_eq!(count(&db, "swap_permit_signatures").await, 2);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn outbox_failure_rolls_back_signature_reservation_and_state() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let k = keys("old", 1);
    persist(&f, &k).await;
    sqlx::raw_sql("CREATE FUNCTION reject_test_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test outbox unavailable'; END; $$; CREATE TRIGGER reject_test_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_test_job();").execute(&db.pool).await.unwrap();
    assert!(
        stage(&f, &k, &sign(&f.review), Some(&observation(&f.review)))
            .await
            .is_err()
    );
    assert_eq!(count(&db, "swap_permit_signatures").await, 0);
    assert_eq!(count(&db, "swap_permit_guards").await, 0);
    assert_eq!(
        f.store.get(f.user, f.wallet, f.id).await.unwrap().version,
        "1"
    );
    sqlx::query("DROP TRIGGER reject_test_job ON jobs")
        .execute(&db.pool)
        .await
        .unwrap();
    stage(&f, &k, &sign(&f.review), Some(&observation(&f.review)))
        .await
        .unwrap();
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn fresh_scope_version_signature_and_quote_required_no_permit_build_is_separate() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let k = keys("old", 1);
    let mut wrong = f.quote.clone();
    wrong["input"]["amount"] = json!("1001");
    assert!(
        f.store
            .persist_swap_review(&k, &f.lease, &f.review, &wrong)
            .await
            .is_err()
    );
    persist(&f, &k).await;
    let sig = sign(&f.review);
    assert!(
        f.store
            .load_swap_build(&k, f.user, f.wallet, f.id)
            .await
            .is_err()
    );
    for mutation in 0..8 {
        let mut obs = observation(&f.review);
        match mutation {
            0 => obs.nonce += 1,
            1 => obs.chain_id += 1,
            2 => obs.token = address(1).parse().unwrap(),
            3 => obs.spender = address(1).parse().unwrap(),
            4 => obs.observed_at_ms = now() - 11000,
            5 => obs.observed_at_ms = now() + 10000,
            6 => obs.finalized_block_timestamp = (now() / 1000 + 1) as u64,
            _ => obs.owner = address(1).parse().unwrap(),
        };
        assert!(stage(&f, &k, &sig, Some(&obs)).await.is_err());
    }
    for (version, hash, signature) in [
        (0, f.review.integrity_hash().unwrap(), sig.clone()),
        (1, "a".repeat(64), sig.clone()),
        (
            1,
            f.review.integrity_hash().unwrap(),
            format!("0x{}", "00".repeat(65)),
        ),
    ] {
        assert!(
            f.store
                .stage_swap_permit(
                    &k,
                    StageSwapPermit {
                        user: f.user,
                        wallet: f.wallet,
                        operation: f.id,
                        expected_version: version,
                        review_hash: &hash,
                        signature: &signature,
                        nonce: Some(&observation(&f.review))
                    }
                )
                .await
                .is_err()
        );
    }
    assert!(stage(&f, &k, &sig, None).await.is_err());
    assert_eq!(count(&db, "swap_permit_signatures").await, 0);
    let mut no = setup(&db, Some(&f)).await;
    no.review.permit = None;
    persist(&no, &k).await;
    let built = no
        .store
        .load_swap_build(&k, no.user, no.wallet, no.id)
        .await
        .unwrap();
    assert!(built.signature.is_none());
    assert_eq!(
        no.store
            .get(no.user, no.wallet, no.id)
            .await
            .unwrap()
            .version,
        "1"
    );
    assert!(stage(&no, &k, &sig, None).await.is_err());
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn ciphertext_substitution_and_public_metadata_rehash_do_not_authenticate() {
    let db = TestDatabase::new().await;
    let f = setup(&db, None).await;
    let k = keys("old", 1);
    persist(&f, &k).await;
    stage(&f, &k, &sign(&f.review), Some(&observation(&f.review)))
        .await
        .unwrap();
    let other = setup(&db, Some(&f)).await;
    persist(&other, &k).await;
    assert!(
        sqlx::query("UPDATE swap_reviews SET key_id='bad'")
            .execute(&db.pool)
            .await
            .is_err()
    );
    sqlx::query("ALTER TABLE swap_reviews DISABLE TRIGGER immutable_swap_review")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE swap_reviews SET encryption_nonce=(SELECT encryption_nonce FROM swap_reviews WHERE operation_id=$1),ciphertext=(SELECT ciphertext FROM swap_reviews WHERE operation_id=$1) WHERE operation_id=$2").bind(f.id).bind(other.id).execute(&db.pool).await.unwrap();
    assert!(
        other
            .store
            .load_swap_review(&k, other.user, other.wallet, other.id)
            .await
            .is_err()
    );
    let mut public = serde_json::to_value(&f.review).unwrap();
    public["authority"]["minimumOutputRaw"] = json!("1");
    let public = serde_json::to_string(&public).unwrap();
    sqlx::query("UPDATE swap_reviews SET canonical_json=$2,review_hash=$3 WHERE operation_id=$1")
        .bind(f.id)
        .bind(&public)
        .bind(Sha256::digest(public.as_bytes()).as_slice())
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(
        f.store
            .load_swap_build(&k, f.user, f.wallet, f.id)
            .await
            .is_err()
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn expired_unused_nonce_requires_finalized_chain_watermark_before_reuse() {
    let db = TestDatabase::new().await;
    let mut f = setup(&db, None).await;
    let k = keys("old", 1);
    let deadline = (now() / 1000) + 3;
    f.review.expires_at_ms = deadline * 1000;
    f.review.authority.deadline = deadline.to_string();
    let p = f.review.permit.as_mut().unwrap();
    p.sig_deadline = deadline.to_string();
    p.expiration = deadline.to_string();
    persist(&f, &k).await;
    let sig = sign(&f.review);
    stage(&f, &k, &sig, Some(&observation(&f.review)))
        .await
        .unwrap();
    let guard: time::OffsetDateTime =
        sqlx::query_scalar("SELECT invalid_after FROM swap_permit_guards")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(guard.unix_timestamp(), deadline + 1);
    tokio::time::sleep(std::time::Duration::from_millis(
        ((deadline + 1) * 1000 - now() + 100) as u64,
    ))
    .await;
    assert!(
        f.store
            .load_swap_build(&k, f.user, f.wallet, f.id)
            .await
            .is_err()
    );
    assert!(
        f.store
            .load_swap_review(&k, f.user, f.wallet, f.id)
            .await
            .is_ok()
    );
    assert_eq!(stage(&f, &k, &sig, None).await.unwrap().version, "2");
    let second = setup(&db, Some(&f)).await;
    persist(&second, &k).await;
    let mut obs = observation(&second.review);
    let sig2 = sign(&second.review);
    // Server time passed; chain finality has not. Reuse must still fail.
    assert!(stage(&second, &k, &sig2, Some(&obs)).await.is_err());
    obs.finalized_block_timestamp = (deadline + 1) as u64;
    stage(&second, &k, &sig2, Some(&obs)).await.unwrap();
    assert_eq!(count(&db, "swap_permit_signatures").await, 2);
    assert_eq!(count(&db, "swap_permit_guards").await, 1);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn stale_worker_and_nonce_observation_after_lock_wait_cannot_commit() {
    let db = TestDatabase::new().await;
    let k = keys("old", 1);
    let f = setup(&db, None).await;
    let stale = JobLease {
        token: Uuid::new_v4(),
        ..f.lease
    };
    assert!(
        f.store
            .persist_swap_review(&k, &stale, &f.review, &f.quote)
            .await
            .is_err()
    );
    assert_eq!(count(&db, "swap_reviews").await, 0);
    persist(&f, &k).await;
    stage(&f, &k, &sign(&f.review), Some(&observation(&f.review)))
        .await
        .unwrap();
    let next = setup(&db, Some(&f)).await;
    persist(&next, &k).await;
    // Model a historical guard and hold its row lock until a previously fresh
    // observation expires. No lock is held across RPC in production code.
    let mut blocker = db.pool.begin().await.unwrap();
    sqlx::query("UPDATE swap_permit_guards SET invalid_after=to_timestamp(1)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let mut obs = observation(&next.review);
    obs.observed_at_ms = now() - 9500;
    let signature = sign(&next.review);
    let (result, ()) = tokio::join!(stage(&next, &k, &signature, Some(&obs)), async {
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        blocker.commit().await.unwrap();
    });
    assert!(matches!(result, Err(AppError::Conflict(_))));
    assert_eq!(count(&db, "swap_permit_signatures").await, 1);
    assert_eq!(
        next.store
            .get(next.user, next.wallet, next.id)
            .await
            .unwrap()
            .version,
        "1"
    );
    let reserved: Uuid = sqlx::query_scalar("SELECT operation_id FROM swap_permit_guards")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(reserved, f.id);
    db.close().await;
}
