//! Encrypted swap signing evidence. Public recovery needs no decryption key and
//! cannot return calldata; signing/reconciliation must authenticate the full payload.
use super::reviewed::{ReviewedRecord, StoredPreparation, SwapSigningEvidence};
use super::{
    EvmPreparation, PreparationProvider, PreparationSummary, canonical, decode_plan, hash, label,
    uint,
};
use crate::{
    error::AppError,
    identity::{digest, unavailable},
    providers::evm_prepare::PreparedEvm,
    submissions::SubmissionKeys,
    work::{Action, WorkStore},
};
use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, Row, postgres::PgRow};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicRecord {
    schema_version: u8,
    intent_hash: String,
    preparation: PreparationSummary,
}
fn public_record(plan: &EvmPreparation) -> Result<PublicRecord, AppError> {
    Ok(PublicRecord {
        schema_version: 1,
        intent_hash: plan.intent_hash.clone(),
        preparation: plan.summary(plan.integrity_hash()?, 0),
    })
}
/// Public metadata is checksummed database evidence, not signing permission.
/// AEAD authentication occurs only when the full signing request is opened.
pub(super) fn public_summary(
    encoded: &str,
    expected_hash: &[u8],
    plan_hash: &[u8],
    intent_hash: &[u8],
    action: Action,
    expires_at_ms: i64,
    now_ms: i64,
) -> Result<PreparationSummary, AppError> {
    if encoded.len() > 2048 || digest(encoded.as_bytes()) != expected_hash {
        return Err(AppError::Busy);
    }
    let mut record: PublicRecord = serde_json::from_str(encoded).map_err(|_| AppError::Busy)?;
    if canonical(&record)?.as_str() != encoded
        || record.schema_version != 1
        || record.intent_hash != hex::encode(intent_hash)
        || !hash(&record.intent_hash)
        || action != Action::Swap
        || record.preparation.provider != PreparationProvider::Uniswap
        || record.preparation.hash != hex::encode(plan_hash)
        || !hash(&record.preparation.hash)
        || !uint(&record.preparation.chain_id, "9223372036854775807")
        || record.preparation.chain_id == "0"
        || record.preparation.expires_at_ms != expires_at_ms
        || expires_at_ms <= 0
        || expires_at_ms > 9_007_199_254_740_991
        || record.preparation.expired
        || !(1..=8).contains(&record.preparation.step_count)
        || !label(&record.preparation.registry_revision)
        || !label(&record.preparation.fee_policy_revision)
    {
        return Err(AppError::Busy);
    }
    record.preparation.expired = expires_at_ms <= now_ms;
    Ok(record.preparation)
}
struct Context<'a> {
    operation: Uuid,
    user: Uuid,
    wallet: Uuid,
    plan_hash: &'a [u8],
    public_hash: &'a [u8],
    request_hash: &'a [u8],
    key: &'a str,
}
impl Context<'_> {
    fn aad(&self) -> Result<Vec<u8>, AppError> {
        serde_json::to_vec(&(
            "honey.evm.swap-preparation.v1",
            self.operation,
            self.user,
            self.wallet,
            hex::encode(self.plan_hash),
            hex::encode(self.public_hash),
            hex::encode(self.request_hash),
            self.key,
        ))
        .map_err(|_| AppError::Busy)
    }
}

