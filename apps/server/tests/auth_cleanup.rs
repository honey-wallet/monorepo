//! Run against disposable Postgres; exercises the supervised cleanup query and
//! its cross-replica lock with real foreign keys and replay-protection rows.

mod common;

use common::TestDatabase;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL; creates and drops a fresh test database"]
async fn concurrent_cleanup_is_bounded_and_preserves_live_auth_and_replay_state() {
    let db = TestDatabase::new().await;

    let expired_user = Uuid::new_v4();
    let expired_wallet = Uuid::new_v4();
    let expired_family = Uuid::new_v4();
    let expired_device = Uuid::new_v4();
    let expired_session = [0x11_u8; 32];
    sqlx::query("INSERT INTO users(id) VALUES ($1)")
        .bind(expired_user)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,1,$3,'eoa')")
        .bind(expired_wallet)
        .bind(expired_user)
        .bind([0x22_u8; 20].as_slice())
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO auth_refresh_families(id,user_id,wallet_id,device_id,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp()-interval '2 days')")
        .bind(expired_family)
        .bind(expired_user)
        .bind(expired_wallet)
        .bind(expired_device)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,wallet_id,refresh_family_id,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp()-interval '2 days')")
        .bind(expired_session.as_slice())
        .bind(expired_user)
        .bind(expired_wallet)
        .bind(expired_family)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO auth_refresh_tokens(token_hash,family_id) SELECT decode(lpad(to_hex(n),64,'0'),'hex'),$1 FROM generate_series(1,5001) AS n",
    )
    .bind(expired_family)
    .execute(&db.pool)
    .await
    .unwrap();
    let expired_challenge = Uuid::new_v4();
    sqlx::query("INSERT INTO auth_challenges(id,message,expires_at) VALUES ($1,'expired challenge',clock_timestamp()-interval '2 days')")
        .bind(expired_challenge)
        .execute(&db.pool)
        .await
        .unwrap();

    let active_user = Uuid::new_v4();
    let active_wallet = Uuid::new_v4();
    let active_family = Uuid::new_v4();
    let active_device = Uuid::new_v4();
    let active_session = [0x33_u8; 32];
    sqlx::query("INSERT INTO users(id) VALUES ($1)")
        .bind(active_user)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,1,$3,'eoa')")
        .bind(active_wallet)
        .bind(active_user)
        .bind([0x44_u8; 20].as_slice())
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO auth_refresh_families(id,user_id,wallet_id,device_id,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp()+interval '30 days')")
        .bind(active_family)
        .bind(active_user)
        .bind(active_wallet)
        .bind(active_device)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO auth_sessions(token_hash,user_id,wallet_id,refresh_family_id,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 hour')")
        .bind(active_session.as_slice())
        .bind(active_user)
        .bind(active_wallet)
        .bind(active_family)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO auth_refresh_tokens(token_hash,family_id) VALUES ($1,$2)")
        .bind([0x55_u8; 32].as_slice())
        .bind(active_family)
        .execute(&db.pool)
        .await
        .unwrap();
    let active_challenge = Uuid::new_v4();
    sqlx::query("INSERT INTO auth_challenges(id,message,expires_at) VALUES ($1,'active challenge',clock_timestamp()+interval '1 hour')")
        .bind(active_challenge)
        .execute(&db.pool)
        .await
        .unwrap();
    let active_link_challenge = Uuid::new_v4();
    sqlx::query("INSERT INTO wallet_link_challenges(id,user_id,session_hash,message,expires_at) VALUES ($1,$2,$3,'active wallet link',clock_timestamp()+interval '1 hour')")
        .bind(active_link_challenge)
        .bind(active_user)
        .bind(active_session.as_slice())
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO auth_rate_limits(subject_hash,window_start,attempts) VALUES ($1,date_trunc('minute',clock_timestamp()),1)")
        .bind([0x66_u8; 32].as_slice())
        .execute(&db.pool)
        .await
        .unwrap();

    // These calls model independent process replicas. One may skip immediately
    // while the other owns the transaction-scoped cleaner lock.
    let (first, second) = tokio::join!(
        honey_server::database::prune_auth(&db.pool),
        honey_server::database::prune_auth(&db.pool)
    );
    first.unwrap();
    second.unwrap();

    // A refresh family with > one deletion batch remains until its last spent
    // token is removed; repeated bounded runs eventually finish the cleanup.
    for _ in 0..3 {
        let remaining: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM auth_refresh_families WHERE id=$1)")
                .bind(expired_family)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        if !remaining {
            break;
        }
        honey_server::database::prune_auth(&db.pool).await.unwrap();
    }

    let expired_rows: (bool, bool, i64) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM auth_challenges WHERE id=$1), EXISTS(SELECT 1 FROM auth_refresh_families WHERE id=$2), (SELECT count(*) FROM auth_refresh_tokens WHERE family_id=$2)",
    )
    .bind(expired_challenge)
    .bind(expired_family)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(expired_rows, (false, false, 0));

    let active_rows: (bool, bool, bool, bool, bool) = sqlx::query_as(
        "SELECT EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND expires_at > clock_timestamp()), EXISTS(SELECT 1 FROM auth_refresh_families WHERE id=$2 AND expires_at > clock_timestamp()), EXISTS(SELECT 1 FROM auth_refresh_tokens WHERE token_hash=$3), EXISTS(SELECT 1 FROM auth_challenges WHERE id=$4 AND expires_at > clock_timestamp()), EXISTS(SELECT 1 FROM wallet_link_challenges WHERE id=$5 AND expires_at > clock_timestamp())",
    )
    .bind(active_session.as_slice())
    .bind(active_family)
    .bind([0x55_u8; 32].as_slice())
    .bind(active_challenge)
    .bind(active_link_challenge)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(active_rows, (true, true, true, true, true));
    let active_rate_limit: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM auth_rate_limits WHERE subject_hash=$1 AND window_start >= date_trunc('minute',clock_timestamp()))",
    )
    .bind([0x66_u8; 32].as_slice())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(active_rate_limit);

    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL; creates and drops a fresh test database"]
