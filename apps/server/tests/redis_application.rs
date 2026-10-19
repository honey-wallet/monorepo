//! Isolated Redis namespaces; never FLUSHDB or mutate another application's keys.
use std::time::Duration;

use honey_server::{error::AppError, pairing_store::PairingStore, redis_store::RedisStore};
use sha2::Digest;
use uuid::Uuid;

fn store(namespace: &str) -> RedisStore {
    RedisStore::new(
        redis::Client::open(std::env::var("TEST_REDIS_URL").expect("set isolated TEST_REDIS_URL"))
            .unwrap(),
        namespace.into(),
        Duration::from_secs(1),
    )
}

async fn cleanup(redis: &RedisStore) {
    // Scan only the random namespace owned by this test. No shared database flush.
    let mut cursor = 0u64;
    loop {
        let (next, keys): (u64, Vec<String>) = redis
            .query(
                redis::cmd("SCAN")
                    .arg(cursor)
                    .arg("MATCH")
                    .arg(redis.key("pairing", "*"))
                    .arg("COUNT")
                    .arg(100),
            )
            .await
            .unwrap();
        if !keys.is_empty() {
            let _: i32 = redis.query(redis::cmd("DEL").arg(keys)).await.unwrap();
        }
        if next == 0 {
            break;
        }
        cursor = next;
    }
}

