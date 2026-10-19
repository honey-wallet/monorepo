//! Durable operation/idempotency repository and PostgreSQL outbox queue.
//!
//! Repository API; public commands must pass provider-specific orchestration.
//! Leases fence database writes, NOT external provider side effects. A worker must
//! reconcile an ambiguous submission and use the provider's deduplication mechanism.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    error::AppError,
    identity::{digest, unavailable},
};

#[derive(Clone)]
pub struct WorkStore {
    pub(crate) pool: PgPool,
}

#[derive(Debug, Clone, Copy)]
pub struct QueueMetricsSnapshot {
    pub ready: i64,
    pub leased: i64,
    pub expired_lease: i64,
    pub dead: i64,
    pub oldest_ready_age_seconds: Option<i64>,
    pub oldest_expired_lease_age_seconds: Option<i64>,
    pub oldest_dead_age_seconds: Option<i64>,
}

/// Sanitized metadata for a dead job. This deliberately omits any operation intent,
/// wallet/user identifiers, provider request/response bodies and signing material.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadLetter {
    pub id: Uuid,
    pub topic: String,
    pub operation_id: Uuid,
    pub operation_version: String,
    pub attempts: i32,
    pub max_attempts: i32,
    pub last_error_code: Option<String>,
    pub created_at_unix_seconds: i64,
    pub finished_at_unix_seconds: Option<i64>,
}

/// Bounded keyset page for a one-shot operator inspection command.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadLetterPage {
    pub items: Vec<DeadLetter>,
    /// Pass as the next `before-job-id` argument to continue, if present.
    pub next_before: Option<Uuid>,
}

const QUEUE_METRIC_COUNT_CAP: i64 = 10_001;

/// Retry scheduling for service-owned financial workers. They may not dead-letter
/// ambiguous work, so keep a bounded attempt counter solely for capped full jitter.
pub(crate) fn retry_delay_seconds(attempts: i32) -> u32 {
    let ceiling = (1u32 << attempts.clamp(1, 8)).min(300);
    (Uuid::new_v4().as_u128() % u128::from(ceiling)) as u32 + 1
}

#[cfg(test)]
mod retry_tests {
    #[test]
    fn financial_worker_backoff_is_nonzero_and_caps_after_eight_attempts() {
        let ceiling = |attempts: i32| (1u32 << attempts.clamp(1, 8)).min(300);
        for attempts in [-1, 0, 1, 2, 8, 9, i32::MAX] {
            let delay = super::retry_delay_seconds(attempts);
            assert!((1..=ceiling(attempts)).contains(&delay));
        }
        assert_eq!(ceiling(8), 256);
        assert_eq!(ceiling(9), ceiling(8));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Transfer,
    Swap,
    Bridge,
    Earn,
    Perps,
    Prediction,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Self::Transfer => "transfer",
            Self::Swap => "swap",
            Self::Bridge => "bridge",
            Self::Earn => "earn",
            Self::Perps => "perps",
            Self::Prediction => "prediction",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Created,
    AwaitingPermit,
    BuildingSwap,
    AwaitingSignature,
    Signed,
    Submitted,
    Confirming,
    Bridging,
    Succeeded,
    Failed,
    Unknown,
}

impl OperationState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::AwaitingPermit => "awaiting_permit",
            Self::BuildingSwap => "building_swap",
            Self::AwaitingSignature => "awaiting_signature",
            Self::Signed => "signed",
            Self::Submitted => "submitted",
            Self::Confirming => "confirming",
            Self::Bridging => "bridging",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: Uuid,
    pub wallet_id: Uuid,
    pub action: Action,
    pub state: OperationState,
    /// Decimal string to preserve all PostgreSQL bigint values in JavaScript.
    pub version: String,
}

pub struct NewOperation<'a> {
    pub user_id: Uuid,
    pub wallet_id: Uuid,
    pub action: Action,
    pub idempotency_key: &'a str,
    /// Validated public intent. Amounts/chain IDs are strings, never JSON numbers.
    /// Persisted immutably with its digest; never include keys or credentials.
    pub intent: &'a Value,
}

#[derive(Debug, Clone, Copy)]
pub enum Topic {
    OperationCreated,
    OperationChanged,
}

impl Topic {
    fn as_str(self) -> &'static str {
        match self {
            Self::OperationCreated => "operation.created",
            Self::OperationChanged => "operation.changed",
        }
    }
}

