//! The actual offline restore script must invalidate restored auth state.
mod common;

use common::TestDatabase;
use honey_server::{
    config::AuthConfig,
    error::AppError,
    identity::{
        ChallengeRequest, Identity, LinkWalletChallengeRequest, RefreshRequest, VerifyRequest,
    },
};
use k256::ecdsa::SigningKey;
use uuid::Uuid;

const RESET: &str = include_str!("../../../scripts/backend/recovery-invalidate-auth.sql");
const ADDRESS: &str = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

fn sign(message: &str) -> String {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    let key = SigningKey::from_bytes((&bytes).into()).unwrap();
    let message: siwe::Message = message.parse().unwrap();
    let (signature, recovery) = key
        .sign_prehash_recoverable(&message.eip191_hash().unwrap())
        .unwrap();
    let mut result = signature.to_bytes().to_vec();
    result.push(recovery.to_byte() + 27);
    format!("0x{}", hex::encode(result))
}

fn request() -> ChallengeRequest {
    ChallengeRequest {
        address: ADDRESS.into(),
        chain_id: "eip155:1".into(),
    }
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL; creates and drops a fresh test database"]
async fn offline_restore_invalidates_all_auth_without_deleting_ownership_or_replay_evidence() {
    let db = TestDatabase::new().await;
    let identity = Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        },
    )
    .unwrap();
    let challenge = identity.challenge(request()).await.unwrap();
    let native = identity
        .verify(
            VerifyRequest {
                challenge_id: challenge.id,
                signature: sign(&challenge.message),
                device_id: Uuid::new_v4(),
            },
            true,
        )
        .await
        .unwrap();
    let original_refresh = native.refresh_token.unwrap();
    let rotated = identity
        .refresh(RefreshRequest {
            refresh_token: original_refresh.clone(),
            device_id: native.device_id,
        })
        .await
        .unwrap();
    let browser_challenge = identity.challenge(request()).await.unwrap();
    let browser = identity
        .verify(
            VerifyRequest {
                challenge_id: browser_challenge.id,
                signature: sign(&browser_challenge.message),
                device_id: Uuid::new_v4(),
            },
            false,
        )
        .await
        .unwrap();
    let pending = identity.challenge(request()).await.unwrap();
    let link = identity
        .link_wallet_challenge(
            &rotated.access_token,
            LinkWalletChallengeRequest {
                address: ADDRESS.into(),
            },
            None,
        )
        .await
        .unwrap();
    assert!(identity.authenticate(&rotated.access_token).await.is_ok());
    assert!(identity.authenticate(&browser.access_token).await.is_ok());

    // Model a restored snapshot: these credentials and unconsumed proofs remain
    // usable until the operator executes the exact checked-in script.
    sqlx::raw_sql(RESET).execute(&db.pool).await.unwrap();
    for token in [
        &native.access_token,
        &rotated.access_token,
        &browser.access_token,
    ] {
        assert!(matches!(
            identity.authenticate(token).await,
            Err(AppError::Unauthorized)
        ));
    }
    for token in [original_refresh, rotated.refresh_token.unwrap()] {
        assert!(matches!(
            identity
                .refresh(RefreshRequest {
                    refresh_token: token,
                    device_id: native.device_id,
                })
                .await,
            Err(AppError::Unauthorized)
        ));
    }
    assert!(matches!(
        identity
            .verify(
                VerifyRequest {
                    challenge_id: pending.id,
                    signature: sign(&pending.message),
                    device_id: Uuid::new_v4(),
                },
                true
            )
            .await,
        Err(AppError::Unauthorized)
    ));
    let all_invalid: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS(SELECT 1 FROM auth_sessions WHERE revoked_at IS NULL)
         AND NOT EXISTS(SELECT 1 FROM auth_refresh_families WHERE revoked_at IS NULL)
         AND NOT EXISTS(SELECT 1 FROM auth_challenges WHERE consumed_at IS NULL)
         AND NOT EXISTS(SELECT 1 FROM wallet_link_challenges WHERE consumed_at IS NULL)",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(all_invalid);
    let linked_consumed: bool = sqlx::query_scalar(
        "SELECT consumed_at IS NOT NULL FROM wallet_link_challenges WHERE id=$1",
    )
    .bind(link.id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(linked_consumed);
    let retained: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM wallet_memberships),
         (SELECT count(*) FROM auth_refresh_tokens), (SELECT count(*) FROM auth_sessions)",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(retained, (1, 1, 2, 3));
    let revoked_before: Vec<(Vec<u8>, time::OffsetDateTime)> =
        sqlx::query_as("SELECT token_hash, revoked_at FROM auth_sessions ORDER BY token_hash")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    sqlx::raw_sql(RESET).execute(&db.pool).await.unwrap();
    let revoked_after: Vec<(Vec<u8>, time::OffsetDateTime)> =
        sqlx::query_as("SELECT token_hash, revoked_at FROM auth_sessions ORDER BY token_hash")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        revoked_before, revoked_after,
        "reruns preserve audit timestamps"
    );

    // Recovery does not disable identity permanently: fresh proof works once
    // an operator has separately approved reopening the deployment.
    let fresh = identity.challenge(request()).await.unwrap();
    let session = identity
        .verify(
            VerifyRequest {
                challenge_id: fresh.id,
                signature: sign(&fresh.message),
                device_id: Uuid::new_v4(),
            },
            true,
        )
        .await
        .unwrap();
    assert_eq!(session.profile.user_id, browser.profile.user_id);
    db.close().await;
}
