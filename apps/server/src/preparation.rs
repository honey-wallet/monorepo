//! Immutable EVM preparation persistence. This is NOT a transaction validator or
//! broadcaster. Provider adapters must verify calldata, simulation and economics
//! before storing a plan; typed Aave orchestration lives in aave_service.
use serde::{Deserialize, Serialize};
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

mod reviewed;
mod sealed;
pub use reviewed::SwapSigningEvidence;

use crate::{
    error::AppError,
    identity::{digest, unavailable},
    work::{Action, JobLease, Operation, WorkStore, decode_operation},
};

const UINT256_MAX: &str =
    "115792089237316195423570985008687907853269984665640564039457584007913129639935";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparationProvider {
    NativeTransfer,
    AaveV3,
    MorphoVaultV2,
    Uniswap,
}
impl PreparationProvider {
    fn action(self) -> Action {
        match self {
            Self::NativeTransfer => Action::Transfer,
            Self::AaveV3 | Self::MorphoVaultV2 => Action::Earn,
            Self::Uniswap => Action::Swap,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvmPreparation {
    pub schema_version: u8,
    pub provider: PreparationProvider,
    /// Decimal strings, bound to the proven wallet membership at persistence.
    pub chain_id: String,
    pub signer: String,
    /// SHA-256 of the existing versioned operation intent, lowercase hex, no 0x.
    pub intent_hash: String,
    pub registry_revision: String,
    pub fee_policy_revision: String,
    pub quote_reference: Option<String>,
    pub expires_at_ms: i64,
    pub maximum_network_fee_raw: String,
    pub maximum_spend: AssetAmount,
    pub minimum_receive: Option<AssetAmount>,
    pub fees: Vec<PlanFee>,
    pub simulation: SimulationRecord,
    /// Ordered approvals followed by exactly one action, at most eight calls.
    pub steps: Vec<EvmCall>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetAmount {
    /// None denotes native gas asset; never use a made-up ERC20 address for it.
    pub asset_address: Option<String>,
    pub amount_raw: String,
    pub recipient: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanFee {
    pub kind: FeeKind,
    pub amount: AssetAmount,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeeKind {
    Provider,
    App,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimulationRecord {
    pub block_number: String,
    pub block_hash: String,
    /// SHA-256 over the canonical ordered calls. Binds evidence to this exact bundle.
    pub calls_hash: String,
    pub observed_at_ms: i64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvmCall {
    pub purpose: CallPurpose,
    pub to: String,
    pub value_raw: String,
    pub data: String,
}
impl std::fmt::Debug for EvmCall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EvmCall")
            .field("purpose", &self.purpose)
            .field("to", &self.to)
            .field("value_raw", &self.value_raw)
            .field("data", &"[redacted]")
            .finish()
    }
}
impl Drop for EvmCall {
    fn drop(&mut self) {
        self.data.zeroize();
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallPurpose {
    Approval,
    Action,
}

/// Public recovery metadata. Never interpreted as permission to sign or submit.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationSummary {
    pub hash: String,
    pub provider: PreparationProvider,
    pub chain_id: String,
    pub expires_at_ms: i64,
    pub expired: bool,
    pub step_count: usize,
    pub registry_revision: String,
    pub fee_policy_revision: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecovery {
    pub operation: Operation,
    pub intent_available: bool,
    pub preparation: Option<PreparationSummary>,
    pub execution_available: bool,
    pub submission: Option<crate::submissions::SubmissionSummary>,
    pub reconciliation: Option<crate::reconciliation::ReconciliationSummary>,
}

fn bad() -> AppError {
    AppError::BadRequest("invalid EVM preparation".into())
}
fn conflict() -> AppError {
    AppError::Conflict("operation or preparation changed; recover current state".into())
}
pub(crate) fn canonical<T: Serialize>(value: &T) -> Result<Zeroizing<String>, AppError> {
    // Convert structs to serde_json's recursively sorted default Map. Hashing is a
    // versioned internal format, not EIP-712 or a client signing digest.
    fn wipe(v: &mut serde_json::Value) {
        match v {
            serde_json::Value::String(s) => s.zeroize(),
            serde_json::Value::Array(values) => values.iter_mut().for_each(wipe),
            serde_json::Value::Object(values) => values.values_mut().for_each(wipe),
            _ => {}
        }
    }
    let mut value = serde_json::to_value(value).map_err(|_| bad())?;
    let encoded = serde_json::to_string(&value)
        .map(Zeroizing::new)
        .map_err(|_| bad());
    wipe(&mut value);
    encoded
}
pub fn calls_hash(calls: &[EvmCall]) -> Result<String, AppError> {
    Ok(hex::encode(digest(canonical(&calls)?.as_bytes())))
}
fn fixed_hex(s: &str, size: usize) -> bool {
    s.len() == 2 + size * 2
        && s.starts_with("0x")
        && s[2..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn address(s: &str) -> bool {
    fixed_hex(s, 20) && s[2..].bytes().any(|b| b != b'0')
}
fn uint(s: &str, maximum: &str) -> bool {
    !s.is_empty()
        && (s == "0" || !s.starts_with('0'))
        && s.bytes().all(|b| b.is_ascii_digit())
        && (s.len() < maximum.len() || (s.len() == maximum.len() && s <= maximum))
}
fn label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn amount(v: &AssetAmount) -> bool {
    v.asset_address.as_deref().is_none_or(address)
        && uint(&v.amount_raw, UINT256_MAX)
        && address(&v.recipient)
}
impl EvmPreparation {
    /// Internal canonical SHA-256 integrity digest, never an Ethereum signing hash.
    pub fn integrity_hash(&self) -> Result<String, AppError> {
        self.validate()?;
        Ok(hex::encode(digest(canonical(self)?.as_bytes())))
    }
    /// Structural validation only. It does not prove a provider's quote, simulation
    /// truth, eligibility, code identity, approval scope, or end-to-end economics.
    pub fn validate(&self) -> Result<(), AppError> {
        if self.schema_version != 1
            || !uint(&self.chain_id, "9223372036854775807")
            || self.chain_id == "0"
            || !address(&self.signer)
            || !hash(&self.intent_hash)
            || !label(&self.registry_revision)
            || !label(&self.fee_policy_revision)
            || self.quote_reference.as_deref().is_some_and(|s| !label(s))
            || (self.provider == PreparationProvider::Uniswap && self.quote_reference.is_none())
            || !uint(&self.maximum_network_fee_raw, UINT256_MAX)
            || !amount(&self.maximum_spend)
            || self.maximum_spend.amount_raw == "0"
            || self.minimum_receive.as_ref().is_some_and(|v| !amount(v))
            || self.fees.len() > 8
            || self.fees.iter().any(|f| !amount(&f.amount))
            || !uint(&self.simulation.block_number, "18446744073709551615")
            || !fixed_hex(&self.simulation.block_hash, 32)
            || self.simulation.observed_at_ms <= 0
            || self.expires_at_ms <= 0
            || self.expires_at_ms > 9_007_199_254_740_991
            || self.steps.is_empty()
            || self.steps.len() > 8
            || self.steps.iter().enumerate().any(|(i, s)| {
                !address(&s.to)
                    || !uint(&s.value_raw, UINT256_MAX)
                    || s.data.len()
                        > if self.provider == PreparationProvider::Uniswap
                            && s.purpose == CallPurpose::Action
                        {
                            131074
                        } else {
                            8194
                        }
                    || s.data.len() < 2
                    || s.data.len() % 2 != 0
                    || !s.data.starts_with("0x")
                    || !s.data[2..]
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                    || s.purpose
                        != if i + 1 == self.steps.len() {
                            CallPurpose::Action
                        } else {
                            CallPurpose::Approval
                        }
                    || (s.purpose == CallPurpose::Approval && s.value_raw != "0")
            })
            || calls_hash(&self.steps)? != self.simulation.calls_hash
            || canonical(self)?.len()
                > if self.provider == PreparationProvider::Uniswap {
                    196608
                } else {
                    32768
                }
        {
            return Err(bad());
        }
        Ok(())
    }
    fn summary(&self, hash: String, now_ms: i64) -> PreparationSummary {
        PreparationSummary {
            hash,
            provider: self.provider,
            chain_id: self.chain_id.clone(),
            expires_at_ms: self.expires_at_ms,
            expired: self.expires_at_ms <= now_ms,
            step_count: self.steps.len(),
            registry_revision: self.registry_revision.clone(),
            fee_policy_revision: self.fee_policy_revision.clone(),
        }
    }
}

impl WorkStore {
    /// Durable, principal+wallet-scoped restart recovery. No signatures/calldata,
    /// arbitrary intent fields, provider credentials or queue leases enter this response.
    #[tracing::instrument(name = "work.recover", skip_all)]
    pub async fn recover(
        &self,
        user: Uuid,
        wallet: Uuid,
        id: Uuid,
    ) -> Result<OperationRecovery, AppError> {
        // A single statement snapshot avoids mixing a pre-prepare operation version
        // with a post-prepare plan. Hash checks fail closed on corrupted evidence.
        let row = sqlx::query(
            "SELECT o.id, o.wallet_id, o.action, o.state, o.version, o.intent_hash,
             i.canonical_json AS intent, p.canonical_json AS plan, p.plan_hash,
             p.public_json,p.public_hash,(extract(epoch FROM p.expires_at)*1000)::bigint AS expires_at_ms,
             (SELECT array_agg('0x' || encode(t.tx_hash,'hex') ORDER BY t.step) FROM evm_signed_transactions t WHERE t.operation_id=o.id) AS transaction_hashes,
             rb.observations_json,rb.observations_hash,(extract(epoch FROM rc.checked_at)*1000)::bigint AS checked_at_ms,
             rc.head_number::text AS head_number,rc.head_hash,rc.finalized_number::text AS finalized_number,rc.finalized_hash,
             (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
             FROM operations o LEFT JOIN operation_intents i ON i.operation_id = o.id
             LEFT JOIN operation_preparations p ON p.operation_id = o.id
             LEFT JOIN evm_reconciliation_current rc ON rc.operation_id=o.id
             LEFT JOIN evm_reconciliation_batches rb ON rb.id=rc.batch_id
             WHERE o.id = $1 AND o.user_id = $2 AND o.wallet_id = $3",
        )
        .bind(id)
        .bind(user)
        .bind(wallet)
        .fetch_optional(&self.pool)
        .await
        .map_err(unavailable)?
        .ok_or(AppError::NotFound)?;
        let operation = decode_operation(&row)?;
        let intent: Option<String> = row.try_get("intent").map_err(unavailable)?;
        let intent_hash: Vec<u8> = row.try_get("intent_hash").map_err(unavailable)?;
        if let Some(ref stored) = intent {
            let value: serde_json::Value =
                serde_json::from_str(stored).map_err(|_| AppError::Busy)?;
            let encoded = serde_json::to_vec(&(1, wallet, operation.action, value))
                .map_err(|_| AppError::Busy)?;
            if digest(&encoded) != intent_hash {
                return Err(AppError::Busy);
            }
        }
        let plan: Option<String> = row.try_get("plan").map_err(unavailable)?;
        let preparation = if let Some(stored) = plan {
            let saved_hash: Vec<u8> = row.try_get("plan_hash").map_err(unavailable)?;
            let plan = decode_plan(&stored, &saved_hash)?;
            if plan.intent_hash != hex::encode(intent_hash)
                || plan.provider.action() != operation.action
            {
                return Err(AppError::Busy);
            }
            Some(plan.summary(
                hex::encode(saved_hash),
                row.try_get("now_ms").map_err(unavailable)?,
            ))
        } else if let Some(public) = row
            .try_get::<Option<String>, _>("public_json")
            .map_err(unavailable)?
        {
            Some(sealed::public_summary(
                &public,
                &row.try_get::<Vec<u8>, _>("public_hash")
                    .map_err(unavailable)?,
                &row.try_get::<Vec<u8>, _>("plan_hash")
                    .map_err(unavailable)?,
                &intent_hash,
                operation.action,
                row.try_get("expires_at_ms").map_err(unavailable)?,
                row.try_get("now_ms").map_err(unavailable)?,
            )?)
        } else {
            None
        };
        let hashes: Option<Vec<String>> = row.try_get("transaction_hashes").map_err(unavailable)?;
        if hashes
            .as_ref()
            .is_some_and(|h| preparation.as_ref().is_none_or(|p| h.len() != p.step_count))
            || (matches!(operation.state, crate::work::OperationState::Signed) && hashes.is_none())
        {
            return Err(AppError::Busy);
        }
        let submission = hashes.map(|transaction_hashes| crate::submissions::SubmissionSummary {
            operation_id: id,
            transaction_hashes,
        });
        let observations: Option<String> = row.try_get("observations_json").map_err(unavailable)?;
        let reconciliation = if let Some(encoded) = observations {
            let transactions = crate::reconciliation::decode_observations(
                &encoded,
                &row.try_get::<Vec<u8>, _>("observations_hash")
                    .map_err(unavailable)?,
            )?;
            if submission.as_ref().is_none_or(|s| {
                s.transaction_hashes
                    != transactions
                        .iter()
                        .map(|t| t.transaction_hash.clone())
                        .collect::<Vec<_>>()
            }) {
                return Err(AppError::Busy);
            }
            Some(crate::reconciliation::ReconciliationSummary {
                checked_at_ms: row.try_get("checked_at_ms").map_err(unavailable)?,
                head_number: row.try_get("head_number").map_err(unavailable)?,
                head_hash: format!(
                    "0x{}",
                    hex::encode(
                        row.try_get::<Vec<u8>, _>("head_hash")
                            .map_err(unavailable)?
                    )
                ),
                finalized_number: row.try_get("finalized_number").map_err(unavailable)?,
                finalized_hash: format!(
                    "0x{}",
                    hex::encode(
                        row.try_get::<Vec<u8>, _>("finalized_hash")
                            .map_err(unavailable)?
                    )
                ),
                transactions,
            })
        } else {
            None
        };
        Ok(OperationRecovery {
            operation,
            intent_available: intent.is_some(),
            preparation,
            execution_available: false,
            submission,
            reconciliation,
        })
    }

    /// Atomically install immutable evidence, advance state, finish the claimed job,
    /// and create its successor. No provider IO occurs while locks are held.
    #[tracing::instrument(name = "work.prepare", skip_all)]
    pub async fn persist_preparation(
        &self,
        lease: &JobLease,
        plan: &EvmPreparation,
    ) -> Result<(), AppError> {
        self.persist_preparation_inner(lease, plan, None, None, None)
            .await
    }

    pub async fn persist_aave_preparation(
        &self,
        lease: &JobLease,
        prepared: &crate::providers::evm_prepare::PreparedEvm,
    ) -> Result<(), AppError> {
        if prepared.plan.provider != PreparationProvider::AaveV3 {
            return Err(bad());
        }
        self.persist_evm_preparation(lease, prepared).await
    }
    pub async fn persist_evm_preparation(
        &self,
        lease: &JobLease,
        prepared: &crate::providers::evm_prepare::PreparedEvm,
    ) -> Result<(), AppError> {
        prepared.validate_signing_terms()?;
        self.persist_preparation_inner(lease, &prepared.plan, Some(prepared), None, None)
            .await
    }

    /// Internal service boundary. Callers must establish economic/signature/chain
    /// authority first; storage validation alone never authorizes signing or dispatch.
    pub async fn persist_sealed_swap_preparation(
        &self,
        keys: &crate::submissions::SubmissionKeys,
        lease: &JobLease,
        prepared: &crate::providers::evm_prepare::PreparedEvm,
    ) -> Result<(), AppError> {
        prepared.validate_signing_terms()?;
        self.persist_preparation_inner(lease, &prepared.plan, Some(prepared), Some(keys), None)
            .await
    }

    /// Complete only a reviewed, permit-admitted build produced by the RPC
    /// preparer. No network IO occurs under the job/operation database locks.
    pub async fn persist_reviewed_swap_preparation(
        &self,
        keys: &crate::submissions::SubmissionKeys,
        lease: &JobLease,
        swap: &crate::providers::uniswap_execution::PreparedSwap,
    ) -> Result<(), AppError> {
        let prepared = swap.prepared();
        prepared.validate_signing_terms()?;
        self.persist_preparation_inner(
            lease,
            &prepared.plan,
            Some(prepared),
            Some(keys),
            Some(swap),
        )
        .await
    }

    async fn persist_preparation_inner(
        &self,
        lease: &JobLease,
        plan: &EvmPreparation,
        signing: Option<&crate::providers::evm_prepare::PreparedEvm>,
        keys: Option<&crate::submissions::SubmissionKeys>,
        swap: Option<&crate::providers::uniswap_execution::PreparedSwap>,
    ) -> Result<(), AppError> {
        plan.validate()?;
        if (plan.provider == PreparationProvider::Uniswap) != keys.is_some()
            || (keys.is_some() && signing.is_none())
        {
            return Err(bad());
        }
        let encoded = canonical(plan)?;
        let plan_hash = digest(encoded.as_bytes());
        let expires =
            OffsetDateTime::from_unix_timestamp_nanos(i128::from(plan.expires_at_ms) * 1_000_000)
                .map_err(|_| bad())?;
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        // Consistent lock order with WorkStore::transition: job then operation.
        let live: Option<Uuid> = sqlx::query_scalar("SELECT id FROM jobs WHERE id = $1 AND operation_id = $2 AND operation_version = $3 AND lease_token = $4 AND state = 'leased' AND lease_until > clock_timestamp() FOR UPDATE")
            .bind(lease.id).bind(lease.operation_id).bind(lease.operation_version).bind(lease.token)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?;
        if live.is_none() {
            return Err(conflict());
        }
        let row = sqlx::query("SELECT o.state, o.version, o.action, o.intent_hash, w.chain_id, w.address,
            i.canonical_json AS intent, o.wallet_id, o.user_id, (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
            FROM operations o JOIN wallet_memberships w ON w.id = o.wallet_id AND w.user_id = o.user_id
            JOIN operation_intents i ON i.operation_id = o.id WHERE o.id = $1 FOR UPDATE OF o")
            .bind(lease.operation_id).fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or_else(conflict)?;
        let now: i64 = row.try_get("now_ms").map_err(unavailable)?;
        let action: Action = serde_json::from_value(serde_json::Value::String(
            row.try_get("action").map_err(unavailable)?,
        ))
        .map_err(|_| AppError::Busy)?;
        let stored_intent: serde_json::Value =
            serde_json::from_str(&row.try_get::<String, _>("intent").map_err(unavailable)?)
                .map_err(|_| AppError::Busy)?;
        let wallet: Uuid = row.try_get("wallet_id").map_err(unavailable)?;
        let expected_intent = digest(
            &serde_json::to_vec(&(1, wallet, action, stored_intent)).map_err(|_| AppError::Busy)?,
        );
        if row.try_get::<String, _>("state").map_err(unavailable)?
            != if swap.is_some() {
                "building_swap"
            } else {
                "created"
            }
            || row.try_get::<i64, _>("version").map_err(unavailable)? != lease.operation_version
            || plan.provider.action() != action
            || plan.chain_id
                != row
                    .try_get::<i64, _>("chain_id")
                    .map_err(unavailable)?
                    .to_string()
            || plan.signer
                != format!(
                    "0x{}",
                    hex::encode(row.try_get::<Vec<u8>, _>("address").map_err(unavailable)?)
                )
            || expected_intent
                != row
                    .try_get::<Vec<u8>, _>("intent_hash")
                    .map_err(unavailable)?
            || plan.intent_hash != hex::encode(expected_intent)
            || plan.expires_at_ms <= now
            || plan.expires_at_ms > now + 900_000
            || plan.simulation.observed_at_ms > now
            || now - plan.simulation.observed_at_ms > 60_000
        {
            return Err(conflict());
        }
        if let Some(keys) = keys {
            sealed::insert(
                &mut tx,
                keys,
                lease.operation_id,
                row.try_get("user_id").map_err(unavailable)?,
                wallet,
                signing.ok_or_else(bad)?,
                swap,
            )
            .await?;
        } else {
            sqlx::query("INSERT INTO operation_preparations(operation_id, canonical_json, plan_hash, expires_at) VALUES ($1, $2, $3, $4)")
                .bind(lease.operation_id).bind(encoded.as_str()).bind(plan_hash).bind(expires)
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        if let Some(signing) = signing.filter(|_| keys.is_none()) {
            let json = serde_json::to_string(signing).map_err(|_| AppError::Busy)?;
            sqlx::query("INSERT INTO evm_signing_requests(operation_id, canonical_json, request_hash) VALUES ($1,$2,$3)")
                .bind(lease.operation_id).bind(&json).bind(digest(json.as_bytes()))
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        // Recheck lease and expiry at the final write, after any possible lock wait.
        let changed = sqlx::query("UPDATE operations SET state = 'awaiting_signature', version = version + 1, updated_at = clock_timestamp()
            WHERE id = $1 AND EXISTS(SELECT 1 FROM jobs WHERE id = $2 AND lease_token = $3 AND lease_until > clock_timestamp())
            AND $4 > clock_timestamp() AND $5 >= clock_timestamp() - interval '60 seconds'")
            .bind(lease.operation_id).bind(lease.id).bind(lease.token).bind(expires)
            .bind(OffsetDateTime::from_unix_timestamp_nanos(i128::from(plan.simulation.observed_at_ms) * 1_000_000).map_err(|_| bad())?)
            .execute(&mut *tx).await.map_err(unavailable)?.rows_affected();
        if changed != 1 {
            return Err(conflict());
        }
        sqlx::query("UPDATE jobs SET state = 'done', lease_token = NULL, lease_until = NULL, finished_at = clock_timestamp() WHERE id = $1")
            .bind(lease.id).execute(&mut *tx).await.map_err(unavailable)?;
        sqlx::query("INSERT INTO jobs(id, topic, operation_id, operation_version) VALUES ($1, 'operation.changed', $2, $3)")
            .bind(Uuid::new_v4()).bind(lease.operation_id).bind(lease.operation_version + 1)
            .execute(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(())
    }

    /// Internal reconstruction for a future evidence-aware signing/reconciliation
    /// service. Does not grant execution permission, including after expiration.
    pub async fn load_preparation(
        &self,
        user: Uuid,
        wallet: Uuid,
        id: Uuid,
    ) -> Result<EvmPreparation, AppError> {
        self.recover(user, wallet, id).await?;
        let row = sqlx::query("SELECT p.canonical_json, p.plan_hash FROM operation_preparations p JOIN operations o ON o.id = p.operation_id WHERE o.id = $1 AND o.user_id = $2 AND o.wallet_id = $3")
            .bind(id).bind(user).bind(wallet).fetch_optional(&self.pool).await.map_err(unavailable)?.ok_or(AppError::NotFound)?;
        decode_plan(
            &row.try_get::<String, _>("canonical_json")
                .map_err(unavailable)?,
            &row.try_get::<Vec<u8>, _>("plan_hash")
                .map_err(unavailable)?,
        )
    }
}
fn decode_plan(encoded: &str, expected_hash: &[u8]) -> Result<EvmPreparation, AppError> {
    if digest(encoded.as_bytes()) != expected_hash {
        return Err(AppError::Busy);
    }
    let plan: EvmPreparation = serde_json::from_str(encoded).map_err(|_| AppError::Busy)?;
    plan.validate().map_err(|_| AppError::Busy)?;
    if plan.provider == PreparationProvider::Uniswap {
        // No legacy plaintext swap record is a supported signing source.
        return Err(AppError::Busy);
    }
    if canonical(&plan)?.as_str() != encoded {
        return Err(AppError::Busy);
    }
    Ok(plan)
}