#[derive(Debug)]
pub struct JobLease {
    pub id: Uuid,
    pub operation_id: Uuid,
    pub operation_version: i64,
    /// Unpredictable per-claim fencing token. Never accepted from public clients.
    pub token: Uuid,
    pub attempts: i32,
}

#[derive(Debug, Clone, Copy)]
pub enum JobFailure {
    UpstreamTimeout,
    UpstreamUnavailable,
    InvalidResponse,
}

impl JobFailure {
    fn as_str(self) -> &'static str {
        match self {
            Self::UpstreamTimeout => "upstream_timeout",
            Self::UpstreamUnavailable => "upstream_unavailable",
            Self::InvalidResponse => "invalid_response",
        }
    }
}

impl WorkStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Inspect dead-letter metadata in a bounded, newest-first keyset page. The
    /// cursor must identify a currently dead job. This is intentionally read-only:
    /// replay is unsafe without a reviewed provider-specific reconciliation path.
    pub async fn dead_letters(
        &self,
        limit: usize,
        before: Option<Uuid>,
    ) -> Result<DeadLetterPage, AppError> {
        if !(1..=100).contains(&limit) {
            return Err(AppError::BadRequest(
                "dead-letter page size must be between 1 and 100".into(),
            ));
        }
        let cursor_created_at = match before {
            Some(id) => Some(
                sqlx::query_scalar::<_, OffsetDateTime>(
                    "SELECT created_at FROM jobs WHERE id = $1 AND state = 'dead'",
                )
                .bind(id)
                .fetch_optional(&self.pool)
                .await
                .map_err(unavailable)?
                .ok_or_else(|| AppError::BadRequest("invalid dead-letter cursor".into()))?,
            ),
            None => None,
        };
        let rows = sqlx::query(
            "SELECT id, topic, operation_id, operation_version, attempts, max_attempts,
                    last_error_code, created_at, finished_at
             FROM jobs
             WHERE state = 'dead'
               AND ($1::timestamptz IS NULL OR (created_at, id) < ($1, $2))
             ORDER BY created_at DESC, id DESC
             LIMIT $3",
        )
        .bind(cursor_created_at)
        .bind(before)
        .bind((limit + 1) as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(unavailable)?;
        let has_more = rows.len() > limit;
        let mut items = Vec::with_capacity(rows.len().min(limit));
        for row in rows.into_iter().take(limit) {
            let created_at: OffsetDateTime = row.try_get("created_at").map_err(unavailable)?;
            let finished_at: Option<OffsetDateTime> =
                row.try_get("finished_at").map_err(unavailable)?;
            items.push(DeadLetter {
                id: row.try_get("id").map_err(unavailable)?,
                topic: row.try_get("topic").map_err(unavailable)?,
                operation_id: row.try_get("operation_id").map_err(unavailable)?,
                operation_version: row
                    .try_get::<i64, _>("operation_version")
                    .map_err(unavailable)?
                    .to_string(),
                attempts: row.try_get("attempts").map_err(unavailable)?,
                max_attempts: row.try_get("max_attempts").map_err(unavailable)?,
                last_error_code: row.try_get("last_error_code").map_err(unavailable)?,
                created_at_unix_seconds: created_at.unix_timestamp(),
                finished_at_unix_seconds: finished_at.map(|value| value.unix_timestamp()),
            });
        }
        let next_before = has_more.then(|| items.last().expect("non-empty bounded page").id);
        Ok(DeadLetterPage { items, next_before })
    }

    /// Return capped counts and oldest-item ages for loopback-only operational metrics.
    /// Each count scans at most 10,001 entries from a state-specific index.
    pub async fn metrics_snapshot(&self) -> Result<QueueMetricsSnapshot, AppError> {
        let snapshot = sqlx::query_as::<
            _,
            (i64, i64, i64, i64, Option<i64>, Option<i64>, Option<i64>),
        >(
            "SELECT
               (SELECT count(*) FROM (SELECT 1 FROM jobs WHERE state = 'ready' AND available_at <= clock_timestamp() LIMIT 10001) ready),
               (SELECT count(*) FROM (SELECT 1 FROM jobs WHERE state = 'leased' LIMIT 10001) leased),
               (SELECT count(*) FROM (SELECT 1 FROM jobs WHERE state = 'leased' AND lease_until <= clock_timestamp() LIMIT 10001) expired),
               (SELECT count(*) FROM (SELECT 1 FROM jobs WHERE state = 'dead' LIMIT 10001) dead),
               (SELECT GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - available_at)::bigint) FROM jobs WHERE state = 'ready' AND available_at <= clock_timestamp() ORDER BY available_at, id LIMIT 1),
               (SELECT GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - lease_until)::bigint) FROM jobs WHERE state = 'leased' AND lease_until <= clock_timestamp() ORDER BY lease_until, id LIMIT 1),
               (SELECT GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - created_at)::bigint) FROM jobs WHERE state = 'dead' ORDER BY created_at, id LIMIT 1)",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(unavailable)?;
        Ok(QueueMetricsSnapshot {
            ready: snapshot.0.min(QUEUE_METRIC_COUNT_CAP),
            leased: snapshot.1.min(QUEUE_METRIC_COUNT_CAP),
            expired_lease: snapshot.2.min(QUEUE_METRIC_COUNT_CAP),
            dead: snapshot.3.min(QUEUE_METRIC_COUNT_CAP),
            oldest_ready_age_seconds: snapshot.4,
            oldest_expired_lease_age_seconds: snapshot.5,
            oldest_dead_age_seconds: snapshot.6,
        })
    }

    #[tracing::instrument(name = "work.create", skip_all)]
    pub async fn create(&self, input: NewOperation<'_>) -> Result<Operation, AppError> {
        if input.idempotency_key.is_empty()
            || input.idempotency_key.len() > 128
            || !input.idempotency_key.bytes().all(|c| c.is_ascii_graphic())
            || !input.intent.is_object()
            || !valid_intent(input.intent, 0)
        {
            return Err(AppError::BadRequest(
                "invalid operation intent or idempotency key".into(),
            ));
        }
        // serde_json's default Map is a BTreeMap: recursively sorted object keys.
        // Include schema version, wallet, and action to bind the whole command.
        let encoded = serde_json::to_vec(&(1, input.wallet_id, input.action, input.intent))
            .map_err(|_| AppError::BadRequest("invalid operation intent".into()))?;
        if encoded.len() > 8192 {
            return Err(AppError::BadRequest("operation intent too large".into()));
        }
        let hash = digest(&encoded);
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let owns: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM wallet_memberships WHERE id = $1 AND user_id = $2)",
        )
        .bind(input.wallet_id)
        .bind(input.user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if !owns {
            return Err(AppError::NotFound);
        }
        let inserted: Option<Uuid> = sqlx::query_scalar(
            "INSERT INTO operations(id, user_id, wallet_id, action, idempotency_key, intent_hash)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT(user_id, action, idempotency_key) DO NOTHING RETURNING id",
        ).bind(Uuid::new_v4()).bind(input.user_id).bind(input.wallet_id).bind(input.action.as_str())
            .bind(input.idempotency_key).bind(&hash).fetch_optional(&mut *tx).await.map_err(unavailable)?;
        let row = sqlx::query(
            "SELECT id, wallet_id, action, state, version, intent_hash FROM operations
             WHERE user_id = $1 AND action = $2 AND idempotency_key = $3",
        )
        .bind(input.user_id)
        .bind(input.action.as_str())
        .bind(input.idempotency_key)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        let existing_hash: Vec<u8> = row.try_get("intent_hash").map_err(unavailable)?;
        if existing_hash != hash {
            return Err(AppError::Conflict(
                "idempotency key belongs to a different intent".into(),
            ));
        }
        let operation = decode_operation(&row)?;
        if let Some(id) = inserted {
            let canonical = serde_json::to_string(input.intent).map_err(|_| AppError::Busy)?;
            sqlx::query(
                "INSERT INTO operation_intents(operation_id, canonical_json) VALUES ($1, $2)",
            )
            .bind(id)
            .bind(canonical)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
            sqlx::query("INSERT INTO jobs(id, topic, operation_id, operation_version) VALUES ($1, 'operation.created', $2, 0)")
                .bind(Uuid::new_v4()).bind(id).execute(&mut *tx).await.map_err(unavailable)?;
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(operation)
    }

    #[tracing::instrument(name = "work.get", skip_all)]
    pub async fn get(&self, user: Uuid, wallet: Uuid, id: Uuid) -> Result<Operation, AppError> {
        let row = sqlx::query("SELECT id, wallet_id, action, state, version FROM operations WHERE id = $1 AND user_id = $2 AND wallet_id = $3")
            .bind(id).bind(user).bind(wallet).fetch_optional(&self.pool).await.map_err(unavailable)?.ok_or(AppError::NotFound)?;
        decode_operation(&row)
    }

    /// Reject a created intent or an unprepared swap build with atomic CAS,
    /// source-job acknowledgement, and outbox.
    /// A failed swap retains its live permit evidence and nonce reservation.
    /// Financial state changes require preparation/submission/receipt evidence;
    /// this generic queue method cannot synthesize them. When
    /// called by a worker, require its current lease; an expired/stale worker cannot
    /// advance domain state even if it still knows the old operation version.
    #[tracing::instrument(name = "work.transition", skip_all)]
    pub async fn transition(
        &self,
        id: Uuid,
        expected_version: i64,
        next: OperationState,
        lease: &JobLease,
    ) -> Result<Operation, AppError> {
        if lease.operation_id != id || lease.operation_version != expected_version {
            return Err(AppError::Conflict(
                "lease does not own operation version".into(),
            ));
        }
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let current: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM jobs WHERE id = $1 AND operation_id = $2 AND lease_token = $3
             AND operation_version = $4 AND state = 'leased' AND lease_until > clock_timestamp() FOR UPDATE",
        )
        .bind(lease.id)
        .bind(id)
        .bind(lease.token)
        .bind(expected_version)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if current.is_none() {
            return Err(AppError::Conflict("job lease expired".into()));
        }
        let row = sqlx::query(
            "SELECT id, wallet_id, action, state, version FROM operations WHERE id = $1 FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?
        .ok_or(AppError::NotFound)?;
        let current = decode_operation(&row)?;
        let prepared: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM operation_preparations WHERE operation_id = $1)",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if prepared {
            return Err(AppError::Conflict(
                "prepared operations require evidence-aware transitions".into(),
            ));
        }
        if current.version != expected_version.to_string()
            || !(current.state == OperationState::Created
                || current.action == Action::Swap && current.state == OperationState::BuildingSwap)
            || next != OperationState::Failed
        {
            return Err(AppError::Conflict(
                "stale or invalid operation transition".into(),
            ));
        }
        let row = sqlx::query(
            "UPDATE operations SET state = $2, version = version + 1, updated_at = clock_timestamp()
             WHERE id = $1 AND EXISTS (SELECT 1 FROM jobs WHERE id = $3 AND lease_token = $4 AND lease_until > clock_timestamp())
             RETURNING id, wallet_id, action, state, version",
        ).bind(id).bind(next.as_str()).bind(lease.id).bind(lease.token)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?
            .ok_or_else(|| AppError::Conflict("job lease expired".into()))?;
        let result = decode_operation(&row)?;
        // Failed is terminal, so there is no worker to consume a successor job.
        let completed = sqlx::query(
            "UPDATE jobs SET state = 'done', lease_token = NULL, lease_until = NULL,
             finished_at = clock_timestamp() WHERE id = $1 AND lease_token = $2
             AND state = 'leased' AND lease_until > clock_timestamp()",
        )
        .bind(lease.id)
        .bind(lease.token)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?
        .rows_affected();
        if completed != 1 {
            return Err(AppError::Conflict("job lease expired".into()));
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Claim one job; no transaction/connection is held during provider IO.
    #[tracing::instrument(name = "work.claim", skip_all)]
    pub async fn claim(
        &self,
        topic: Topic,
        lease_seconds: i32,
    ) -> Result<Option<JobLease>, AppError> {
        if !(1..=300).contains(&lease_seconds) {
            return Err(AppError::BadRequest("invalid job lease duration".into()));
        }
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        // Crashed final attempts cannot stay permanently leased. Bound cleanup work.
        sqlx::query(
            "WITH exhausted AS (SELECT id FROM jobs WHERE topic = $1 AND state = 'leased'
             AND lease_until <= clock_timestamp() AND attempts >= max_attempts
             ORDER BY lease_until, id LIMIT 100 FOR UPDATE SKIP LOCKED)
             UPDATE jobs SET state = 'dead', lease_token = NULL, lease_until = NULL,
             last_error_code = 'lease_expired', finished_at = clock_timestamp()
             WHERE id IN (SELECT id FROM exhausted)",
        )
        .bind(topic.as_str())
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
        let token = Uuid::new_v4();
        let row = sqlx::query(
            "WITH candidate AS (
               SELECT id FROM jobs WHERE topic = $1 AND attempts < max_attempts
               AND ((state = 'ready' AND available_at <= clock_timestamp())
                 OR (state = 'leased' AND lease_until <= clock_timestamp()))
               ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
             ) UPDATE jobs SET state = 'leased', lease_token = $2,
               lease_until = clock_timestamp() + make_interval(secs => $3::double precision), attempts = attempts + 1
             WHERE id IN (SELECT id FROM candidate) RETURNING id, operation_id, operation_version, attempts",
        ).bind(topic.as_str()).bind(token).bind(f64::from(lease_seconds))
            .fetch_optional(&mut *tx).await.map_err(unavailable)?;
        let lease = row
            .map(|r| {
                Ok::<_, AppError>(JobLease {
                    id: r.try_get("id").map_err(unavailable)?,
                    operation_id: r.try_get("operation_id").map_err(unavailable)?,
                    operation_version: r.try_get("operation_version").map_err(unavailable)?,
                    token,
                    attempts: r.try_get("attempts").map_err(unavailable)?,
                })
            })
            .transpose()?;
        tx.commit().await.map_err(unavailable)?;
        Ok(lease)
    }

    /// A stale or expired lease cannot acknowledge a newer attempt.
    #[tracing::instrument(name = "work.complete", skip_all)]
    pub async fn complete(&self, lease: &JobLease) -> Result<bool, AppError> {
        let changed = sqlx::query(
            "UPDATE jobs SET state = 'done', lease_token = NULL, lease_until = NULL, finished_at = clock_timestamp()
             WHERE id = $1 AND lease_token = $2 AND state = 'leased' AND lease_until > clock_timestamp()",
        ).bind(lease.id).bind(lease.token).execute(&self.pool).await.map_err(unavailable)?.rows_affected();
        Ok(changed == 1)
    }

    /// Only use retries for idempotent/read work. Unknown financial submissions must
    /// enter reconciliation; this queue is not permission to blindly resubmit funds.
    #[tracing::instrument(name = "work.fail", skip_all)]
    pub async fn fail(&self, lease: &JobLease, error: JobFailure) -> Result<bool, AppError> {
        // Capped exponential full jitter. Randomness affects scheduling only.
        let ceiling = (1u32 << lease.attempts.clamp(1, 8)).min(300);
        let delay = (Uuid::new_v4().as_u128() % u128::from(ceiling)) + 1;
        let changed = sqlx::query(
            "UPDATE jobs SET state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'ready' END,
             available_at = clock_timestamp() + make_interval(secs => $3::double precision),
             finished_at = CASE WHEN attempts >= max_attempts THEN clock_timestamp() ELSE NULL END,
             last_error_code = $4, lease_token = NULL, lease_until = NULL
             WHERE id = $1 AND lease_token = $2 AND state = 'leased' AND lease_until > clock_timestamp()",
        ).bind(lease.id).bind(lease.token).bind(delay as f64).bind(error.as_str())
            .execute(&self.pool).await.map_err(unavailable)?.rows_affected();
        Ok(changed == 1)
    }
}

pub(crate) fn decode_operation(row: &sqlx::postgres::PgRow) -> Result<Operation, AppError> {
    let action: String = row.try_get("action").map_err(unavailable)?;
    let state: String = row.try_get("state").map_err(unavailable)?;
    Ok(Operation {
        id: row.try_get("id").map_err(unavailable)?,
        wallet_id: row.try_get("wallet_id").map_err(unavailable)?,
        action: serde_json::from_value(Value::String(action)).map_err(|_| AppError::Busy)?,
        state: serde_json::from_value(Value::String(state)).map_err(|_| AppError::Busy)?,
        version: row
            .try_get::<i64, _>("version")
            .map_err(unavailable)?
            .to_string(),
    })
}

fn valid_intent(value: &Value, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    match value {
        Value::Number(_) => false,
        Value::Array(values) => {
            values.len() <= 64 && values.iter().all(|v| valid_intent(v, depth + 1))
        }
        Value::Object(values) => {
            values.len() <= 64 && values.values().all(|v| valid_intent(v, depth + 1))
        }
        _ => true,
    }
}