async fn cleanup_domain(redis: &RedisStore, domain: &str) {
    let mut cursor = 0u64;
    loop {
        let (next, keys): (u64, Vec<String>) = redis
            .query(
                redis::cmd("SCAN")
                    .arg(cursor)
                    .arg("MATCH")
                    .arg(redis.key(domain, "*"))
                    .arg("COUNT")
                    .arg(100),
            )
            .await
            .unwrap();
        if !keys.is_empty() {
            let _: i32 = redis.query(redis::cmd("DEL").arg(keys)).await.unwrap();
        }
        if next == 0 {
            break;
        }
        cursor = next;
    }
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn paired_quota_is_atomic_and_enforces_exact_global_and_subject_limits() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let a = store(&namespace);
    let b = store(&namespace);

    // A subject denial must not consume the global bucket: a different subject
    // still gets the second global slot. Each store owns a distinct connection.
    a.rate_limit_pair("quota_test", "alice@example.invalid", 2, 1)
        .await
        .unwrap();
    assert!(matches!(
        b.rate_limit_pair("quota_test", "alice@example.invalid", 2, 1)
            .await,
        Err(AppError::TooManyRequests)
    ));
    b.rate_limit_pair("quota_test", "bob@example.invalid", 2, 1)
        .await
        .unwrap();
    assert!(matches!(
        a.rate_limit_pair("quota_test", "carol@example.invalid", 2, 1)
            .await,
        Err(AppError::TooManyRequests)
    ));
    cleanup_domain(&a, "quota_test").await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn paired_quota_is_atomic_under_concurrent_independent_connections() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let mut jobs = Vec::new();
    for i in 0..32 {
        let redis = store(&namespace);
        jobs.push(tokio::spawn(async move {
            redis
                .rate_limit_pair("quota_race", &format!("subject-{i}"), 7, 2)
                .await
        }));
    }
    let mut accepted = 0;
    for job in jobs {
        if job.await.unwrap().is_ok() {
            accepted += 1;
        }
    }
    assert_eq!(accepted, 7, "the global bucket must admit exactly seven");
    let redis = store(&namespace);
    cleanup_domain(&redis, "quota_race").await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn pairing_poll_quota_is_shared_by_client_across_channels() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let a = PairingStore::new(store(&namespace));
    let b = PairingStore::new(store(&namespace));
    // Model distinct, caller-controlled channels from the same resolved client IP.
    let subject = hex::encode(sha2::Sha256::digest("192.0.2.10"));

    for _ in 0..120 {
        a.admit_receive(&subject).await.unwrap();
    }
    let another_channel_same_client = hex::encode(sha2::Sha256::digest("192.0.2.10"));
    assert!(matches!(
        b.admit_receive(&another_channel_same_client).await,
        Err(AppError::TooManyRequests)
    ));
    let another_client = hex::encode(sha2::Sha256::digest("192.0.2.11"));
    b.admit_receive(&another_client).await.unwrap();
    cleanup_domain(&store(&namespace), "pairing_poll").await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn polymarket_cache_publish_is_fenced_by_refresh_owner_and_expiry() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = store(&namespace);
    let lock = redis.key("polymarket", "refresh-lock");
    let cache = redis.key("polymarket", "cache");
    let script = include_str!("../src/scripts/polymarket_cache_publish.lua");

    let _: String = redis
        .query(
            redis::cmd("SET")
                .arg(&lock)
                .arg("owner-one")
                .arg("PX")
                .arg(60_000)
                .arg("NX"),
        )
        .await
        .unwrap();
    let publish = |owner: &'static str, value: &'static str| {
        let mut cmd = redis::cmd("EVAL");
        cmd.arg(script)
            .arg(2)
            .arg(&lock)
            .arg(&cache)
            .arg(owner)
            .arg(value)
            .arg(300);
        cmd
    };
    assert_eq!(
        redis
            .query::<i32>(&mut publish("owner-one", "first"))
            .await
            .unwrap(),
        1
    );

    // A replacement owner represents an expired/taken-over lease. The old
    // worker may finish late, but cannot overwrite the new cache value.
    let _: String = redis
        .query(
            redis::cmd("SET")
                .arg(&lock)
                .arg("owner-two")
                .arg("PX")
                .arg(60_000),
        )
        .await
        .unwrap();
    assert_eq!(
        redis
            .query::<i32>(&mut publish("owner-one", "stale"))
            .await
            .unwrap(),
        0
    );
    let cached: String = redis.query(redis::cmd("GET").arg(&cache)).await.unwrap();
    assert_eq!(cached, "first");
    assert_eq!(
        redis
            .query::<i32>(&mut publish("owner-two", "second"))
            .await
            .unwrap(),
        1
    );

    let _: i32 = redis.query(redis::cmd("DEL").arg(&lock)).await.unwrap();
    assert_eq!(
        redis
            .query::<i32>(&mut publish("owner-two", "after-expiry"))
            .await
            .unwrap(),
        0
    );
    let cached: String = redis.query(redis::cmd("GET").arg(&cache)).await.unwrap();
    assert_eq!(cached, "second");
    cleanup_domain(&redis, "polymarket").await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn subject_quota_is_shared_and_expires_without_persisting_raw_subjects() {
    use sha2::{Digest, Sha256};

    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let a = store(&namespace);
    let b = store(&namespace);
    let subject = "203.0.113.7";
    a.rate_limit_subject("identity_test", subject, 1)
        .await
        .unwrap();
    assert!(matches!(
        b.rate_limit_subject("identity_test", subject, 1).await,
        Err(AppError::TooManyRequests)
    ));

    let digest = hex::encode(Sha256::digest(subject.as_bytes()));
    let key = a.key("identity_test", &format!("quota:subject:{digest}"));
    let ttl_ms: i64 = a.query(redis::cmd("PTTL").arg(&key)).await.unwrap();
    assert!(ttl_ms > 0 && ttl_ms <= 61_000);
    assert!(!key.contains(subject));
    cleanup_domain(&a, "identity_test").await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn pairing_is_write_once_and_read_once_across_independent_connections() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = store(&namespace);
    let a = PairingStore::new(redis.clone());
    let b = PairingStore::new(store(&namespace));
    let (a_result, b_result) = tokio::join!(
        a.send("channel", "commit", "ip", "ciphertext-a"),
        b.send("channel", "commit", "ip", "ciphertext-b")
    );
    assert_eq!(
        usize::from(a_result.is_ok()) + usize::from(b_result.is_ok()),
        1
    );
    let (a_result, b_result) = tokio::join!(
        a.receive("channel", "commit"),
        b.receive("channel", "commit")
    );
    assert_eq!(
        usize::from(a_result.is_ok()) + usize::from(b_result.is_ok()),
        1
    );
    assert!(matches!(
        b.send("channel", "commit", "other-ip", "replacement").await,
        Err(AppError::Conflict(_))
    ));
    let ttl_before: i64 = redis
        .query(redis::cmd("PTTL").arg(redis.key("pairing", "channel:channel")))
        .await
        .unwrap();
    assert!(matches!(
        a.receive("channel", "commit").await,
        Err(AppError::NotFound)
    ));
    let ttl_after: i64 = redis
        .query(redis::cmd("PTTL").arg(redis.key("pairing", "channel:channel")))
        .await
        .unwrap();
    assert!(ttl_after <= ttl_before && ttl_after > 0);
    cleanup(&redis).await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn pairing_slots_share_expiry_and_consumed_slots_still_count_against_quota() {
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = store(&namespace);
    let a = PairingStore::new(redis.clone());
    for n in 0..24 {
        a.send(&format!("channel{n}"), "commit", "ip", "public-commitment")
            .await
            .unwrap();
        a.receive(&format!("channel{n}"), "commit").await.unwrap();
    }
    assert!(matches!(
        a.send("excess", "commit", "ip", "data").await,
        Err(AppError::TooManyRequests)
    ));
    let first: String = redis
        .query(
            redis::cmd("HGET")
                .arg(redis.key("pairing", "channel:channel0"))
                .arg("_expires"),
        )
        .await
        .unwrap();
    a.send("channel0", "nonce", "another-ip", "nonce")
        .await
        .unwrap();
    let second: String = redis
        .query(
            redis::cmd("HGET")
                .arg(redis.key("pairing", "channel:channel0"))
                .arg("_expires"),
        )
        .await
        .unwrap();
    assert_eq!(first, second);
    let _: i32 = redis
        .query(
            redis::cmd("PEXPIRE")
                .arg(redis.key("pairing", "channel:channel0"))
                .arg(1),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert!(matches!(
        a.receive("channel0", "nonce").await,
        Err(AppError::NotFound)
    ));
    cleanup(&redis).await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn pairing_enforces_atomic_global_payload_byte_budget() {
    const MAX_BYTES: usize = 32 * 1024 * 1024;
    const PAYLOAD_BYTES: usize = 16 * 1024;
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = store(&namespace);
    let pairing = PairingStore::new(redis.clone());
    let data = "x".repeat(PAYLOAD_BYTES);

    // A subject has a 24-slot cap, so rotate bounded synthetic subjects while
    // independent tasks contend on the same global byte reservation in Lua.
    let mut accepted = 0;
    let mut denied = 0;
    // RedisStore deliberately rejects commands when all 128 local permits are
    // occupied. Keep each concurrent wave below that transport limit so this
    // assertion measures the Lua byte reservation rather than client overload.
    // The last wave still races for the exact remaining global capacity.
    for start in (0..=MAX_BYTES / PAYLOAD_BYTES).step_by(64) {
        let end = (start + 64).min(MAX_BYTES / PAYLOAD_BYTES + 1);
        let mut writes = Vec::with_capacity(end - start);
        for index in start..end {
            let pairing = pairing.clone();
            let data = data.clone();
            writes.push(tokio::spawn(async move {
                pairing
                    .send(
                        &format!("channel-{index}"),
                        "payload",
                        &format!("subject-{}", index / 24),
                        &data,
                    )
                    .await
            }));
        }
        for write in writes {
            match write.await.unwrap() {
                Ok(()) => accepted += 1,
                Err(AppError::Busy) => denied += 1,
                Err(error) => panic!("unexpected pairing write result: {error:?}"),
            }
        }
    }
    assert_eq!(accepted, MAX_BYTES / PAYLOAD_BYTES);
    assert_eq!(denied, 1);
    let reserved: usize = redis
        .query(redis::cmd("GET").arg(redis.key("pairing", "global_bytes")))
        .await
        .unwrap();
    assert_eq!(reserved, MAX_BYTES);
    assert!(matches!(
        pairing
            .send("over-budget", "nonce", "new-subject", "n")
            .await,
        Err(AppError::Busy)
    ));
    let still_reserved: usize = redis
        .query(redis::cmd("GET").arg(redis.key("pairing", "global_bytes")))
        .await
        .unwrap();
    assert_eq!(
        still_reserved, MAX_BYTES,
        "denied writes do not reserve bytes"
    );
    cleanup(&redis).await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn pairing_rollout_reserves_legacy_slots_at_maximum_payload_size() {
    const MAX_BYTES: usize = 32 * 1024 * 1024;
    const MAX_SLOT_BYTES: usize = 16 * 1024;
    let namespace = format!("test:{}", Uuid::new_v4().simple());
    let redis = store(&namespace);
    let reservations = redis.key("pairing", "global");
    let mut command = redis::cmd("ZADD");
    command.arg(&reservations);
    for index in 0..(MAX_BYTES / MAX_SLOT_BYTES) {
        command
            .arg(4_000_000_000_000i64)
            .arg(format!("legacy-{index}"));
    }
    let _: usize = redis.query(&mut command).await.unwrap();

    // No byte counter/metadata exists, as with a live pre-upgrade namespace. The
    // migration estimate reaches the limit, so a small new slot is denied.
    let pairing = PairingStore::new(redis.clone());
    assert!(matches!(
        pairing.send("new-channel", "nonce", "subject", "n").await,
        Err(AppError::Busy)
    ));
    let estimated: usize = redis
        .query(redis::cmd("GET").arg(redis.key("pairing", "global_bytes")))
        .await
        .unwrap();
    assert_eq!(estimated, MAX_BYTES);
    cleanup(&redis).await;
}

#[tokio::test]
#[ignore = "requires loopback sockets"]
async fn unavailable_redis_never_creates_a_local_pairing_mailbox() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    // An occupied port that never speaks RESP deterministically exercises deadline.
    let redis = RedisStore::new(
        redis::Client::open(format!("redis://{address}")).unwrap(),
        "unavailable".into(),
        Duration::from_millis(50),
    );
    let store = PairingStore::new(redis);
    assert!(matches!(
        store.send("channel", "commit", "ip", "data").await,
        Err(AppError::Busy)
    ));
    assert!(matches!(
        store.receive("channel", "commit").await,
        Err(AppError::Busy)
    ));
}