async fn cleanup_drains_large_expired_quota_backlog_and_preserves_current_state() {
    let db = TestDatabase::new().await;
    sqlx::query(
        "INSERT INTO auth_rate_limits(subject_hash,window_start,attempts)
         SELECT decode(lpad(to_hex(n),64,'0'),'hex'),
                date_trunc('minute',clock_timestamp() - interval '2 days'), 1
         FROM generate_series(1,50001) AS n",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO auth_challenges(id,message,expires_at)
         SELECT md5('expired-' || n::text)::uuid, 'expired test challenge',
                clock_timestamp() - interval '2 days'
         FROM generate_series(1,5001) AS n",
    )
    .execute(&db.pool)
    .await
    .unwrap();

    let live_challenge = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO auth_challenges(id,message,expires_at)
         VALUES ($1,'live test challenge',clock_timestamp() + interval '1 hour')",
    )
    .bind(live_challenge)
    .execute(&db.pool)
    .await
    .unwrap();
    let live_subject = [0xa7_u8; 32];
    sqlx::query(
        "INSERT INTO auth_rate_limits(subject_hash,window_start,attempts)
         VALUES ($1,date_trunc('minute',clock_timestamp()),1)",
    )
    .bind(live_subject.as_slice())
    .execute(&db.pool)
    .await
    .unwrap();

    let first_deleted = honey_server::database::prune_auth(&db.pool).await.unwrap();
    assert!(
        first_deleted <= 105_000,
        "cleanup exceeded its per-table bounds"
    );
    let after_first: (i64, i64) = sqlx::query_as(
        "SELECT
            (SELECT count(*) FROM auth_rate_limits WHERE window_start < clock_timestamp()-interval '1 day'),
            (SELECT count(*) FROM auth_challenges WHERE expires_at < clock_timestamp()-interval '1 day')",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        after_first,
        (1, 1),
        "first bounded batch should leave one row per backlog"
    );

    honey_server::database::prune_auth(&db.pool).await.unwrap();
    let remaining_expired: (i64, i64) = sqlx::query_as(
        "SELECT
            (SELECT count(*) FROM auth_rate_limits WHERE window_start < clock_timestamp()-interval '1 day'),
            (SELECT count(*) FROM auth_challenges WHERE expires_at < clock_timestamp()-interval '1 day')",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(remaining_expired, (0, 0));
    let retained: (bool, bool) = sqlx::query_as(
        "SELECT
            EXISTS(SELECT 1 FROM auth_challenges WHERE id=$1 AND expires_at > clock_timestamp()),
            EXISTS(SELECT 1 FROM auth_rate_limits WHERE subject_hash=$2 AND window_start >= date_trunc('minute',clock_timestamp()))",
    )
    .bind(live_challenge)
    .bind(live_subject.as_slice())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(retained, (true, true));
    db.close().await;
}
