//! Durable signed authorization and initial dispatch journal. Internal service API:
//! no HTTP submit endpoint, RPC broadcaster, receipt finality or retry permission.
use crate::{
    error::AppError,
    evm_envelope::VerifiedEvmBundle,
    identity::unavailable,
    work::{JobLease, WorkStore},
};
use alloy_primitives::keccak256;
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
};
use serde::Serialize;
use sqlx::{PgConnection, Row};
use std::collections::BTreeMap;
use uuid::Uuid;
use zeroize::Zeroizing;

fn conflict() -> AppError {
    AppError::Conflict("submission state changed; recover operation".into())
}
fn invalid() -> AppError {
    AppError::BadRequest("invalid submission evidence".into())
}

/// Operator-supplied application data-encryption keys, NOT wallet signing keys.
/// No default/env loading or Debug/Serialize. Retain old keys for restart recovery.
pub struct SubmissionKeys {
    active: String,
    keys: BTreeMap<String, Zeroizing<[u8; 32]>>,
}
impl SubmissionKeys {
    pub fn new(
        active: String,
        keys: BTreeMap<String, Zeroizing<[u8; 32]>>,
    ) -> Result<Self, AppError> {
        if keys.is_empty()
            || keys.len() > 4
            || !keys.contains_key(&active)
            || keys.keys().any(|s| {
                s.is_empty()
                    || s.len() > 64
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            })
        {
            return Err(invalid());
        }
        Ok(Self { active, keys })
    }
    fn cipher(&self, id: &str) -> Result<XChaCha20Poly1305, AppError> {
        let key = self.keys.get(id).ok_or(AppError::Busy)?;
        XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| AppError::Busy)
    }
    pub(crate) fn active_id(&self) -> &str {
        &self.active
    }
    pub(crate) fn seal(&self, aad: &[u8], bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>), AppError> {
        if bytes.is_empty() || bytes.len() > 262144 {
            return Err(invalid());
        }
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let encrypted = self
            .cipher(&self.active)?
            .encrypt(&nonce, Payload { msg: bytes, aad })
            .map_err(|_| AppError::Busy)?;
        Ok((nonce.to_vec(), encrypted))
    }
    fn open(
        &self,
        id: &str,
        nonce: &[u8],
        aad: &[u8],
        bytes: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, AppError> {
        self.open_bounded(id, nonce, aad, bytes, 66560)
    }
    pub(crate) fn open_bounded(
        &self,
        id: &str,
        nonce: &[u8],
        aad: &[u8],
        bytes: &[u8],
        maximum_plaintext: usize,
    ) -> Result<Zeroizing<Vec<u8>>, AppError> {
        if maximum_plaintext > 262144
            || nonce.len() != 24
            || !(17..=maximum_plaintext + 16).contains(&bytes.len())
        {
            return Err(AppError::Busy);
        }
        self.cipher(id)?
            .decrypt(XNonce::from_slice(nonce), Payload { msg: bytes, aad })
            .map(Zeroizing::new)
            .map_err(|_| AppError::Busy)
    }
}
struct EnvelopeContext<'a> {
    operation: Uuid,
    plan_hash: &'a str,
    step: usize,
    chain: u64,
    signer: &'a [u8],
    nonce: u64,
    hash: &'a [u8],
    key: &'a str,
}
impl EnvelopeContext<'_> {
    fn aad(&self) -> Result<Vec<u8>, AppError> {
        serde_json::to_vec(&(
            "honey.evm.signed.v1",
            self.operation,
            self.plan_hash,
            self.step,
            self.chain,
            hex::encode(self.signer),
            self.nonce.to_string(),
            hex::encode(self.hash),
            self.key,
        ))
        .map_err(|_| AppError::Busy)
    }
}
/// A trusted chain observation, never deserialized from a public request.
/// Caller must read the proven account's latest/pending nonce and revalidate
/// provider/account/fee/simulation policy before requesting an initial dispatch.
#[derive(Clone, Copy)]
pub struct NonceObservation {
    pub nonce: u64,
    pub observed_at_ms: i64,
}

