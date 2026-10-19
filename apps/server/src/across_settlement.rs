//! Durable destination settlement. Provider reports only nominate transactions;
//! only a freshly verified source deposit and destination fill can complete a bridge.
use crate::{
    bridge_monitor::decode_binding,
    error::AppError,
    identity::{digest, unavailable},
    providers::{across_evidence::VerifiedAcrossFill, bridge_status::BridgeProvider},
    reconciliation::decode_observations,
    work::{Action, JobLease, WorkStore},
};
use serde_json::Value;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

/// Public audit summary, never an input to a financial state transition.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcrossDeliverySummary {
    pub evidence_version: String,
    pub operation_version: String,
    pub source_chain_id: String,
    pub source_transaction_hash: String,
    pub destination_chain_id: String,
    pub destination_transaction_hash: String,
    pub recipient: String,
    pub output_token: String,
    pub delivered_amount_raw: String,
    pub source: DeliveryAnchor,
    pub destination: DeliveryAnchor,
    pub verified_at_ms: i64,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryAnchor {
    pub block_number: String,
    pub block_hash: String,
    pub finalized_number: String,
    pub finalized_hash: String,
}
fn audit_anchor(value: &Value) -> Result<DeliveryAnchor, AppError> {
    let number = value["blockNumber"].as_u64().ok_or(AppError::Busy)?;
    let finalized = value["finalizedNumber"].as_u64().ok_or(AppError::Busy)?;
    if finalized < number {
        return Err(AppError::Busy);
    }
    Ok(DeliveryAnchor {
        block_number: number.to_string(),
        block_hash: audit_hash(&value["blockHash"])?,
        finalized_number: finalized.to_string(),
        finalized_hash: audit_hash(&value["finalizedHash"])?,
    })
}
fn audit_hash(value: &Value) -> Result<String, AppError> {
    let hash = value
        .as_str()
        .ok_or(AppError::Busy)?
        .parse::<alloy_primitives::B256>()
        .map_err(|_| AppError::Busy)?;
    if hash == alloy_primitives::B256::ZERO {
        return Err(AppError::Busy);
    }
    Ok(format!("{hash:#x}"))
}
fn audit_anchor_matches(
    row: &sqlx::postgres::PgRow,
    value: &Value,
    prefix: &str,
) -> Result<DeliveryAnchor, AppError> {
    let anchor = audit_anchor(value)?;
    let block_number: String = row
        .try_get(format!("{prefix}_block_number_text").as_str())
        .map_err(unavailable)?;
    let block_hash: Vec<u8> = row
        .try_get(format!("{prefix}_block_hash").as_str())
        .map_err(unavailable)?;
    let finalized_number: String = row
        .try_get(format!("{prefix}_finalized_number_text").as_str())
        .map_err(unavailable)?;
    let finalized_hash: Vec<u8> = row
        .try_get(format!("{prefix}_finalized_hash").as_str())
        .map_err(unavailable)?;
    if anchor.block_number != block_number
        || anchor.block_hash != format!("0x{}", hex::encode(block_hash))
        || anchor.finalized_number != finalized_number
        || anchor.finalized_hash != format!("0x{}", hex::encode(finalized_hash))
    {
        return Err(AppError::Busy);
    }
    Ok(anchor)
}

fn conflict() -> AppError {
    AppError::Conflict("Across delivery evidence or operation changed".into())
}

