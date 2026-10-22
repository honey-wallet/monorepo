//! Real PostgreSQL races, rollback and fencing. Explicitly run with --ignored.
mod common;

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use common::TestDatabase;
use honey_server::{
    config::AuthConfig,
    error::AppError,
    identity::{
        Challenge, ChallengeRequest, Identity, LinkWalletChallengeRequest, LinkWalletRequest,
        RefreshRequest, VerifyRequest,
    },
    routes,
    work::{Action, JobFailure, NewOperation, OperationState, Topic, WorkStore},
};
use k256::ecdsa::SigningKey;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

const ADDRESS: &str = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

fn identity(db: &TestDatabase) -> Identity {
    Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![format!("chrome-extension://{}", "a".repeat(32))],
            chain_id: 1,
        },
    )
    .unwrap()
}

async fn challenge(identity: &Identity) -> Challenge {
    identity
        .challenge(ChallengeRequest {
            address: ADDRESS.into(),
            chain_id: "eip155:1".into(),
        })
        .await
        .unwrap()
}

fn signature(message: &str, key_byte: u8) -> String {
    let mut bytes = [0u8; 32];
    bytes[31] = key_byte;
    let key = SigningKey::from_bytes((&bytes).into()).unwrap();
    let message: siwe::Message = message.parse().unwrap();
    let (signature, recovery) = key
        .sign_prehash_recoverable(&message.eip191_hash().unwrap())
        .unwrap();
    let mut result = signature.to_bytes().to_vec();
    result.push(recovery.to_byte() + 27);
    format!("0x{}", hex::encode(result))
}

fn address_for_key(key_byte: u8) -> String {
    let mut bytes = [0u8; 32];
    bytes[31] = key_byte;
    let key = SigningKey::from_bytes((&bytes).into()).unwrap();
    let public = key.verifying_key().to_encoded_point(false);
    let hash = alloy_primitives::keccak256(&public.as_bytes()[1..]);
    let address: [u8; 20] = hash.as_slice()[12..].try_into().unwrap();
    siwe::eip55(&address)
}

fn proof(challenge: &Challenge) -> VerifyRequest {
    VerifyRequest {
        challenge_id: challenge.id,
        signature: signature(&challenge.message, 1),
        device_id: Uuid::from_u128(1),
    }
}

async fn session(identity: &Identity) -> honey_server::identity::AuthenticatedSession {
    identity
        .verify(proof(&challenge(identity).await), true)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL; creates and drops a fresh test database"]
async fn proof_replay_race_has_one_winner_and_sessions_are_revocable_across_instances() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let c = challenge(&identity).await;
    assert!(matches!(
        identity
            .verify(
                VerifyRequest {
                    challenge_id: c.id,
                    signature: signature(&c.message, 2),
                    device_id: Uuid::from_u128(1),
                },
                true
            )
            .await,
        Err(AppError::Unauthorized)
    ));
    let (left, right) = tokio::join!(
        identity.verify(proof(&c), true),
        identity.verify(proof(&c), true)
    );
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    let winner = left.ok().or(right.ok()).unwrap();
    assert_eq!(winner.profile.wallet.address, ADDRESS);
    let restarted = Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        },
    )
    .unwrap();
    assert_eq!(
        restarted
            .authenticate(&winner.access_token)
            .await
            .unwrap()
            .user_id,
        winner.profile.user_id
    );
    let stored: Vec<u8> = sqlx::query_scalar("SELECT token_hash FROM auth_sessions")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(stored.len(), 32);
    assert_ne!(hex::encode(stored), winner.access_token);
    restarted.logout(&winner.access_token).await.unwrap();
    restarted.logout(&winner.access_token).await.unwrap();
    assert!(matches!(
        identity.authenticate(&winner.access_token).await,
        Err(AppError::Unauthorized)
    ));
    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM identity_events WHERE kind = 'signed_out'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(events, 1);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL; creates and drops a fresh test database"]