pub struct StageSubmission<'a> {
    pub user: Uuid,
    pub wallet: Uuid,
    pub operation: Uuid,
    pub expected_version: i64,
    pub bundle: &'a VerifiedEvmBundle,
    pub nonce: NonceObservation,
}
#[derive(Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionSummary {
    pub operation_id: Uuid,
    pub transaction_hashes: Vec<String>,
}

/// Persisted dispatch intent, returned only after commit. No Debug/Serialize/Clone.
/// A crash after commit leaves an unknown outcome; recover by transaction hash.
pub struct InitialDispatch {
    attempt_id: Uuid,
    hash: Vec<u8>,
    raw: Zeroizing<Vec<u8>>,
}
impl InitialDispatch {
    pub fn attempt_id(&self) -> Uuid {
        self.attempt_id
    }
    pub fn transaction_hash(&self) -> String {
        format!("0x{}", hex::encode(&self.hash))
    }
    pub fn expose_signed_bytes(&self) -> &[u8] {
        &self.raw
    }
}
#[derive(Clone, Copy)]
pub enum DispatchObservation {
    Acknowledged,
    Unknown,
}
impl DispatchObservation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Acknowledged => "acknowledged",
            Self::Unknown => "unknown",
        }
    }
}
fn fresh(n: NonceObservation, now: i64) -> bool {
    n.observed_at_ms > 0 && n.observed_at_ms <= now && now - n.observed_at_ms <= 10000
}
async fn now(tx: &mut PgConnection) -> Result<i64, AppError> {
    sqlx::query_scalar("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
        .fetch_one(tx)
        .await
        .map_err(unavailable)
}
async fn summary(tx: &mut PgConnection, id: Uuid) -> Result<SubmissionSummary, AppError> {
    let hashes: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT tx_hash FROM evm_signed_transactions WHERE operation_id=$1 ORDER BY step",
    )
    .bind(id)
    .fetch_all(tx)
    .await
    .map_err(unavailable)?;
    Ok(SubmissionSummary {
        operation_id: id,
        transaction_hashes: hashes
            .iter()
            .map(|h| format!("0x{}", hex::encode(h)))
            .collect(),
    })
}
pub(crate) async fn advance(
    tx: &mut PgConnection,
    operation: Uuid,
    job: Uuid,
    version: i64,
    state: &str,
) -> Result<(), AppError> {
    let n=sqlx::query("UPDATE operations SET state=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND version=$2")
        .bind(operation).bind(version).bind(state).execute(&mut *tx).await.map_err(unavailable)?.rows_affected();
    if n != 1 {
        return Err(conflict());
    }
    sqlx::query("UPDATE jobs SET state='done',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=$1")
        .bind(job).execute(&mut *tx).await.map_err(unavailable)?;
    // Terminal operations have no service worker continuation. Avoid publishing
    // a ready job that can never be claimed and would permanently inflate queue
    // backlog metrics.
    if state != "succeeded" && state != "failed" {
        sqlx::query("INSERT INTO jobs(id,topic,operation_id,operation_version) VALUES ($1,'operation.changed',$2,$3)")
            .bind(Uuid::new_v4()).bind(operation).bind(version+1).execute(tx).await.map_err(unavailable)?;
    }
    Ok(())
}
impl WorkStore {
    /// Atomic signed bundle + wallet guard + nonce slots + state + successor job.
    /// Does not broadcast. Client authentication and fresh chain validation belong
    /// to the orchestration layer; IDs and NonceObservation are trusted inputs.
    #[tracing::instrument(name = "work.stage_signed", skip_all)]
    pub async fn stage_signed(
        &self,
        keys: &SubmissionKeys,
        input: StageSubmission<'_>,
    ) -> Result<SubmissionSummary, AppError> {
        let plan = self
            .load_submission_preparation(
                keys,
                input.user,
                input.wallet,
                input.operation,
                input.bundle,
            )
            .await?;
        if plan.integrity_hash()? != input.bundle.preparation_hash()
            || input.bundle.transactions().is_empty()
        {
            return Err(invalid());
        }
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        // Wallet first serializes different operations competing for the same signer.
        let membership = sqlx::query(
            "SELECT chain_id,address FROM wallet_memberships WHERE id=$1 AND user_id=$2 FOR UPDATE",
        )
        .bind(input.wallet)
        .bind(input.user)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?
        .ok_or(AppError::NotFound)?;
        if membership
            .try_get::<i64, _>("chain_id")
            .map_err(unavailable)? as u64
            != input.bundle.chain_id()
            || membership
                .try_get::<Vec<u8>, _>("address")
                .map_err(unavailable)?
                .as_slice()
                != input.bundle.signer().as_slice()
        {
            return Err(invalid());
        }
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM evm_submissions WHERE operation_id=$1)",
        )
        .bind(input.operation)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if exists {
            let found = summary(&mut tx, input.operation).await?;
            let expected: Vec<_> = input
                .bundle
                .transactions()
                .iter()
                .map(|t| format!("{:#x}", t.hash()))
                .collect();
            if found.transaction_hashes != expected {
                return Err(conflict());
            }
            tx.commit().await.map_err(unavailable)?;
            return Ok(found);
        }
        // Same job -> operation lock order as existing preparation/transition methods.
        let job:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE operation_id=$1 AND operation_version=$2 AND state IN ('ready','done') FOR UPDATE")
            .bind(input.operation).bind(input.expected_version).fetch_optional(&mut *tx).await.map_err(unavailable)?;
        let job = job.ok_or_else(conflict)?;
        let state:Option<String>=sqlx::query_scalar("SELECT state FROM operations WHERE id=$1 AND user_id=$2 AND wallet_id=$3 AND version=$4 FOR UPDATE")
            .bind(input.operation).bind(input.user).bind(input.wallet).bind(input.expected_version).fetch_optional(&mut *tx).await.map_err(unavailable)?;
        if state.as_deref() != Some("awaiting_signature")
            || !fresh(input.nonce, now(&mut tx).await?)
            || input.nonce.nonce != input.bundle.transactions()[0].nonce()
            || plan.expires_at_ms <= now(&mut tx).await?
        {
            return Err(conflict());
        }
        let guarded: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM evm_wallet_guards WHERE wallet_id=$1)")
                .bind(input.wallet)
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?;
        if guarded {
            return Err(AppError::Conflict(
                "wallet has an unresolved submission".into(),
            ));
        }
        let chain = input.bundle.chain_id() as i64;
        let signer = input.bundle.signer();
        sqlx::query("INSERT INTO evm_submissions(operation_id,wallet_id,chain_id,signer,plan_hash,first_nonce,step_count) VALUES ($1,$2,$3,$4,$5,$6::text::numeric,$7)")
            .bind(input.operation).bind(input.wallet).bind(chain).bind(signer.as_slice()).bind(hex::decode(input.bundle.preparation_hash()).map_err(|_|invalid())?)
            .bind(input.nonce.nonce.to_string()).bind(input.bundle.transactions().len() as i16).execute(&mut *tx).await.map_err(unavailable)?;
        sqlx::query("INSERT INTO evm_wallet_guards(wallet_id,operation_id) VALUES ($1,$2)")
            .bind(input.wallet)
            .bind(input.operation)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        for (step, t) in input.bundle.transactions().iter().enumerate() {
            let hash = t.hash();
            let associated = EnvelopeContext {
                operation: input.operation,
                plan_hash: input.bundle.preparation_hash(),
                step,
                chain: input.bundle.chain_id(),
                signer: signer.as_slice(),
                nonce: t.nonce(),
                hash: hash.as_slice(),
                key: &keys.active,
            }
            .aad()?;
            let (nonce, encrypted) = keys.seal(&associated, t.expose_signed_bytes())?;
            sqlx::query("INSERT INTO evm_signed_transactions(id,operation_id,step,chain_id,signer,nonce,tx_hash,key_id,encryption_nonce,ciphertext) VALUES ($1,$2,$3,$4,$5,$6::text::numeric,$7,$8,$9,$10)")
                .bind(Uuid::new_v4()).bind(input.operation).bind(step as i16).bind(chain).bind(signer.as_slice()).bind(t.nonce().to_string()).bind(t.hash().as_slice()).bind(&keys.active).bind(nonce).bind(encrypted)
                .execute(&mut *tx).await.map_err(unavailable)?;
        }
        let end = now(&mut tx).await?;
        if end >= plan.expires_at_ms || !fresh(input.nonce, end) {
            return Err(conflict());
        }
        advance(
            &mut tx,
            input.operation,
            job,
            input.expected_version,
            "signed",
        )
        .await?;
        let result = summary(&mut tx, input.operation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Internal worker reconstruction. Re-verifies encrypted bytes against immutable
    /// historical plan data; does not authorize sending an expired plan.
    pub async fn reconciliation_context(
        &self,
        keys: &SubmissionKeys,
        operation: Uuid,
    ) -> Result<crate::reconciliation::ReconciliationContext, AppError> {
        let owner = sqlx::query("SELECT user_id,wallet_id FROM operations WHERE id=$1")
            .bind(operation)
            .fetch_optional(&self.pool)
            .await
            .map_err(unavailable)?
            .ok_or(AppError::NotFound)?;
        let plan = self
            .load_preparation_with_keys(
                keys,
                owner.try_get("user_id").map_err(unavailable)?,
                owner.try_get("wallet_id").map_err(unavailable)?,
                operation,
            )
            .await?;
        let plan_hash = plan.integrity_hash()?;
        let rows=sqlx::query("SELECT step,chain_id,signer,nonce::text AS nonce,tx_hash,key_id,encryption_nonce,ciphertext FROM evm_signed_transactions WHERE operation_id=$1 ORDER BY step").bind(operation).fetch_all(&self.pool).await.map_err(unavailable)?;
        if rows.len() != plan.steps.len() {
            return Err(AppError::Busy);
        }
        let mut signed = Zeroizing::new(Vec::<String>::new());
        let mut first = 0;
        for (step, row) in rows.iter().enumerate() {
            let nonce = row
                .try_get::<String, _>("nonce")
                .map_err(unavailable)?
                .parse::<u64>()
                .map_err(|_| AppError::Busy)?;
            if step == 0 {
                first = nonce;
            }
            let key: String = row.try_get("key_id").map_err(unavailable)?;
            let hash: Vec<u8> = row.try_get("tx_hash").map_err(unavailable)?;
            let associated = EnvelopeContext {
                operation,
                plan_hash: &plan_hash,
                step,
                chain: row.try_get::<i64, _>("chain_id").map_err(unavailable)? as u64,
                signer: &row.try_get::<Vec<u8>, _>("signer").map_err(unavailable)?,
                nonce,
                hash: &hash,
                key: &key,
            }
            .aad()?;
            let raw = keys.open(
                &key,
                &row.try_get::<Vec<u8>, _>("encryption_nonce")
                    .map_err(unavailable)?,
                &associated,
                &row.try_get::<Vec<u8>, _>("ciphertext")
                    .map_err(unavailable)?,
            )?;
            if keccak256(raw.as_slice()).as_slice() != hash {
                return Err(AppError::Busy);
            }
            signed.push(format!("0x{}", hex::encode(raw.as_slice())));
        }
        let verified = crate::evm_envelope::verify_signed_bundle(
            &plan,
            crate::evm_envelope::EvmEnvelopePolicy {
                first_nonce: first,
                maximum_gas_per_transaction: u64::MAX,
            },
            &signed,
            plan.simulation.observed_at_ms,
        )
        .map_err(|_| AppError::Busy)?;
        let expected = verified
            .transactions()
            .iter()
            .zip(&plan.steps)
            .map(|(t, call)| {
                Ok(crate::reconciliation::ExpectedReceipt {
                    hash: t.hash(),
                    sender: verified.signer(),
                    recipient: call.to.parse().map_err(|_| AppError::Busy)?,
                    gas_limit: t.gas_limit(),
                    priority_fee: alloy_primitives::U256::from(t.max_priority_fee_per_gas()),
                    max_fee: t.maximum_execution_fee()
                        / alloy_primitives::U256::from(t.gas_limit()),
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        let anchor=sqlx::query("SELECT finalized_number::text AS number,finalized_hash FROM evm_reconciliation_current WHERE operation_id=$1").bind(operation).fetch_optional(&self.pool).await.map_err(unavailable)?.map(|row|Ok::<_,AppError>(crate::reconciliation::Checkpoint {
            number:row.try_get::<String,_>("number").map_err(unavailable)?.parse().map_err(|_|AppError::Busy)?,
            hash:alloy_primitives::B256::from_slice(&row.try_get::<Vec<u8>,_>("finalized_hash").map_err(unavailable)?),
        })).transpose()?;
        Ok(crate::reconciliation::ReconciliationContext {
            operation,
            plan_hash,
            chain: verified.chain_id(),
            expected,
            anchor,
        })
    }

    /// Compatibility entry point for the first transaction of a bundle.
    pub async fn begin_initial_dispatch(
        &self,
        keys: &SubmissionKeys,
        lease: &JobLease,
        observation: NonceObservation,
    ) -> Result<InitialDispatch, AppError> {
        self.begin_dispatch_step(keys, lease, observation, 0).await
    }
    /// Journal a transaction once. Later steps require a fresh canonical receipt
    /// projection with successful predecessors; never retries an unknown dispatch.
    #[tracing::instrument(name = "work.begin_dispatch", skip_all)]
    pub async fn begin_dispatch_step(
        &self,
        keys: &SubmissionKeys,
        lease: &JobLease,
        observation: NonceObservation,
        step: u8,
    ) -> Result<InitialDispatch, AppError> {
        if step >= 8 {
            return Err(conflict());
        }
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let live:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND operation_id=$2 AND operation_version=$3 AND lease_token=$4 AND state='leased' AND lease_until>clock_timestamp() FOR UPDATE")
            .bind(lease.id).bind(lease.operation_id).bind(lease.operation_version).bind(lease.token).fetch_optional(&mut *tx).await.map_err(unavailable)?;
        if live.is_none() {
            return Err(conflict());
        }
        let row=sqlx::query("SELECT o.state,p.expires_at,s.plan_hash, t.id,t.chain_id,t.signer,t.nonce::text AS nonce,t.tx_hash,t.key_id,t.encryption_nonce,t.ciphertext,
            (p.expires_at>clock_timestamp()) AS unexpired FROM operations o JOIN operation_preparations p ON p.operation_id=o.id
            JOIN evm_submissions s ON s.operation_id=o.id JOIN evm_wallet_guards g ON g.operation_id=o.id AND g.wallet_id=o.wallet_id
            JOIN evm_signed_transactions t ON t.operation_id=o.id AND t.step=$3
            WHERE o.id=$1 AND o.version=$2 FOR UPDATE OF o")
            .bind(lease.operation_id).bind(lease.operation_version).bind(i16::from(step)).fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or_else(conflict)?;
        let tx_nonce = row
            .try_get::<String, _>("nonce")
            .map_err(unavailable)?
            .parse::<u64>()
            .map_err(|_| AppError::Busy)?;
        let state: String = row.try_get("state").map_err(unavailable)?;
        if (step == 0 && state != "signed")
            || (step > 0 && !["unknown", "confirming"].contains(&state.as_str()))
            || !row.try_get::<bool, _>("unexpired").map_err(unavailable)?
            || !fresh(observation, now(&mut tx).await?)
            || observation.nonce != tx_nonce
        {
            return Err(conflict());
        }
        if step > 0 {
            let proof=sqlx::query("SELECT b.observations_json,b.observations_hash FROM evm_reconciliation_current c JOIN evm_reconciliation_batches b ON b.id=c.batch_id WHERE c.operation_id=$1 AND c.checked_at>clock_timestamp()-interval '10 seconds'")
                .bind(lease.operation_id).fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or_else(conflict)?;
            let receipts = crate::reconciliation::decode_observations(
                &proof
                    .try_get::<String, _>("observations_json")
                    .map_err(unavailable)?,
                &proof
                    .try_get::<Vec<u8>, _>("observations_hash")
                    .map_err(unavailable)?,
            )?;
            let n = usize::from(step);
            if n >= receipts.len()
                || receipts[n].inclusion.is_some()
                || receipts[..n]
                    .iter()
                    .any(|r| r.inclusion.as_ref().is_none_or(|i| !i.succeeded))
                || receipts
                    .iter()
                    .any(|r| r.inclusion.as_ref().is_some_and(|i| !i.succeeded))
            {
                return Err(conflict());
            }
        }
        let key: String = row.try_get("key_id").map_err(unavailable)?;
        let hash: Vec<u8> = row.try_get("tx_hash").map_err(unavailable)?;
        let associated = EnvelopeContext {
            operation: lease.operation_id,
            plan_hash: &hex::encode(
                row.try_get::<Vec<u8>, _>("plan_hash")
                    .map_err(unavailable)?,
            ),
            step: usize::from(step),
            chain: row.try_get::<i64, _>("chain_id").map_err(unavailable)? as u64,
            signer: &row.try_get::<Vec<u8>, _>("signer").map_err(unavailable)?,
            nonce: tx_nonce,
            hash: &hash,
            key: &key,
        }
        .aad()?;
        let raw = keys.open(
            &key,
            &row.try_get::<Vec<u8>, _>("encryption_nonce")
                .map_err(unavailable)?,
            &associated,
            &row.try_get::<Vec<u8>, _>("ciphertext")
                .map_err(unavailable)?,
        )?;
        if keccak256(raw.as_slice()).as_slice() != hash {
            return Err(AppError::Busy);
        }
        let attempt = Uuid::new_v4();
        sqlx::query("INSERT INTO evm_dispatch_attempts(id,transaction_id) VALUES ($1,$2)")
            .bind(attempt)
            .bind(row.try_get::<Uuid, _>("id").map_err(unavailable)?)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        // Final predicates are re-evaluated after lock waits and crypto work.
        let live:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM jobs j JOIN operation_preparations p ON p.operation_id=j.operation_id WHERE j.id=$1 AND j.lease_token=$2 AND j.lease_until>clock_timestamp() AND p.expires_at>clock_timestamp() AND ($3=0 OR EXISTS(SELECT 1 FROM evm_reconciliation_current c WHERE c.operation_id=j.operation_id AND c.checked_at>clock_timestamp()-interval '10 seconds')))")
            .bind(lease.id).bind(lease.token).bind(i16::from(step)).fetch_one(&mut *tx).await.map_err(unavailable)?;
        if !live || !fresh(observation, now(&mut tx).await?) {
            return Err(conflict());
        }
        advance(
            &mut tx,
            lease.operation_id,
            lease.id,
            lease.operation_version,
            "unknown",
        )
        .await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(InitialDispatch {
            attempt_id: attempt,
            hash,
            raw,
        })
    }

    /// RPC acknowledgement does not prove inclusion and never advances operation
    /// success. A timeout/rejection/mismatched provider hash must record Unknown.
    #[tracing::instrument(name = "work.dispatch_observation", skip_all)]
    pub async fn observe_dispatch(
        &self,
        attempt: &InitialDispatch,
        outcome: DispatchObservation,
    ) -> Result<(), AppError> {
        sqlx::query("INSERT INTO evm_dispatch_observations(attempt_id,outcome) VALUES ($1,$2) ON CONFLICT(attempt_id) DO NOTHING")
            .bind(attempt.attempt_id).bind(outcome.as_str()).execute(&self.pool).await.map_err(unavailable)?;
        let found: String =
            sqlx::query_scalar("SELECT outcome FROM evm_dispatch_observations WHERE attempt_id=$1")
                .bind(attempt.attempt_id)
                .fetch_one(&self.pool)
                .await
                .map_err(unavailable)?;
        if found != outcome.as_str() {
            return Err(conflict());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opens_independent_noble_vector_with_exact_context_and_large_nonce() {
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/submission-encryption-noble.json"
        ))
        .unwrap();
        let bytes = |name: &str| hex::decode(f[name].as_str().unwrap()).unwrap();
        let key: [u8; 32] = bytes("key").try_into().unwrap();
        let keys = SubmissionKeys::new(
            "public-test-key".into(),
            [("public-test-key".into(), Zeroizing::new(key))].into(),
        )
        .unwrap();
        let context = EnvelopeContext {
            operation: Uuid::parse_str("226d9165-1bde-42a7-a17c-7dab0c03237c").unwrap(),
            plan_hash: &"a".repeat(64),
            step: 1,
            chain: 1,
            signer: &[0x11; 20],
            nonce: 9007199254740993,
            hash: &[0x22; 32],
            key: "public-test-key",
        };
        assert_eq!(context.aad().unwrap(), bytes("aad"));
        assert_eq!(
            keys.open(
                "public-test-key",
                &bytes("nonce"),
                &context.aad().unwrap(),
                &bytes("ciphertext")
            )
            .unwrap()
            .as_slice(),
            bytes("plaintext")
        );
    }
    #[test]
    fn encrypted_authorization_is_randomized_and_bound_to_every_context_field() {
        let keys =
            SubmissionKeys::new("k1".into(), [("k1".into(), Zeroizing::new([7; 32]))].into())
                .unwrap();
        let context = EnvelopeContext {
            operation: Uuid::new_v4(),
            plan_hash: &"a".repeat(64),
            step: 0,
            chain: 1,
            signer: &[1; 20],
            nonce: u64::MAX - 1,
            hash: &[2; 32],
            key: "k1",
        };
        let aad = context.aad().unwrap();
        let (nonce, cipher) = keys.seal(&aad, b"broadcastable authorization").unwrap();
        let (other_nonce, other_cipher) = keys.seal(&aad, b"broadcastable authorization").unwrap();
        assert_ne!(nonce, other_nonce);
        assert_ne!(cipher, other_cipher);
        assert_eq!(
            keys.open("k1", &nonce, &aad, &cipher).unwrap().as_slice(),
            b"broadcastable authorization"
        );
        let fields: serde_json::Value = serde_json::from_slice(&aad).unwrap();
        for i in 0..9 {
            let mut changed = fields.clone();
            changed[i] = serde_json::json!("changed");
            assert!(
                keys.open(
                    "k1",
                    &nonce,
                    &serde_json::to_vec(&changed).unwrap(),
                    &cipher
                )
                .is_err()
            );
        }
        for i in 0..cipher.len() {
            let mut changed = cipher.clone();
            changed[i] ^= 1;
            assert!(keys.open("k1", &nonce, &aad, &changed).is_err());
        }
        for i in 0..nonce.len() {
            let mut changed = nonce.clone();
            changed[i] ^= 1;
            assert!(keys.open("k1", &changed, &aad, &cipher).is_err());
        }
        assert!(keys.open("missing", &nonce, &aad, &cipher).is_err());
        assert!(keys.open("k1", &nonce[..23], &aad, &cipher).is_err());
        assert!(keys.open("k1", &nonce, &aad, &[0; 8209]).is_err());
    }
}