impl WorkStore {
    /// Owner-scoped historical verified outcome. Stored JSON is decoded only into
    /// an audit view; it can never reconstruct VerifiedAcrossFill authority.
    pub async fn across_delivery(
        &self,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<Option<AcrossDeliverySummary>, AppError> {
        let row=sqlx::query("SELECT s.*,s.source_block_number::text AS source_block_number_text,s.source_finalized_number::text AS source_finalized_number_text,s.destination_block_number::text AS destination_block_number_text,s.destination_finalized_number::text AS destination_finalized_number_text,o.action AS operation_action,o.state AS operation_state,o.version AS current_version,i.canonical_json AS intent_json,w.binding_json,w.binding_hash,w.provider AS watch_provider,w.stopped_at,w.source_transaction_id AS watch_source_transaction_id,st.tx_hash AS signed_source_tx_hash,st.chain_id AS signed_source_chain FROM operations o JOIN operation_intents i ON i.operation_id=o.id LEFT JOIN across_settlements s ON s.operation_id=o.id LEFT JOIN bridge_status_watches w ON w.operation_id=o.id LEFT JOIN evm_signed_transactions st ON st.id=s.source_transaction_id WHERE o.id=$1 AND o.user_id=$2 AND o.wallet_id=$3")
            .bind(operation).bind(user).bind(wallet).fetch_optional(&self.pool).await.map_err(unavailable)?.ok_or(AppError::NotFound)?;
        if row
            .try_get::<Option<Uuid>, _>("operation_id")
            .map_err(unavailable)?
            .is_none()
        {
            return Ok(None);
        }
        let json: String = row.try_get("proof_json").map_err(unavailable)?;
        if digest(json.as_bytes())
            != row
                .try_get::<Vec<u8>, _>("proof_hash")
                .map_err(unavailable)?
            || row
                .try_get::<String, _>("operation_state")
                .map_err(unavailable)?
                != "succeeded"
            || row
                .try_get::<i64, _>("operation_version")
                .map_err(unavailable)?
                != row
                    .try_get::<i64, _>("current_version")
                    .map_err(unavailable)?
        {
            return Err(AppError::Busy);
        }
        let audit: Value = serde_json::from_str(&json).map_err(|_| AppError::Busy)?;
        let terms: crate::providers::across_evidence::DirectDepositTerms =
            serde_json::from_value(audit["deposit"]["terms"].clone())
                .map_err(|_| AppError::Busy)?;
        terms.validate().map_err(|_| AppError::Busy)?;
        let binding = decode_binding(&row)?;
        let intent: Value = serde_json::from_str(
            &row.try_get::<String, _>("intent_json")
                .map_err(unavailable)?,
        )
        .map_err(|_| AppError::Busy)?;
        let operation_action: String = row.try_get("operation_action").map_err(unavailable)?;
        let watch_provider: String = row.try_get("watch_provider").map_err(unavailable)?;
        let stopped_at: Option<OffsetDateTime> = row.try_get("stopped_at").map_err(unavailable)?;
        let watch_source: Uuid = row
            .try_get("watch_source_transaction_id")
            .map_err(unavailable)?;
        let settlement_source: Uuid = row.try_get("source_transaction_id").map_err(unavailable)?;
        let signed_source_hash: Vec<u8> =
            row.try_get("signed_source_tx_hash").map_err(unavailable)?;
        let signed_source_chain: i64 = row.try_get("signed_source_chain").map_err(unavailable)?;
        let source_hash = audit_hash(&audit["deposit"]["source"]["transactionHash"])?;
        let deposit_id = audit["deposit"]["depositId"]
            .as_str()
            .ok_or(AppError::Busy)?;
        let intent_terms = binding
            .across_intent_terms(&intent)
            .map_err(|_| AppError::Busy)?;
        if operation_action != "bridge"
            || binding.provider != BridgeProvider::Across
            || watch_provider != "across"
            || stopped_at.is_none()
            || watch_source != settlement_source
            || signed_source_chain != terms.source_chain as i64
            || signed_source_hash
                != hex::decode(&binding.source_transaction_hash[2..]).map_err(|_| AppError::Busy)?
            || source_hash != binding.source_transaction_hash
            || deposit_id != binding.provider_reference
            || binding.source_chain_id != terms.source_chain.to_string()
            || binding.destination_chain_id != terms.destination_chain.to_string()
            || intent_terms != terms
        {
            return Err(AppError::Busy);
        }
        if terms.source_chain
            != row
                .try_get::<i64, _>("source_chain_id")
                .map_err(unavailable)? as u64
            || terms.destination_chain
                != row
                    .try_get::<i64, _>("destination_chain_id")
                    .map_err(unavailable)? as u64
        {
            return Err(AppError::Busy);
        }
        let source = audit_anchor_matches(&row, &audit["deposit"]["source"], "source")?;
        let destination = audit_anchor_matches(&row, &audit["destination"], "destination")?;
        let destination_hash = audit_hash(&audit["destination"]["transactionHash"])?;
        let stored_destination_hash: Vec<u8> = row
            .try_get("destination_transaction_hash")
            .map_err(unavailable)?;
        if source_hash != format!("0x{}", hex::encode(signed_source_hash))
            || destination_hash != format!("0x{}", hex::encode(stored_destination_hash))
        {
            return Err(AppError::Busy);
        }
        let checked_at_ms = audit["checkedAtMs"].as_i64().ok_or(AppError::Busy)?;
        let checked_at: OffsetDateTime = row.try_get("checked_at").map_err(unavailable)?;
        let current_ms = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
        if checked_at_ms <= 0
            || checked_at_ms > current_ms
            || (checked_at.unix_timestamp_nanos() / 1_000_000) as i64 != checked_at_ms
        {
            return Err(AppError::Busy);
        }
        Ok(Some(AcrossDeliverySummary {
            evidence_version: row
                .try_get::<i16, _>("evidence_version")
                .map_err(unavailable)?
                .to_string(),
            operation_version: row
                .try_get::<i64, _>("operation_version")
                .map_err(unavailable)?
                .to_string(),
            source_chain_id: terms.source_chain.to_string(),
            source_transaction_hash: audit_hash(&audit["deposit"]["source"]["transactionHash"])?,
            destination_chain_id: terms.destination_chain.to_string(),
            destination_transaction_hash: audit_hash(&audit["destination"]["transactionHash"])?,
            recipient: format!("{:#x}", terms.recipient),
            output_token: format!("{:#x}", terms.output_token),
            delivered_amount_raw: terms.output_amount.to_string(),
            source,
            destination,
            verified_at_ms: checked_at_ms,
        }))
    }
    /// The lease and private proof are internal capabilities, never client JSON.
    /// A repeated exact proof with the original completed lease is an idempotent
    /// acknowledgement after its original freshness check; later retries read
    /// the owner-scoped stored outcome instead.
    #[tracing::instrument(name = "work.across_delivery", skip_all)]
    pub async fn complete_across_delivery(
        &self,
        lease: &JobLease,
        proof: &VerifiedAcrossFill,
    ) -> Result<(), AppError> {
        let deposit = proof.deposit();
        let terms = deposit.terms();
        let source = deposit.source();
        let destination = proof.destination();
        let proof_json = serde_json::to_string(proof).map_err(|_| AppError::Busy)?;
        let proof_hash = digest(proof_json.as_bytes());
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        // Lock order matches source reconciliation and submission writers.
        let job = sqlx::query("SELECT state,lease_token,lease_until FROM jobs WHERE id=$1 AND operation_id=$2 AND operation_version=$3 FOR UPDATE")
            .bind(lease.id).bind(lease.operation_id).bind(lease.operation_version)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or_else(conflict)?;
        let operation = sqlx::query("SELECT o.state,o.version,o.action,o.user_id,o.wallet_id,o.intent_hash,i.canonical_json,s.chain_id,s.signer,s.wallet_id AS submission_wallet,s.step_count,m.user_id AS member_user,m.chain_id AS member_chain,m.address AS member_address FROM operations o JOIN operation_intents i ON i.operation_id=o.id JOIN evm_submissions s ON s.operation_id=o.id JOIN wallet_memberships m ON m.id=o.wallet_id WHERE o.id=$1 FOR UPDATE OF o")
            .bind(lease.operation_id).fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or_else(conflict)?;
        let now: i64 =
            sqlx::query_scalar("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
        let state: String = operation.try_get("state").map_err(unavailable)?;
        let version: i64 = operation.try_get("version").map_err(unavailable)?;
        let existing = sqlx::query("SELECT proof_hash,proof_json,completed_job_id,completed_lease_token,operation_version FROM across_settlements WHERE operation_id=$1")
            .bind(lease.operation_id).fetch_optional(&mut *tx).await.map_err(unavailable)?;
        if let Some(existing) = existing {
            if state != "succeeded"
                || version != lease.operation_version + 1
                || existing
                    .try_get::<i64, _>("operation_version")
                    .map_err(unavailable)?
                    != version
                || existing
                    .try_get::<Uuid, _>("completed_job_id")
                    .map_err(unavailable)?
                    != lease.id
                || existing
                    .try_get::<Uuid, _>("completed_lease_token")
                    .map_err(unavailable)?
                    != lease.token
                || existing
                    .try_get::<Vec<u8>, _>("proof_hash")
                    .map_err(unavailable)?
                    != proof_hash
                || existing
                    .try_get::<String, _>("proof_json")
                    .map_err(unavailable)?
                    != proof_json
                || job.try_get::<String, _>("state").map_err(unavailable)? != "done"
            {
                return Err(conflict());
            }
            tx.commit().await.map_err(unavailable)?;
            return Ok(());
        }
        // A fresh proof is mandatory for the first financial write. An exact
        // replay of a committed proof is only an acknowledgement and remains
        // idempotent after the original observation's freshness window.
        if [proof.checked_at_ms(), deposit.checked_at_ms()]
            .iter()
            .any(|at| *at > now || *at < now - 10_000)
        {
            return Err(conflict());
        }
        let user: Uuid = operation.try_get("user_id").map_err(unavailable)?;
        let wallet: Uuid = operation.try_get("wallet_id").map_err(unavailable)?;
        let lease_until: OffsetDateTime = job
            .try_get::<Option<OffsetDateTime>, _>("lease_until")
            .map_err(unavailable)?
            .ok_or_else(conflict)?;
        if state != "bridging"
            || version != lease.operation_version
            || operation
                .try_get::<String, _>("action")
                .map_err(unavailable)?
                != "bridge"
            || operation
                .try_get::<Uuid, _>("submission_wallet")
                .map_err(unavailable)?
                != wallet
            || operation
                .try_get::<Uuid, _>("member_user")
                .map_err(unavailable)?
                != user
            || operation
                .try_get::<i64, _>("chain_id")
                .map_err(unavailable)? as u64
                != terms.source_chain
            || operation
                .try_get::<i64, _>("member_chain")
                .map_err(unavailable)? as u64
                != terms.source_chain
            || operation
                .try_get::<Vec<u8>, _>("signer")
                .map_err(unavailable)?
                != terms.depositor.as_slice()
            || operation
                .try_get::<Vec<u8>, _>("member_address")
                .map_err(unavailable)?
                != terms.depositor.as_slice()
            || job.try_get::<String, _>("state").map_err(unavailable)? != "leased"
            || job
                .try_get::<Option<Uuid>, _>("lease_token")
                .map_err(unavailable)?
                != Some(lease.token)
        {
            return Err(conflict());
        }
        let canonical: String = operation.try_get("canonical_json").map_err(unavailable)?;
        let intent: Value = serde_json::from_str(&canonical).map_err(|_| AppError::Busy)?;
        let expected_intent_hash = digest(
            &serde_json::to_vec(&(1, wallet, Action::Bridge, &intent))
                .map_err(|_| AppError::Busy)?,
        );
        if serde_json::to_string(&intent).map_err(|_| AppError::Busy)? != canonical
            || operation
                .try_get::<Vec<u8>, _>("intent_hash")
                .map_err(unavailable)?
                != expected_intent_hash
        {
            return Err(conflict());
        }
        let watch =
            sqlx::query("SELECT * FROM bridge_status_watches WHERE operation_id=$1 FOR UPDATE")
                .bind(lease.operation_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(unavailable)?
                .ok_or_else(conflict)?;
        let binding = decode_binding(&watch)?;
        if binding.provider != BridgeProvider::Across
            || binding.provider_reference != deposit.deposit_id()
            || binding.source_chain_id != terms.source_chain.to_string()
            || binding.destination_chain_id != terms.destination_chain.to_string()
            || binding.refund_chain_id != terms.source_chain.to_string()
            || binding.source_transaction_hash != format!("{:#x}", source.transaction_hash)
            || binding.across_intent_terms(&intent)? != *terms
            || watch
                .try_get::<Option<OffsetDateTime>, _>("stopped_at")
                .map_err(unavailable)?
                .is_some()
        {
            return Err(conflict());
        }
        let source_id: Uuid = watch
            .try_get("source_transaction_id")
            .map_err(unavailable)?;
        let hashes = sqlx::query(
            "SELECT id,tx_hash FROM evm_signed_transactions WHERE operation_id=$1 ORDER BY step",
        )
        .bind(lease.operation_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        if hashes.len()
            != operation
                .try_get::<i16, _>("step_count")
                .map_err(unavailable)? as usize
            || hashes.last().is_none_or(|r| {
                r.try_get::<Uuid, _>("id").ok() != Some(source_id)
                    || r.try_get::<Vec<u8>, _>("tx_hash").ok().as_deref()
                        != Some(source.transaction_hash.as_slice())
            })
        {
            return Err(conflict());
        }
        let reconciliation = sqlx::query("SELECT b.observations_json,b.observations_hash,c.finalized_number::text AS finalized_number,c.finalized_hash FROM evm_reconciliation_current c JOIN evm_reconciliation_batches b ON b.id=c.batch_id AND b.operation_id=c.operation_id WHERE c.operation_id=$1")
            .bind(lease.operation_id).fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or_else(conflict)?;
        let observations = decode_observations(
            &reconciliation
                .try_get::<String, _>("observations_json")
                .map_err(unavailable)?,
            &reconciliation
                .try_get::<Vec<u8>, _>("observations_hash")
                .map_err(unavailable)?,
        )?;
        if observations.len() != hashes.len()
            || observations.iter().zip(&hashes).any(|(observation, row)| {
                row.try_get::<Vec<u8>, _>("tx_hash")
                    .ok()
                    .is_none_or(|hash| {
                        observation.transaction_hash != format!("0x{}", hex::encode(hash))
                    })
                    || observation.inclusion.as_ref().is_none_or(|i| !i.finalized)
            })
        {
            return Err(conflict());
        }
        let source_inclusion = observations
            .last()
            .and_then(|o| o.inclusion.as_ref())
            .ok_or_else(conflict)?;
        let previous_finalized = reconciliation
            .try_get::<String, _>("finalized_number")
            .map_err(unavailable)?
            .parse::<u64>()
            .map_err(|_| AppError::Busy)?;
        if !source_inclusion.succeeded
            || source_inclusion.block_number != source.block_number.to_string()
            || source_inclusion.block_hash != format!("{:#x}", source.block_hash)
            || source.finalized_number < previous_finalized
            || (source.finalized_number == previous_finalized
                && reconciliation
                    .try_get::<Vec<u8>, _>("finalized_hash")
                    .map_err(unavailable)?
                    != source.finalized_hash.as_slice())
        {
            return Err(conflict());
        }
        let checked_at = OffsetDateTime::from_unix_timestamp_nanos(
            i128::from(proof.checked_at_ms()) * 1_000_000,
        )
        .map_err(|_| AppError::Busy)?;
        sqlx::query("INSERT INTO across_settlements(operation_id,operation_version,evidence_version,source_transaction_id,completed_job_id,completed_lease_token,proof_json,proof_hash,source_chain_id,destination_chain_id,source_block_number,source_block_hash,source_finalized_number,source_finalized_hash,destination_transaction_hash,destination_block_number,destination_block_hash,destination_finalized_number,destination_finalized_hash,checked_at) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10::text::numeric,$11,$12::text::numeric,$13,$14,$15::text::numeric,$16,$17::text::numeric,$18,$19)")
            .bind(lease.operation_id).bind(version+1).bind(source_id).bind(lease.id).bind(lease.token).bind(proof_json).bind(proof_hash)
            .bind(terms.source_chain as i64).bind(terms.destination_chain as i64)
            .bind(source.block_number.to_string()).bind(source.block_hash.as_slice()).bind(source.finalized_number.to_string()).bind(source.finalized_hash.as_slice())
            .bind(destination.transaction_hash.as_slice()).bind(destination.block_number.to_string()).bind(destination.block_hash.as_slice()).bind(destination.finalized_number.to_string()).bind(destination.finalized_hash.as_slice()).bind(checked_at)
            .execute(&mut *tx).await.map_err(unavailable)?;
        let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND lease_token=$2 AND state='leased' AND lease_until>clock_timestamp()) AND $3 BETWEEN (extract(epoch FROM clock_timestamp())*1000)::bigint-10000 AND (extract(epoch FROM clock_timestamp())*1000)::bigint")
            .bind(lease.id).bind(lease.token).bind(proof.checked_at_ms().min(deposit.checked_at_ms())).fetch_one(&mut *tx).await.map_err(unavailable)?;
        if !live {
            return Err(conflict());
        }
        crate::submissions::advance(&mut tx, lease.operation_id, lease.id, version, "succeeded")
            .await?;
        sqlx::query("UPDATE bridge_status_watches SET stopped_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,poll_version=poll_version+1 WHERE operation_id=$1")
            .bind(lease.operation_id).execute(&mut *tx).await.map_err(unavailable)?;
        // Recheck after all potentially waiting writes, immediately before commit.
        let fresh: bool = sqlx::query_scalar("SELECT $1 >= (extract(epoch FROM clock_timestamp())*1000)::bigint-10000 AND $2 > clock_timestamp()")
            .bind(proof.checked_at_ms().min(deposit.checked_at_ms())).bind(lease_until).fetch_one(&mut *tx).await.map_err(unavailable)?;
        if !fresh {
            return Err(conflict());
        }
        tx.commit().await.map_err(unavailable)
    }
}

#[cfg(test)]
mod tests;