async fn refresh_rotation_is_device_bound_and_replay_revokes_the_family() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let signed_in = session(&identity).await;
    let device_id = signed_in.device_id;
    let original_refresh = signed_in.refresh_token.clone().unwrap();
    assert!(matches!(
        identity
            .refresh(RefreshRequest {
                refresh_token: original_refresh.clone(),
                device_id: Uuid::from_u128(2),
            })
            .await,
        Err(AppError::Unauthorized)
    ));
    let rotated = identity
        .refresh(RefreshRequest {
            refresh_token: original_refresh.clone(),
            device_id,
        })
        .await
        .unwrap();
    assert_ne!(
        rotated.refresh_token.as_deref(),
        Some(original_refresh.as_str())
    );
    assert!(
        identity
            .authenticate(&signed_in.access_token)
            .await
            .is_err()
    );
    assert!(identity.authenticate(&rotated.access_token).await.is_ok());
    assert!(matches!(
        identity
            .refresh(RefreshRequest {
                refresh_token: original_refresh,
                device_id,
            })
            .await,
        Err(AppError::Unauthorized)
    ));
    assert!(identity.authenticate(&rotated.access_token).await.is_err());
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn queue_metrics_snapshot_reports_capped_states_and_oldest_ages() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let session = session(&identity).await;
    let work = WorkStore::new(db.pool.clone());
    let mut operations = Vec::new();
    for key in ["queue-ready", "queue-expired", "queue-dead"] {
        operations.push(
            work.create(NewOperation {
                user_id: session.profile.user_id,
                wallet_id: session.profile.wallet.id,
                action: Action::Swap,
                idempotency_key: key,
                intent: &json!({"amount": "1"}),
            })
            .await
            .unwrap(),
        );
    }
    let job_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM jobs WHERE operation_id = ANY($1) ORDER BY created_at, id",
    )
    .bind(operations.iter().map(|op| op.id).collect::<Vec<_>>())
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(job_ids.len(), 3);
    let expired_token = Uuid::new_v4();
    sqlx::query(
        "UPDATE jobs SET state = 'leased', lease_token = $2,
         lease_until = clock_timestamp() - interval '5 seconds' WHERE id = $1",
    )
    .bind(job_ids[1])
    .bind(expired_token)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE jobs SET state = 'dead', created_at = clock_timestamp() - interval '20 seconds',
         finished_at = clock_timestamp() - interval '20 seconds',
         last_error_code = 'invalid_response' WHERE id = $1",
    )
    .bind(job_ids[2])
    .execute(&db.pool)
    .await
    .unwrap();

    let snapshot = work.metrics_snapshot().await.unwrap();
    assert_eq!(snapshot.ready, 1);
    assert_eq!(snapshot.leased, 1);
    assert_eq!(snapshot.expired_lease, 1);
    assert_eq!(snapshot.dead, 1);
    assert!(snapshot.oldest_ready_age_seconds.is_some());
    assert!(snapshot.oldest_expired_lease_age_seconds.unwrap() >= 5);
    assert!(snapshot.oldest_dead_age_seconds.unwrap() >= 20);
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn dead_letter_inspection_is_bounded_read_only_and_keyset_paginated() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let session = session(&identity).await;
    let work = WorkStore::new(db.pool.clone());
    let mut operations = Vec::new();
    for key in ["dead-page-old", "dead-page-middle", "dead-page-new"] {
        operations.push(
            work.create(NewOperation {
                user_id: session.profile.user_id,
                wallet_id: session.profile.wallet.id,
                action: Action::Swap,
                idempotency_key: key,
                intent: &json!({"amount": "must-not-be-returned"}),
            })
            .await
            .unwrap(),
        );
    }
    let job_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM jobs WHERE operation_id = ANY($1) ORDER BY created_at, id",
    )
    .bind(operations.iter().map(|op| op.id).collect::<Vec<_>>())
    .fetch_all(&db.pool)
    .await
    .unwrap();
    for (id, age_seconds) in job_ids.iter().zip([30.0_f64, 20.0, 10.0]) {
        sqlx::query(
            "UPDATE jobs SET state = 'dead', attempts = 8, last_error_code = 'invalid_response',
             created_at = clock_timestamp() - make_interval(secs => $2),
             finished_at = clock_timestamp() - make_interval(secs => $2) WHERE id = $1",
        )
        .bind(id)
        .bind(age_seconds)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    let first = work.dead_letters(2, None).await.unwrap();
    assert_eq!(first.items.len(), 2);
    assert_eq!(first.items[0].id, job_ids[2]);
    assert_eq!(first.items[1].id, job_ids[1]);
    assert_eq!(first.items[0].topic, "operation.created");
    assert_eq!(first.items[0].attempts, 8);
    let serialized = serde_json::to_string(&first).unwrap();
    assert!(!serialized.contains("must-not-be-returned"));
    let next_before = first.next_before.unwrap();

    let second = work.dead_letters(2, Some(next_before)).await.unwrap();
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].id, job_ids[0]);
    assert!(second.next_before.is_none());
    assert!(matches!(
        work.dead_letters(2, Some(Uuid::new_v4())).await,
        Err(AppError::BadRequest(_))
    ));
    assert!(matches!(
        work.dead_letters(101, None).await,
        Err(AppError::BadRequest(_))
    ));

    let state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id = $1")
        .bind(job_ids[0])
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(state, "dead");
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn concurrent_distinct_proofs_create_one_identity_and_expiry_fails_closed() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let a = challenge(&identity).await;
    let b = challenge(&identity).await;
    let (a, b) = tokio::join!(
        identity.verify(proof(&a), true),
        identity.verify(proof(&b), true)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.profile.user_id, b.profile.user_id);
    assert_eq!(a.profile.wallet.id, b.profile.wallet.id);
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(users, 1);
    identity.logout(&a.access_token).await.unwrap();
    assert!(identity.authenticate(&b.access_token).await.is_ok());
    sqlx::query("UPDATE auth_sessions SET expires_at = clock_timestamp() - interval '1 second'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        identity.authenticate(&b.access_token).await,
        Err(AppError::Unauthorized)
    ));
    let c = challenge(&identity).await;
    sqlx::query("UPDATE auth_challenges SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1").bind(c.id).execute(&db.pool).await.unwrap();
    assert!(matches!(
        identity.verify(proof(&c), true).await,
        Err(AppError::Unauthorized)
    ));
    let c = challenge(&identity).await;
    let other_origin = Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "https://other.example".into(),
            additional_origins: vec![],
            chain_id: 1,
        },
    )
    .unwrap();
    assert!(matches!(
        other_origin.verify(proof(&c), true).await,
        Err(AppError::Unauthorized)
    ));
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn authentication_http_contract_rejects_private_keys_and_honors_bearer() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let app = routes::identity::router(Some(identity), false);
    let bad_config = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/config")
                .header("origin", "https://attacker.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad_config.status(), StatusCode::UNAUTHORIZED);
    let native_config = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/config")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(native_config.status(), StatusCode::OK);
    let native_config: Value = serde_json::from_slice(
        &axum::body::to_bytes(native_config.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(native_config["origin"], "http://localhost:5173");
    let request = |path: &str, body: Value| {
        let mut r = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        r.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ));
        r
    };
    let bad = app
        .clone()
        .oneshot(request(
            "/auth/challenges",
            json!({"address": ADDRESS, "chainId": "eip155:1", "privateKey": "never accepted"}),
        ))
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    let response = app
        .clone()
        .oneshot(request(
            "/auth/challenges",
            json!({"address": ADDRESS, "chainId": "eip155:1"}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let challenge: Value = serde_json::from_slice(&bytes).unwrap();
    let login_signature = signature(challenge["message"].as_str().unwrap(), 1);
    let device_id = Uuid::from_u128(7);
    let response = app
        .clone()
        .oneshot(request(
            "/auth/verify",
            json!({"challengeId": challenge["id"], "signature": login_signature, "deviceId": device_id}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    let token = value["accessToken"].as_str().unwrap();
    assert!(value["refreshToken"].as_str().is_some());
    let wallets = app
        .clone()
        .oneshot({
            let mut request = Request::builder()
                .uri("/me/wallets")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap();
            request.extensions_mut().insert(ConnectInfo(
                "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
            ));
            request
        })
        .await
        .unwrap();
    assert_eq!(wallets.status(), StatusCode::OK);
    let link_challenge = app
        .clone()
        .oneshot({
            let mut request = Request::builder()
                .method("POST")
                .uri("/me/wallets/challenges")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"address": ADDRESS}).to_string()))
                .unwrap();
            request.extensions_mut().insert(ConnectInfo(
                "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
            ));
            request
        })
        .await
        .unwrap();
    assert_eq!(link_challenge.status(), StatusCode::OK);
    let link_challenge: Value = serde_json::from_slice(
        &axum::body::to_bytes(link_challenge.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    let link_response = app.clone().oneshot({
        let mut request = Request::builder()
            .method("POST").uri("/me/wallets")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(json!({"challengeId": link_challenge["id"], "signature": signature(link_challenge["message"].as_str().unwrap(), 1)}).to_string())).unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ));
        request
    }).await.unwrap();
    assert_eq!(link_response.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot({
            let mut request = Request::builder()
                .uri("/me")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap();
            request.extensions_mut().insert(ConnectInfo(
                "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
            ));
            request
        })
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot({
            let mut request = Request::builder().uri("/me").body(Body::empty()).unwrap();
            request.extensions_mut().insert(ConnectInfo(
                "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
            ));
            request
        })
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = app
        .clone()
        .oneshot({
            let mut request = Request::builder()
                .method("DELETE")
                .uri("/auth/session")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap();
            request.extensions_mut().insert(ConnectInfo(
                "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
            ));
            request
        })
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let response = app
        .clone()
        .oneshot(request(
            "/auth/challenges",
            json!({"address": ADDRESS, "chainId": "eip155:1"}),
        ))
        .await
        .unwrap();
    let challenge: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    let browser_signature = signature(challenge["message"].as_str().unwrap(), 1);
    let mut browser_verify = Request::builder()
        .method("POST").uri("/auth/verify")
        .header("content-type", "application/json")
        .header("origin", "http://localhost:5173")
        .body(Body::from(json!({"challengeId": challenge["id"], "signature": browser_signature, "deviceId": Uuid::from_u128(8)}).to_string()))
        .unwrap();
    browser_verify.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = app.clone().oneshot(browser_verify).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let browser_session: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(browser_session["refreshToken"].is_null());

    // The packaged extension is also an origin-bearing client. Its exact origin
    // gets short-lived access only; it cannot use the native refresh endpoint.
    let extension_origin = format!("chrome-extension://{}", "a".repeat(32));
    let extension_config = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/config")
                .header("origin", &extension_origin)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(extension_config.status(), StatusCode::OK);
    let extension_config: Value = serde_json::from_slice(
        &axum::body::to_bytes(extension_config.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(extension_config["origin"], extension_origin);
    let mut disallowed_challenge = Request::builder()
        .method("POST")
        .uri("/auth/challenges")
        .header("content-type", "application/json")
        .header("origin", "https://attacker.example")
        .body(Body::from(
            json!({"address": ADDRESS, "chainId": "eip155:1"}).to_string(),
        ))
        .unwrap();
    disallowed_challenge.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    assert_eq!(
        app.clone()
            .oneshot(disallowed_challenge)
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let extension_challenge = app
        .clone()
        .oneshot({
            let mut r = Request::builder()
                .method("POST")
                .uri("/auth/challenges")
                .header("content-type", "application/json")
                .header("origin", &extension_origin)
                .body(Body::from(
                    json!({"address": ADDRESS, "chainId": "eip155:1"}).to_string(),
                ))
                .unwrap();
            r.extensions_mut().insert(ConnectInfo(
                "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
            ));
            r
        })
        .await
        .unwrap();
    let extension_challenge: Value = serde_json::from_slice(
        &axum::body::to_bytes(extension_challenge.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    let extension_message: siwe::Message = extension_challenge["message"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(extension_message.uri.as_str(), extension_origin);
    let extension_signature = signature(extension_challenge["message"].as_str().unwrap(), 1);
    let mut mismatched_origin = Request::builder()
        .method("POST")
        .uri("/auth/verify")
        .header("content-type", "application/json")
        .header("origin", "http://localhost:5173")
        .body(Body::from(
            json!({"challengeId": extension_challenge["id"], "signature": extension_signature, "deviceId": Uuid::from_u128(10)}).to_string(),
        ))
        .unwrap();
    mismatched_origin.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    assert_eq!(
        app.clone()
            .oneshot(mismatched_origin)
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED,
        "a challenge cannot be verified from a different configured origin"
    );
    let mut extension_verify = Request::builder()
        .method("POST")
        .uri("/auth/verify")
        .header("content-type", "application/json")
        .header("origin", &extension_origin)
        .body(Body::from(
            json!({"challengeId": extension_challenge["id"], "signature": extension_signature, "deviceId": Uuid::from_u128(9)}).to_string(),
        ))
        .unwrap();
    extension_verify.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let extension_session = app.clone().oneshot(extension_verify).await.unwrap();
    assert_eq!(extension_session.status(), StatusCode::OK);
    let extension_session: Value = serde_json::from_slice(
        &axum::body::to_bytes(extension_session.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(extension_session["refreshToken"].is_null());
    assert!(extension_session["refreshExpiresAt"].is_null());

    let mut extension_refresh = Request::builder()
        .method("POST")
        .uri("/auth/refresh")
        .header("content-type", "application/json")
        .header("origin", &extension_origin)
        .body(Body::from(
            json!({"refreshToken": "a".repeat(64), "deviceId": Uuid::from_u128(9)}).to_string(),
        ))
        .unwrap();
    extension_refresh.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let extension_refresh = app.clone().oneshot(extension_refresh).await.unwrap();
    assert_eq!(extension_refresh.status(), StatusCode::UNAUTHORIZED);

    let mut browser_refresh = Request::builder()
        .method("POST")
        .uri("/auth/refresh")
        .header("content-type", "application/json")
        .header("origin", "http://localhost:5173")
        .body(Body::from(
            json!({"refreshToken": "a".repeat(64), "deviceId": Uuid::from_u128(8)}).to_string(),
        ))
        .unwrap();
    browser_refresh.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = app.clone().oneshot(browser_refresh).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn refresh_http_route_is_ip_limited_and_preserves_native_rotation() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let initial = session(&identity).await;
    let app = routes::identity::router(Some(identity), false);
    let request = |refresh_token: &str| {
        let mut request = Request::builder()
            .method("POST")
            .uri("/auth/refresh")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "refreshToken": refresh_token,
                    "deviceId": Uuid::from_u128(1)
                })
                .to_string(),
            ))
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ));
        request
    };

    let original_refresh = initial.refresh_token.as_deref().unwrap();
    let rotated = app
        .clone()
        .oneshot(request(original_refresh))
        .await
        .unwrap();
    assert_eq!(rotated.status(), StatusCode::OK);
    let rotated: Value = serde_json::from_slice(
        &axum::body::to_bytes(rotated.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(rotated["refreshToken"].as_str().is_some());

    for _ in 0..29 {
        let rejected = app.clone().oneshot(request(&"a".repeat(64))).await.unwrap();
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    }
    let limited = app.oneshot(request(&"b".repeat(64))).await.unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn linked_wallets_require_live_session_single_use_proof_and_unique_ownership() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let owner = session(&identity).await;
    let second_address = address_for_key(2);
    for _ in 0..6 {
        assert!(matches!(
            identity
                .link_wallet_challenge(
                    &"a".repeat(64),
                    LinkWalletChallengeRequest {
                        address: second_address.clone()
                    },
                    None,
                )
                .await,
            Err(AppError::Unauthorized)
        ));
    }
    let challenge = identity
        .link_wallet_challenge(
            &owner.access_token,
            LinkWalletChallengeRequest {
                address: second_address.clone(),
            },
            None,
        )
        .await
        .unwrap();
    let bad = LinkWalletRequest {
        challenge_id: challenge.id,
        signature: signature(&challenge.message, 3),
    };
    assert!(matches!(
        identity.link_wallet(&owner.access_token, bad, None).await,
        Err(AppError::Unauthorized)
    ));
    let link_proof = LinkWalletRequest {
        challenge_id: challenge.id,
        signature: signature(&challenge.message, 2),
    };
    let linked = identity
        .link_wallet(&owner.access_token, link_proof.clone(), None)
        .await
        .unwrap();
    assert_eq!(linked.address.to_lowercase(), second_address.to_lowercase());
    assert_eq!(
        identity.wallets(&owner.access_token).await.unwrap().len(),
        2
    );
    assert!(matches!(
        identity
            .link_wallet(&owner.access_token, link_proof, None)
            .await,
        Err(AppError::Unauthorized)
    ));

    let third_address = address_for_key(3);
    let third = identity
        .challenge(ChallengeRequest {
            address: third_address,
            chain_id: "eip155:1".into(),
        })
        .await
        .unwrap();
    let other = identity
        .verify(
            VerifyRequest {
                challenge_id: third.id,
                signature: signature(&third.message, 3),
                device_id: Uuid::from_u128(3),
            },
            true,
        )
        .await
        .unwrap();
    let other_link = identity
        .link_wallet_challenge(
            &other.access_token,
            LinkWalletChallengeRequest {
                address: second_address,
            },
            None,
        )
        .await
        .unwrap();
    let result = identity
        .link_wallet(
            &other.access_token,
            LinkWalletRequest {
                challenge_id: other_link.id,
                signature: signature(&other_link.message, 2),
            },
            None,
        )
        .await;
    assert!(matches!(result, Err(AppError::Conflict(_))));
    assert_eq!(
        identity.wallets(&other.access_token).await.unwrap().len(),
        1
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn database_rate_limits_are_atomic_and_auth_cleanup_is_bounded() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    // Clock boundary is irrelevant: all updates in this race use the current minute;
    // test near-boundary flakiness is avoided by checking a one-per-window upper bound.
    let (a, b) = tokio::join!(identity.rate_limit("one", 1), identity.rate_limit("one", 1));
    let successes = usize::from(a.is_ok()) + usize::from(b.is_ok());
    let windows: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_rate_limits")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(successes as i64, windows);
    let max: i32 = sqlx::query_scalar("SELECT max(attempts) FROM auth_rate_limits")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(max, 1);
    let _ = challenge(&identity).await;
    sqlx::query("UPDATE auth_challenges SET expires_at = clock_timestamp() - interval '2 days'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        honey_server::database::prune_auth(&db.pool).await.unwrap(),
        1
    );
    honey_server::database::migrate(&db.pool).await.unwrap(); // repeat is safe
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn database_pair_quota_matches_redis_admission_semantics() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let (first, duplicate) = tokio::join!(
        identity.rate_limit_pair("quota_parity", "alice", 2, 1),
        identity.rate_limit_pair("quota_parity", "alice", 2, 1)
    );
    assert_eq!(
        usize::from(first.is_ok()) + usize::from(duplicate.is_ok()),
        1
    );
    identity
        .rate_limit_pair("quota_parity", "bob", 2, 1)
        .await
        .unwrap();
    assert!(matches!(
        identity
            .rate_limit_pair("quota_parity", "carol", 2, 1)
            .await,
        Err(honey_server::error::AppError::TooManyRequests)
    ));

    let (rows, attempts): (i64, i64) =
        sqlx::query_as("SELECT count(*), COALESCE(sum(attempts),0) FROM auth_rate_limits")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    // Each accepted request increments global + subject; the duplicate and the
    // global denial must leave no partial increment behind.
    assert_eq!(attempts, 4);
    assert!(
        (3..=4).contains(&rows),
        "unexpected limiter row count: {rows}"
    );
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn operation_and_outbox_are_atomic_idempotent_and_owner_scoped() {
    let db = TestDatabase::new().await;
    let identity = identity(&db);
    let owner = session(&identity).await.profile;
    let store = WorkStore::new(db.pool.clone());
    let intent =
        json!({"amount": "1000000000000000000000000", "chainId": "eip155:1", "recipient": ADDRESS});
    let input = || NewOperation {
        user_id: owner.user_id,
        wallet_id: owner.wallet.id,
        action: Action::Transfer,
        idempotency_key: "same",
        intent: &intent,
    };
    let (a, b) = tokio::join!(store.create(input()), store.create(input()));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.id, b.id);
    let jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(jobs, 1);
    let different = json!({"amount": "2"});
    assert!(matches!(
        store
            .create(NewOperation {
                intent: &different,
                ..input()
            })
            .await,
        Err(AppError::Conflict(_))
    ));
    assert!(matches!(
        store.get(Uuid::new_v4(), owner.wallet.id, a.id).await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        store.get(owner.user_id, Uuid::new_v4(), a.id).await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        store
            .create(NewOperation {
                user_id: Uuid::new_v4(),
                ..input()
            })
            .await,
        Err(AppError::NotFound)
    ));
    assert!(matches!(
        store
            .create(NewOperation {
                intent: &json!({"amount": 1.1}),
                ..input()
            })
            .await,
        Err(AppError::BadRequest(_))
    ));
    // Force the outbox insert to fail. The corresponding operation must roll back.
    sqlx::query("ALTER TABLE jobs ADD CONSTRAINT inject_failure CHECK (false) NOT VALID")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(
        store
            .create(NewOperation {
                idempotency_key: "rollback",
                ..input()
            })
            .await
            .is_err()
    );
    let operations: i64 = sqlx::query_scalar("SELECT count(*) FROM operations")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(operations, 1);
    let intents: i64 = sqlx::query_scalar("SELECT count(*) FROM operation_intents")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(intents, 1);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn job_claims_fence_crashed_workers_and_state_changes_commit_with_outbox() {
    let db = TestDatabase::new().await;
    let owner = session(&identity(&db)).await.profile;
    let store = WorkStore::new(db.pool.clone());
    let operation = store
        .create(NewOperation {
            user_id: owner.user_id,
            wallet_id: owner.wallet.id,
            action: Action::Swap,
            idempotency_key: "one",
            intent: &json!({"amount": "10"}),
        })
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        store.claim(Topic::OperationCreated, 30),
        store.claim(Topic::OperationCreated, 30)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(usize::from(a.is_some()) + usize::from(b.is_some()), 1);
    let old = a.or(b).unwrap();
    sqlx::query(
        "UPDATE jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1",
    )
    .bind(old.id)
    .execute(&db.pool)
    .await
    .unwrap();
    let new = store
        .claim(Topic::OperationCreated, 30)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(new.id, old.id);
    assert_ne!(new.token, old.token);
    assert_eq!(new.attempts, 2);
    assert!(!store.complete(&old).await.unwrap());
    assert!(!store.fail(&old, JobFailure::UpstreamTimeout).await.unwrap());
    assert!(
        store
            .transition(operation.id, 0, OperationState::Failed, &old)
            .await
            .is_err()
    );
    assert!(
        store
            .transition(operation.id, 0, OperationState::Succeeded, &new)
            .await
            .is_err()
    );
    assert!(
        store
            .transition(operation.id, 0, OperationState::AwaitingSignature, &new)
            .await
            .is_err()
    );
    let changed = store
        .transition(operation.id, 0, OperationState::Failed, &new)
        .await
        .unwrap();
    assert_eq!(changed.version, "1");
    let source_state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id=$1")
        .bind(new.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(source_state, "done");
    assert!(
        store
            .transition(operation.id, 0, OperationState::Failed, &new)
            .await
            .is_err()
    );
    // The terminal state and source-job acknowledgement commit atomically.
    assert!(!store.complete(&new).await.unwrap());
    assert!(!store.complete(&new).await.unwrap());
    let terminal_jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE operation_id=$1 AND topic='operation.changed' AND state='ready'",
    )
    .bind(operation.id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(terminal_jobs, 0);
    let second = store
        .create(NewOperation {
            user_id: owner.user_id,
            wallet_id: owner.wallet.id,
            action: Action::Earn,
            idempotency_key: "second",
            intent: &json!({"amount":"20"}),
        })
        .await
        .unwrap();
    let second_lease = store
        .claim(Topic::OperationCreated, 30)
        .await
        .unwrap()
        .unwrap();
    // A DB failure after state update must roll back BOTH version and outbox.
    sqlx::query("ALTER TABLE jobs ADD CONSTRAINT inject_failure CHECK (state <> 'done') NOT VALID")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(
        store
            .transition(second.id, 0, OperationState::Failed, &second_lease)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .get(owner.user_id, owner.wallet.id, second.id)
            .await
            .unwrap()
            .version,
        "0"
    );
    let source_state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id=$1")
        .bind(second_lease.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(source_state, "leased");
    let changed_jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE operation_id=$1 AND topic='operation.changed'",
    )
    .bind(second.id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(changed_jobs, 0);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn failed_and_crashed_final_attempts_become_dead_without_republishing() {
    let db = TestDatabase::new().await;
    let owner = session(&identity(&db)).await.profile;
    let store = WorkStore::new(db.pool.clone());
    for key in ["failed", "crashed"] {
        store
            .create(NewOperation {
                user_id: owner.user_id,
                wallet_id: owner.wallet.id,
                action: Action::Bridge,
                idempotency_key: key,
                intent: &json!({"amount": "10"}),
            })
            .await
            .unwrap();
    }
    sqlx::query("UPDATE jobs SET max_attempts = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    let first = store
        .claim(Topic::OperationCreated, 30)
        .await
        .unwrap()
        .unwrap();
    assert!(
        store
            .fail(&first, JobFailure::InvalidResponse)
            .await
            .unwrap()
    );
    let second = store
        .claim(Topic::OperationCreated, 30)
        .await
        .unwrap()
        .unwrap();
    sqlx::query(
        "UPDATE jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1",
    )
    .bind(second.id)
    .execute(&db.pool)
    .await
    .unwrap();
    assert!(
        store
            .claim(Topic::OperationCreated, 30)
            .await
            .unwrap()
            .is_none()
    );
    let dead: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE state = 'dead'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(dead, 2);
    db.close().await;
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn attacker_cannot_spend_another_peers_wallet_challenge_allowance() {
    let db = TestDatabase::new().await;
    let app = routes::identity::router(Some(identity(&db)), false);
    let request = |peer: &str| {
        let mut request = Request::builder()
            .method("POST")
            .uri("/auth/challenges")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"address": ADDRESS, "chainId": "eip155:1"}).to_string(),
            ))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(peer.parse::<std::net::SocketAddr>().unwrap()));
        request
    };
    for _ in 0..5 {
        assert_eq!(
            app.clone()
                .oneshot(request("192.0.2.1:1000"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        app.clone()
            .oneshot(request("192.0.2.2:1000"))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    for _ in 5..30 {
        assert_eq!(
            app.clone()
                .oneshot(request("192.0.2.1:1000"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        app.clone()
            .oneshot(request("192.0.2.1:1000"))
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        app.oneshot(request("192.0.2.2:1000"))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    db.close().await;
}