pub(super) async fn insert(
    tx: &mut PgConnection,
    keys: &SubmissionKeys,
    operation: Uuid,
    user: Uuid,
    wallet: Uuid,
    prepared: &PreparedEvm,
    swap: Option<&crate::providers::uniswap_execution::PreparedSwap>,
) -> Result<(), AppError> {
    let public = canonical(&public_record(&prepared.plan)?)?;
    let context =
        crate::swap_review::stored_build_context(tx, keys, user, wallet, operation).await?;
    let stored = match swap {
        Some(swap) => StoredPreparation::Reviewed(ReviewedRecord {
            schema_version: 2,
            review_hash: swap.review_hash().into(),
            build_request_id: swap.build_request_id().into(),
            prepared: prepared.clone(),
        }),
        None => StoredPreparation::Legacy(prepared.clone()),
    };
    stored.bind(context.as_ref())?;
    let encoded = canonical(&stored)?;
    if public.len() > 2048 || encoded.len() > 262144 {
        return Err(AppError::BadRequest(
            "swap preparation exceeds storage bound".into(),
        ));
    }
    let plan_hash = hex::decode(prepared.plan.integrity_hash()?).map_err(|_| AppError::Busy)?;
    let public_hash = digest(public.as_bytes());
    let request_hash = digest(encoded.as_bytes());
    let associated = Context {
        operation,
        user,
        wallet,
        plan_hash: &plan_hash,
        public_hash: &public_hash,
        request_hash: &request_hash,
        key: keys.active_id(),
    }
    .aad()?;
    let (nonce, ciphertext) = keys.seal(&associated, encoded.as_bytes())?;
    let expires = OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(prepared.plan.expires_at_ms) * 1_000_000,
    )
    .map_err(|_| AppError::Busy)?;
    sqlx::query("INSERT INTO operation_preparations(operation_id,plan_hash,expires_at,public_json,public_hash,request_hash,key_id,encryption_nonce,ciphertext) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(operation).bind(plan_hash).bind(expires).bind(public.as_str()).bind(public_hash)
        .bind(request_hash).bind(keys.active_id()).bind(nonce).bind(ciphertext)
        .execute(tx).await.map_err(unavailable)?;
    Ok(())
}

fn open_record(
    row: &PgRow,
    keys: &SubmissionKeys,
    user: Uuid,
    wallet: Uuid,
    operation: Uuid,
) -> Result<StoredPreparation, AppError> {
    let plan_hash: Vec<u8> = row.try_get("plan_hash").map_err(unavailable)?;
    let public_hash: Vec<u8> = row.try_get("public_hash").map_err(unavailable)?;
    let request_hash: Vec<u8> = row.try_get("request_hash").map_err(unavailable)?;
    let key: String = row.try_get("key_id").map_err(unavailable)?;
    let aad = Context {
        operation,
        user,
        wallet,
        plan_hash: &plan_hash,
        public_hash: &public_hash,
        request_hash: &request_hash,
        key: &key,
    }
    .aad()?;
    let plaintext = keys.open_bounded(
        &key,
        &row.try_get::<Vec<u8>, _>("encryption_nonce")
            .map_err(unavailable)?,
        &aad,
        &row.try_get::<Vec<u8>, _>("ciphertext")
            .map_err(unavailable)?,
        262144,
    )?;
    if digest(&plaintext) != request_hash {
        return Err(AppError::Busy);
    }
    let stored: StoredPreparation =
        serde_json::from_slice(&plaintext).map_err(|_| AppError::Busy)?;
    let prepared = stored.prepared();
    prepared
        .validate_signing_terms()
        .map_err(|_| AppError::Busy)?;
    if prepared.plan.provider != PreparationProvider::Uniswap
        || canonical(&stored)?.as_bytes() != plaintext.as_slice()
        || prepared.plan.integrity_hash()? != hex::encode(plan_hash)
        || prepared.plan.intent_hash
            != hex::encode(
                row.try_get::<Vec<u8>, _>("intent_hash")
                    .map_err(unavailable)?,
            )
        || prepared.plan.chain_id
            != row
                .try_get::<i64, _>("chain_id")
                .map_err(unavailable)?
                .to_string()
        || prepared.plan.signer
            != format!(
                "0x{}",
                hex::encode(row.try_get::<Vec<u8>, _>("address").map_err(unavailable)?)
            )
        || canonical(&public_record(&prepared.plan)?)?.as_str()
            != row
                .try_get::<String, _>("public_json")
                .map_err(unavailable)?
    {
        return Err(AppError::Busy);
    }
    Ok(stored)
}

