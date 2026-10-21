//! Canonical receipt verification and durable reconciliation. RPC is trusted chain
//! infrastructure, not a cryptographic light client. No broadcast methods here.
use crate::{
    error::AppError,
    identity::{digest, unavailable},
    providers::evm_rpc::{EvmReadRpc, RpcError},
    work::{JobLease, WorkStore},
};
use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum ReceiptError {
    #[error("inconsistent or malformed chain receipt evidence")]
    Invalid,
    #[error("chain changed while reading receipts")]
    Reorg,
    #[error("receipt reconciliation deadline exceeded")]
    Timeout,
    #[error(transparent)]
    Rpc(#[from] RpcError),
}
type Result<T> = std::result::Result<T, ReceiptError>;
pub(crate) struct ExpectedReceipt {
    pub hash: B256,
    pub sender: Address,
    pub recipient: Address,
    pub gas_limit: u64,
    pub max_fee: U256,
    pub priority_fee: U256,
}
/// Constructed only from authenticated, decrypted, re-verified database evidence.
pub struct ReconciliationContext {
    pub(crate) operation: Uuid,
    pub(crate) plan_hash: String,
    pub(crate) chain: u64,
    pub(crate) expected: Vec<ExpectedReceipt>,
    pub(crate) anchor: Option<Checkpoint>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptObservation {
    pub transaction_hash: String,
    /// None: missing receipt. Missing is not evidence of dropped/replaced/failure.
    pub inclusion: Option<Inclusion>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Inclusion {
    pub block_number: String,
    pub block_hash: String,
    pub transaction_index: String,
    pub succeeded: bool,
    pub finalized: bool,
    pub gas_used: String,
    pub effective_gas_price: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationSummary {
    pub checked_at_ms: i64,
    pub head_number: String,
    pub head_hash: String,
    pub finalized_number: String,
    pub finalized_hash: String,
    pub transactions: Vec<ReceiptObservation>,
}
pub(crate) fn decode_observations(
    encoded: &str,
    expected_hash: &[u8],
) -> std::result::Result<Vec<ReceiptObservation>, AppError> {
    if digest(encoded.as_bytes()) != expected_hash {
        return Err(AppError::Busy);
    }
    let values: Vec<ReceiptObservation> =
        serde_json::from_str(encoded).map_err(|_| AppError::Busy)?;
    if values.is_empty()
        || values.len() > 8
        || serde_json::to_string(&values).map_err(|_| AppError::Busy)? != encoded
    {
        return Err(AppError::Busy);
    }
    Ok(values)
}
#[derive(Clone)]
pub(crate) struct Checkpoint {
    pub(crate) number: u64,
    pub(crate) hash: B256,
}
/// No public constructor/Deserialize: callers cannot turn JSON assertions into proof.
pub struct VerifiedReconciliation {
    operation: Uuid,
    plan_hash: String,
    chain: u64,
    observations: Vec<ReceiptObservation>,
    head: Checkpoint,
    finalized: Checkpoint,
    observed_at_ms: i64,
    anchor: Option<Checkpoint>,
}
impl VerifiedReconciliation {
    pub fn observations(&self) -> &[ReceiptObservation] {
        &self.observations
    }
}
fn quantity(v: &Value) -> Result<U256> {
    let s = v.as_str().ok_or(ReceiptError::Invalid)?;
    if !s.starts_with("0x")
        || s.len() < 3
        || s.len() > 66
        || (s.len() > 3 && s.as_bytes()[2] == b'0')
        || !s[2..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(ReceiptError::Invalid);
    }
    U256::from_str_radix(&s[2..], 16).map_err(|_| ReceiptError::Invalid)
}
fn u64_quantity(v: &Value) -> Result<u64> {
    quantity(v)?.try_into().map_err(|_| ReceiptError::Invalid)
}
fn hash(v: &Value) -> Result<B256> {
    v.as_str()
        .ok_or(ReceiptError::Invalid)?
        .parse()
        .map_err(|_| ReceiptError::Invalid)
}
fn address(v: &Value) -> Result<Address> {
    v.as_str()
        .ok_or(ReceiptError::Invalid)?
        .parse()
        .map_err(|_| ReceiptError::Invalid)
}
fn checkpoint(v: &Value) -> Result<Checkpoint> {
    Ok(Checkpoint {
        number: u64_quantity(&v["number"])?,
        hash: hash(&v["hash"])?,
    })
}
fn now_ms() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

#[tracing::instrument(name = "provider.reconcile_receipts", skip_all)]
pub async fn collect(
    rpc: &EvmReadRpc,
    context: &ReconciliationContext,
) -> Result<VerifiedReconciliation> {
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        collect_inner(rpc, context),
    )
    .await
    .map_err(|_| ReceiptError::Timeout)?
}
async fn collect_inner(
    rpc: &EvmReadRpc,
    c: &ReconciliationContext,
) -> Result<VerifiedReconciliation> {
    if c.expected.is_empty()
        || c.expected.len() > 8
        || !(c.chain == 1 || (c.chain == 31337 && rpc.is_loopback()))
        || u64_quantity(&rpc.chain_id().await?)? != c.chain
    {
        return Err(ReceiptError::Invalid);
    }
    let raw_head = rpc.block("latest").await?;
    let head = checkpoint(&raw_head)?;
    if c.chain == 1 {
        let timestamp = u64_quantity(&raw_head["timestamp"])?;
        let now = (now_ms() / 1000) as u64;
        if timestamp > now.saturating_add(15) || timestamp.saturating_add(120) < now {
            return Err(ReceiptError::Invalid);
        }
    }
    let finalized = checkpoint(&rpc.block("finalized").await?)?;
    if finalized.number > head.number {
        return Err(ReceiptError::Invalid);
    }
    let mut observations = Vec::new();
    let mut checked = std::collections::BTreeMap::new();
    checked.insert(head.number, head.hash);
    checked.insert(finalized.number, finalized.hash);
    if head.number == finalized.number && head.hash != finalized.hash {
        return Err(ReceiptError::Reorg);
    }
    if let Some(anchor) = &c.anchor
        && (finalized.number < anchor.number
            || checked
                .insert(anchor.number, anchor.hash)
                .is_some_and(|hash| hash != anchor.hash))
    {
        return Err(ReceiptError::Reorg);
    }
    let mut previous_position = None;
    for expected in &c.expected {
        let receipt = rpc.receipt(&format!("{:#x}", expected.hash)).await?;
        if receipt.is_null() {
            observations.push(ReceiptObservation {
                transaction_hash: format!("{:#x}", expected.hash),
                inclusion: None,
            });
            continue;
        }
        let number = u64_quantity(&receipt["blockNumber"])?;
        let block_hash = hash(&receipt["blockHash"])?;
        let index = u64_quantity(&receipt["transactionIndex"])?;
        let gas = u64_quantity(&receipt["gasUsed"])?;
        let price = quantity(&receipt["effectiveGasPrice"])?;
        let status = u64_quantity(&receipt["status"])?;
        if hash(&receipt["transactionHash"])? != expected.hash
            || address(&receipt["from"])? != expected.sender
            || address(&receipt["to"])? != expected.recipient
            || !receipt["contractAddress"].is_null()
            || u64_quantity(&receipt["type"])? != 2
            || status > 1
            || gas < 21000
            || gas > expected.gas_limit
            || price > expected.max_fee
            || number > head.number
            || index > 100000
        {
            return Err(ReceiptError::Invalid);
        }
        let block = rpc.block(&format!("0x{number:x}")).await?;
        let canonical = checkpoint(&block)?;
        if canonical.number != number || canonical.hash != block_hash {
            return Err(ReceiptError::Reorg);
        }
        let base_fee = quantity(&block["baseFeePerGas"])?;
        let expected_price = base_fee
            .checked_add(expected.priority_fee)
            .ok_or(ReceiptError::Invalid)?
            .min(expected.max_fee);
        if base_fee > expected.max_fee || price != expected_price {
            return Err(ReceiptError::Invalid);
        }
        let list = block["transactions"]
            .as_array()
            .ok_or(ReceiptError::Invalid)?;
        if list
            .get(index as usize)
            .map(hash)
            .transpose()?
            .is_none_or(|h| h != expected.hash)
        {
            return Err(ReceiptError::Invalid);
        }
        if checked
            .insert(number, block_hash)
            .is_some_and(|old| old != block_hash)
        {
            return Err(ReceiptError::Reorg);
        }
        if previous_position.is_some_and(|old| old >= (number, index)) {
            return Err(ReceiptError::Invalid);
        }
        previous_position = Some((number, index));
        observations.push(ReceiptObservation {
            transaction_hash: format!("{:#x}", expected.hash),
            inclusion: Some(Inclusion {
                block_number: number.to_string(),
                block_hash: format!("{block_hash:#x}"),
                transaction_index: index.to_string(),
                succeeded: status == 1,
                finalized: number <= finalized.number,
                gas_used: gas.to_string(),
                effective_gas_price: price.to_string(),
            }),
        });
    }
    // Detect branch changes across the multi-request read. A provider that lies
    // consistently is outside this check; it must be controlled/approved infrastructure.
    for (number, expected) in checked {
        let current = checkpoint(&rpc.block(&format!("0x{number:x}")).await?)?;
        if current.number != number || current.hash != expected {
            return Err(ReceiptError::Reorg);
        }
    }
    Ok(VerifiedReconciliation {
        operation: c.operation,
        plan_hash: c.plan_hash.clone(),
        chain: c.chain,
        observations,
        head,
        finalized,
        observed_at_ms: now_ms(),
        anchor: c.anchor.clone(),
    })
}
fn conflict() -> AppError {
    AppError::Conflict("receipt evidence or operation changed".into())
}
impl WorkStore {
    /// Commit verified receipt changes under the current worker lease. Unchanged
    /// pending polls refresh the proof and defer the same job without history growth.
    #[tracing::instrument(name = "work.reconcile", skip_all)]
    pub async fn record_reconciliation(
        &self,
        lease: &JobLease,
        report: &VerifiedReconciliation,
    ) -> std::result::Result<(), AppError> {
        if lease.operation_id != report.operation {
            return Err(conflict());
        }
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let live:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND operation_id=$2 AND operation_version=$3 AND lease_token=$4 AND state='leased' AND lease_until>clock_timestamp() FOR UPDATE")
            .bind(lease.id).bind(lease.operation_id).bind(lease.operation_version).bind(lease.token).fetch_optional(&mut *tx).await.map_err(unavailable)?;
        if live.is_none() {
            return Err(conflict());
        }
        let row=sqlx::query("SELECT o.state,o.action,o.wallet_id,s.chain_id,s.plan_hash,s.step_count FROM operations o JOIN evm_submissions s ON s.operation_id=o.id WHERE o.id=$1 AND o.version=$2 FOR UPDATE OF o")
            .bind(lease.operation_id).bind(lease.operation_version).fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or_else(conflict)?;
        let state: String = row.try_get("state").map_err(unavailable)?;
        if !["signed", "unknown", "confirming"].contains(&state.as_str())
            || row.try_get::<i64, _>("chain_id").map_err(unavailable)? as u64 != report.chain
            || hex::encode(
                row.try_get::<Vec<u8>, _>("plan_hash")
                    .map_err(unavailable)?,
            ) != report.plan_hash
            || row.try_get::<i16, _>("step_count").map_err(unavailable)? as usize
                != report.observations.len()
        {
            return Err(conflict());
        }
        let hashes:Vec<String>=sqlx::query_scalar("SELECT '0x'||encode(tx_hash,'hex') FROM evm_signed_transactions WHERE operation_id=$1 ORDER BY step").bind(report.operation).fetch_all(&mut *tx).await.map_err(unavailable)?;
        if hashes
            != report
                .observations
                .iter()
                .map(|o| o.transaction_hash.clone())
                .collect::<Vec<_>>()
        {
            return Err(conflict());
        }
        let now: i64 =
            sqlx::query_scalar("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
        if report.observed_at_ms > now || report.observed_at_ms < now - 10000 {
            return Err(conflict());
        }
        let old=sqlx::query("SELECT c.batch_id,c.finalized_number::text AS finalized_number,c.finalized_hash,c.checked_at,b.observations_hash,b.observations_json FROM evm_reconciliation_current c JOIN evm_reconciliation_batches b ON b.id=c.batch_id WHERE c.operation_id=$1")
            .bind(report.operation).fetch_optional(&mut *tx).await.map_err(unavailable)?;
        if let Some(ref old) = old {
            let previous = decode_observations(
                &old.try_get::<String, _>("observations_json")
                    .map_err(unavailable)?,
                &old.try_get::<Vec<u8>, _>("observations_hash")
                    .map_err(unavailable)?,
            )?;
            if previous.len() != report.observations.len()
                || previous
                    .iter()
                    .zip(&report.observations)
                    .any(|(before, after)| {
                        before.inclusion.as_ref().is_some_and(|i| i.finalized) && before != after
                    })
            {
                return Err(conflict());
            }

            let old_number = old
                .try_get::<String, _>("finalized_number")
                .map_err(unavailable)?
                .parse::<u64>()
                .map_err(|_| AppError::Busy)?;
            if report.anchor.as_ref().is_none_or(|anchor| {
                anchor.number != old_number
                    || anchor.hash.as_slice()
                        != old
                            .try_get::<Vec<u8>, _>("finalized_hash")
                            .unwrap_or_default()
            }) {
                return Err(conflict());
            }
            let old_checked: OffsetDateTime = old.try_get("checked_at").map_err(unavailable)?;
            if report.finalized.number < old_number
                || (report.finalized.number == old_number
                    && old
                        .try_get::<Vec<u8>, _>("finalized_hash")
                        .map_err(unavailable)?
                        != report.finalized.hash.as_slice())
                || i128::from(report.observed_at_ms) * 1_000_000
                    < old_checked.unix_timestamp_nanos()
            {
                return Err(conflict());
            }
        }
        let observations =
            serde_json::to_string(&report.observations).map_err(|_| AppError::Busy)?;
        let fingerprint = digest(observations.as_bytes());
        let unchanged = old.as_ref().is_some_and(|r| {
            r.try_get::<Vec<u8>, _>("observations_hash").ok().as_ref() == Some(&fingerprint)
        });
        let batch = if unchanged {
            old.as_ref()
                .unwrap()
                .try_get::<Uuid, _>("batch_id")
                .map_err(unavailable)?
        } else {
            Uuid::new_v4()
        };
        let observed = OffsetDateTime::from_unix_timestamp_nanos(
            i128::from(report.observed_at_ms) * 1_000_000,
        )
        .map_err(|_| AppError::Busy)?;
        if !unchanged {
            sqlx::query("INSERT INTO evm_reconciliation_batches(id,operation_id,observations_json,observations_hash,observed_at,head_number,head_hash,finalized_number,finalized_hash) VALUES ($1,$2,$3,$4,$5,$6::text::numeric,$7,$8::text::numeric,$9)")
                .bind(batch).bind(report.operation).bind(observations).bind(fingerprint).bind(observed).bind(report.head.number.to_string()).bind(report.head.hash.as_slice()).bind(report.finalized.number.to_string()).bind(report.finalized.hash.as_slice()).execute(&mut *tx).await.map_err(unavailable)?;
        }
        sqlx::query("INSERT INTO evm_reconciliation_current(operation_id,batch_id,checked_at,head_number,head_hash,finalized_number,finalized_hash) VALUES ($1,$2,$3,$4::text::numeric,$5,$6::text::numeric,$7) ON CONFLICT(operation_id) DO UPDATE SET batch_id=EXCLUDED.batch_id,checked_at=EXCLUDED.checked_at,head_number=EXCLUDED.head_number,head_hash=EXCLUDED.head_hash,finalized_number=EXCLUDED.finalized_number,finalized_hash=EXCLUDED.finalized_hash")
            .bind(report.operation).bind(batch).bind(observed).bind(report.head.number.to_string()).bind(report.head.hash.as_slice()).bind(report.finalized.number.to_string()).bind(report.finalized.hash.as_slice()).execute(&mut *tx).await.map_err(unavailable)?;
        let all_final = report
            .observations
            .iter()
            .all(|o| o.inclusion.as_ref().is_some_and(|i| i.finalized));
        let any_reverted = report
            .observations
            .iter()
            .any(|o| o.inclusion.as_ref().is_some_and(|i| !i.succeeded));
        let any_included = report.observations.iter().any(|o| o.inclusion.is_some());
        let bridge_deposited = row.try_get::<String, _>("action").map_err(unavailable)? == "bridge"
            && report
                .observations
                .last()
                .and_then(|o| o.inclusion.as_ref())
                .is_some_and(|i| i.succeeded);
        let next = if all_final {
            if bridge_deposited {
                "bridging"
            } else if any_reverted {
                "failed"
            } else {
                "succeeded"
            }
        } else if any_reverted {
            "unknown"
        } else if any_included {
            "confirming"
        } else if state == "signed" {
            "signed"
        } else {
            "unknown"
        };
        let still_live:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()) AND $3 >= (extract(epoch FROM clock_timestamp())*1000)::bigint-10000")
            .bind(lease.id).bind(lease.token).bind(report.observed_at_ms).fetch_one(&mut *tx).await.map_err(unavailable)?;
        if !still_live {
            return Err(conflict());
        }
        if unchanged && state == next {
            sqlx::query("UPDATE jobs SET state='ready',lease_token=NULL,lease_until=NULL,attempts=0,available_at=clock_timestamp()+interval '5 seconds' WHERE id=$1").bind(lease.id).execute(&mut *tx).await.map_err(unavailable)?;
        } else {
            crate::submissions::advance(
                &mut tx,
                report.operation,
                lease.id,
                lease.operation_version,
                next,
            )
            .await?;
        }
        if all_final {
            sqlx::query("DELETE FROM evm_wallet_guards WHERE operation_id=$1 AND wallet_id=$2")
                .bind(report.operation)
                .bind(row.try_get::<Uuid, _>("wallet_id").map_err(unavailable)?)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(())
    }
}
