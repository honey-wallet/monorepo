//! Explicit embedded migrations. No filesystem or SQLx compile-time database required.

use std::{borrow::Cow, future::Future, pin::Pin};

use sqlx::{PgPool, error::BoxDynError};
use sqlx_core::migrate::{Migration, MigrationSource, MigrationType, Migrator};

/// Latest schema version required before authenticated endpoints are ready.
/// Keep this attached to the final embedded migration so readiness cannot drift
/// from the migration list when the schema advances.
pub const LATEST_SCHEMA_VERSION: i64 = 202610190002;
const AUTH_CLEANUP_LOCK: i64 = 0x484f_4e45_5941_5554;

#[derive(Debug)]
struct EmbeddedMigrations;

impl MigrationSource<'static> for EmbeddedMigrations {
    fn resolve(
        self,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Migration>, BoxDynError>> + Send + 'static>> {
        Box::pin(async {
            Ok(vec![
                Migration::new(
                    202610180001,
                    Cow::Borrowed("identity and work"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!(
                        "../migrations/202610180001_identity_and_work.sql"
                    )),
                    false,
                ),
                Migration::new(
                    202610180002,
                    Cow::Borrowed("immutable preparations"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!("../migrations/202610180002_preparations.sql")),
                    false,
                ),
                Migration::new(
                    202610180003,
                    Cow::Borrowed("signed submissions"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!("../migrations/202610180003_submissions.sql")),
                    false,
                ),
                Migration::new(
                    202610180004,
                    Cow::Borrowed("receipt reconciliation"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!(
                        "../migrations/202610180004_reconciliation.sql"
                    )),
                    false,
                ),
                Migration::new(
                    202610180005,
                    Cow::Borrowed("Aave signing requests"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!("../migrations/202610180005_aave_signing.sql")),
                    false,
                ),
                Migration::new(
                    202610180006,
                    Cow::Borrowed("wallet operation history"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!(
                        "../migrations/202610180006_operation_history.sql"
                    )),
                    true,
                ),
                Migration::new(
                    202610180007,
                    Cow::Borrowed("shared Earn signing evidence"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!("../migrations/202610180007_earn_signing.sql")),
                    false,
                ),
                Migration::new(
                    202610180008,
                    Cow::Borrowed("sealed swap preparations"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!(
                        "../migrations/202610180008_sealed_preparations.sql"
                    )),
                    false,
                ),
                Migration::new(
                    202610180009,
                    Cow::Borrowed("immutable swap permit reviews"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!("../migrations/202610180009_swap_permits.sql")),
                    false,
                ),
                Migration::new(
                    202610180010,
                    Cow::Borrowed("durable bridge status observations"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!(
                        "../migrations/202610180010_bridge_monitor.sql"
                    )),
                    false,
                ),
                Migration::new(
                    202610180011,
                    Cow::Borrowed("verified Across destination settlement"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!(
                        "../migrations/202610180011_across_settlement.sql"
                    )),
                    false,
                ),
                Migration::new(
                    202610180012,
                    Cow::Borrowed("rotating refresh families"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!(
                        "../migrations/202610180012_refresh_families.sql"
                    )),
                    false,
                ),
                Migration::new(
                    202610190001,
                    Cow::Borrowed("proof-based wallet links"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!("../migrations/202610190001_wallet_links.sql")),
                    false,
                ),
                Migration::new(
                    LATEST_SCHEMA_VERSION,
                    Cow::Borrowed("bounded queue metric probes"),
                    MigrationType::Simple,
                    Cow::Borrowed(include_str!(
                        "../migrations/202610190002_job_queue_metrics.sql"
                    )),
                    true,
                ),
            ])
        })
    }
}

/// Explicit operator action, not called by the API startup path.
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx_core::migrate::MigrateError> {
    Migrator::new(EmbeddedMigrations).await?.run(pool).await
}

/// Bounded maintenance for expired authentication records. Retain minimal identity
/// audit events separately; do not delete financial operations or queue history here.
pub async fn prune_auth(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock($1)")
        .bind(AUTH_CLEANUP_LOCK)
        .fetch_one(&mut *tx)
        .await?;
    if !acquired {
        tx.rollback().await?;
        return Ok(0);
    }

    // These per-minute caps exceed maximum admitted issuance: proof routes permit
    // 1,200/min; profile routes permit 12,000/min (at most 24,000 distinct IP/user
    // rows), and the DB fixture fallback adds at most 2,400 proof IP/address rows.
    // Redis TTL handles runtime quota rows; the larger DB batch drains legacy rows.
    let mut total = 0;
    for (query, batch) in [
        (
            "DELETE FROM wallet_link_challenges WHERE id IN (SELECT id FROM wallet_link_challenges WHERE expires_at < clock_timestamp() - interval '1 day' LIMIT $1)",
            5_000_i64,
        ),
        (
            "DELETE FROM auth_challenges WHERE id IN (SELECT id FROM auth_challenges WHERE expires_at < clock_timestamp() - interval '1 day' LIMIT $1)",
            5_000_i64,
        ),
        (
            "DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at < clock_timestamp() - interval '1 day' LIMIT $1)",
            20_000_i64,
        ),
        (
            "DELETE FROM auth_refresh_tokens WHERE token_hash IN (SELECT t.token_hash FROM auth_refresh_tokens t JOIN auth_refresh_families f ON f.id=t.family_id WHERE f.expires_at < clock_timestamp() - interval '1 day' LIMIT $1)",
            20_000_i64,
        ),
        // A family can have more than one batch of spent refresh tokens. Keep it
        // until all dependent replay-protection rows and sessions are gone.
        (
            "DELETE FROM auth_refresh_families f WHERE f.id IN (SELECT id FROM auth_refresh_families WHERE expires_at < clock_timestamp() - interval '1 day' LIMIT $1) AND NOT EXISTS (SELECT 1 FROM auth_refresh_tokens t WHERE t.family_id=f.id) AND NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.refresh_family_id=f.id)",
            20_000_i64,
        ),
        (
            "DELETE FROM auth_rate_limits WHERE (subject_hash, window_start) IN (SELECT subject_hash, window_start FROM auth_rate_limits WHERE window_start < clock_timestamp() - interval '1 day' LIMIT $1)",
            50_000_i64,
        ),
    ] {
        total += sqlx::query(query)
            .bind(batch)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    }
    tx.commit().await?;
    Ok(total)
}