impl WorkStore {
    async fn preparation_record(
        &self,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<PgRow, AppError> {
        self.recover(user, wallet, operation).await?;
        sqlx::query("SELECT p.canonical_json,p.public_json,p.public_hash,p.plan_hash,p.request_hash,p.key_id,p.encryption_nonce,p.ciphertext,o.intent_hash,w.chain_id,w.address FROM operation_preparations p JOIN operations o ON o.id=p.operation_id JOIN wallet_memberships w ON w.id=o.wallet_id AND w.user_id=o.user_id WHERE o.id=$1 AND o.user_id=$2 AND o.wallet_id=$3")
            .bind(operation).bind(user).bind(wallet).fetch_optional(&self.pool).await.map_err(unavailable)?.ok_or(AppError::NotFound)
    }

    /// Reconstruct immutable swap terms for an authenticated owner or trusted worker.
    /// Historical/expired data is readable; neither this method nor possession of
    /// the key grants permission to sign, refresh, submit or resend.
    #[tracing::instrument(name = "work.open_swap_preparation", skip_all)]
    pub async fn load_sealed_swap_preparation(
        &self,
        keys: &SubmissionKeys,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<PreparedEvm, AppError> {
        let row = self.preparation_record(user, wallet, operation).await?;
        if row
            .try_get::<Option<String>, _>("canonical_json")
            .map_err(unavailable)?
            .is_some()
        {
            return Err(AppError::NotFound);
        }
        Ok(self
            .open_bound_record(&row, keys, user, wallet, operation)
            .await?
            .0
            .into_prepared())
    }

    /// Full original review accompanies the prepared calls. Simulated fee amounts
    /// never replace the review's percentage/rounding authority in wallet consent.
    pub async fn load_reviewed_swap_preparation(
        &self,
        keys: &SubmissionKeys,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<SwapSigningEvidence, AppError> {
        let row = self.preparation_record(user, wallet, operation).await?;
        let (stored, context) = self
            .open_bound_record(&row, keys, user, wallet, operation)
            .await?;
        let StoredPreparation::Reviewed(record) = stored else {
            return Err(AppError::NotFound);
        };
        Ok(SwapSigningEvidence {
            prepared: record.prepared,
            review: context.ok_or(AppError::Busy)?.review,
            build_request_id: record.build_request_id,
        })
    }

    async fn open_bound_record(
        &self,
        row: &PgRow,
        keys: &SubmissionKeys,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<
        (
            StoredPreparation,
            Option<crate::swap_review::SwapBuildContext>,
        ),
        AppError,
    > {
        let stored = open_record(row, keys, user, wallet, operation)?;
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        // Same lock order as review admission; immutable evidence is read while
        // the operation is stable. A read never grants fresh execution authority.
        sqlx::query(
            "SELECT id FROM operations WHERE id=$1 AND user_id=$2 AND wallet_id=$3 FOR SHARE",
        )
        .bind(operation)
        .bind(user)
        .bind(wallet)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?
        .ok_or(AppError::NotFound)?;
        let context =
            crate::swap_review::stored_build_context(&mut tx, keys, user, wallet, operation)
                .await?;
        stored.bind(context.as_ref())?;
        tx.commit().await.map_err(unavailable)?;
        Ok((stored, context))
    }

    /// Submission and reconciliation use one loader; plaintext Earn remains compatible.
    #[tracing::instrument(name = "work.open_preparation", skip_all)]
    pub async fn load_preparation_with_keys(
        &self,
        keys: &SubmissionKeys,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<EvmPreparation, AppError> {
        self.open_preparation(keys, user, wallet, operation, None)
            .await
    }

    pub(crate) async fn load_submission_preparation(
        &self,
        keys: &SubmissionKeys,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
        bundle: &crate::evm_envelope::VerifiedEvmBundle,
    ) -> Result<EvmPreparation, AppError> {
        self.open_preparation(keys, user, wallet, operation, Some(bundle))
            .await
    }

    async fn open_preparation(
        &self,
        keys: &SubmissionKeys,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
        bundle: Option<&crate::evm_envelope::VerifiedEvmBundle>,
    ) -> Result<EvmPreparation, AppError> {
        let row = self.preparation_record(user, wallet, operation).await?;
        if let Some(encoded) = row
            .try_get::<Option<String>, _>("canonical_json")
            .map_err(unavailable)?
        {
            decode_plan(
                &encoded,
                &row.try_get::<Vec<u8>, _>("plan_hash")
                    .map_err(unavailable)?,
            )
        } else {
            let prepared = self
                .open_bound_record(&row, keys, user, wallet, operation)
                .await?
                .0
                .into_prepared();
            if let Some(bundle) = bundle {
                prepared.validate_bundle_terms(bundle)?;
            }
            Ok(prepared.plan)
        }
    }
}
