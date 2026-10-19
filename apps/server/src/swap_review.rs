//! Durable pre-build authority. Internal repository only: no HTTP admission,
//! provider request, chain attestation or broadcast is implied by these methods.
use crate::{
    error::AppError,
    identity::{digest, unavailable},
    preparation::canonical,
    providers::{
        permit2::PermitTerms,
        uniswap_economics::{SwapAuthority, validate_authority},
    },
    submissions::SubmissionKeys,
    work::{Action, JobLease, Operation, WorkStore, decode_operation},
};
use alloy_primitives::{Address, U256};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgConnection, Row, postgres::PgRow};
use time::OffsetDateTime;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwapReview {
    pub schema_version: u8,
    pub intent_hash: String,
    pub quote_id: String,
    pub provider_quote_hash: String,
    pub registry_revision: String,
    pub fee_policy_revision: String,
    pub authority: SwapAuthority,
    pub permit2: String,
    pub permit: Option<PermitTerms>,
    pub maximum_network_fee_raw: String,
    pub quote_observed_at_ms: i64,
    pub reviewed_at_ms: i64,
    pub expires_at_ms: i64,
}
fn invalid() -> AppError {
    AppError::BadRequest("invalid swap review or permit".into())
}
fn conflict() -> AppError {
    AppError::Conflict("swap authority changed, expired or reserved; recover current state".into())
}
fn seconds(ms: i64) -> Result<u64, AppError> {
    u64::try_from(ms / 1000)
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(invalid)
}
fn timestamp(ms: i64) -> Result<OffsetDateTime, AppError> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).map_err(|_| invalid())
}
fn label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn address(s: &str) -> Result<Address, AppError> {
    let a: Address = s.parse().map_err(|_| invalid())?;
    if a == Address::ZERO || s != format!("{a:#x}") {
        return Err(invalid());
    }
    Ok(a)
}
impl SwapReview {
    /// Historical validation uses the original review clock. Liveness is checked
    /// separately at every new authority transition; this never renews a deadline.
    pub fn validate(&self) -> Result<(), AppError> {
        if self.schema_version != 1
            || !hash(&self.intent_hash)
            || !hash(&self.provider_quote_hash)
            || !label(&self.quote_id)
            || !label(&self.registry_revision)
            || !label(&self.fee_policy_revision)
            || self.reviewed_at_ms <= 0
            || self.reviewed_at_ms > 9_007_199_253_840_991
            || self.quote_observed_at_ms > self.reviewed_at_ms
            || self.quote_observed_at_ms < self.reviewed_at_ms - 30_000
            || self.expires_at_ms <= self.reviewed_at_ms
            || self.expires_at_ms > self.reviewed_at_ms + 900_000
            || self.authority.deadline != (self.expires_at_ms / 1000).to_string()
            || self.expires_at_ms % 1000 != 0
        {
            return Err(invalid());
        }
        let now = seconds(self.reviewed_at_ms)?;
        validate_authority(&self.authority, now).map_err(|_| invalid())?;
        address(&self.permit2)?;
        let fee = U256::from_str_radix(&self.maximum_network_fee_raw, 10).map_err(|_| invalid())?;
        if fee == U256::ZERO || fee.to_string() != self.maximum_network_fee_raw {
            return Err(invalid());
        }
        if let Some(p) = &self.permit {
            p.digest(now).map_err(|_| invalid())?;
            if p.chain_id != self.authority.chain_id
                || p.permit2 != self.permit2
                || p.owner != self.authority.owner
                || p.token != self.authority.token_in
                || p.amount_raw != self.authority.maximum_input_raw
                || p.spender != self.authority.router
                || p.sig_deadline.parse::<u64>().map_err(|_| invalid())?
                    < seconds(self.expires_at_ms)?
            {
                return Err(invalid());
            }
        }
        if canonical(self)?.len() > 32768 {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn integrity_hash(&self) -> Result<String, AppError> {
        self.validate()?;
        Ok(hex::encode(digest(canonical(self)?.as_bytes())))
    }
    fn live(&self, now: i64) -> Result<(), AppError> {
        if now < self.reviewed_at_ms || now >= self.expires_at_ms {
            return Err(conflict());
        }
        Ok(())
    }
    pub(crate) fn bind_quote(&self, quote: &Value) -> Result<(), AppError> {
        // Identity check only. The provider adapter must validate the complete
        // routing/fee response before creating this review; a hash is not attestation.
        if !quote.is_object()
            || quote["quoteId"].as_str() != Some(&self.quote_id)
            || quote["chainId"].as_u64().map(|v| v.to_string()).as_ref()
                != Some(&self.authority.chain_id)
            || quote["swapper"]
                .as_str()
                .and_then(|v| v.parse::<Address>().ok())
                != Some(address(&self.authority.owner)?)
            || quote["input"]["token"]
                .as_str()
                .and_then(|v| v.parse::<Address>().ok())
                != Some(address(&self.authority.token_in)?)
            || quote["input"]["amount"].as_str() != Some(&self.authority.maximum_input_raw)
            || quote["output"]["token"]
                .as_str()
                .and_then(|v| v.parse::<Address>().ok())
                != Some(address(&self.authority.token_out)?)
        {
            return Err(invalid());
        }
        let encoded = canonical(quote)?;
        if encoded.len() > 262144
            || hex::encode(digest(encoded.as_bytes())) != self.provider_quote_hash
        {
            return Err(invalid());
        }
        Ok(())
    }
}

/// Trusted RPC evidence; never deserialized from an HTTP request. Nonce scope is
/// owner/token/spender inside one chain's Permit2. Reorgs/external signers still
/// require fresh checks at transaction preparation and immediately before dispatch.
pub struct PermitNonceObservation {
    pub chain_id: u64,
    pub permit2: Address,
    pub owner: Address,
    pub token: Address,
    pub spender: Address,
    pub nonce: u64,
    pub observed_at_ms: i64,
    /// Timestamp of a verified finalized block on this chain. Releasing an old
    /// reservation requires this watermark to pass its inclusive signature deadline.
    pub finalized_block_timestamp: u64,
}
impl PermitNonceObservation {
    fn matches(&self, p: &PermitTerms, now: i64) -> Result<(), AppError> {
        if self.chain_id.to_string() != p.chain_id
            || self.permit2 != address(&p.permit2)?
            || self.owner != address(&p.owner)?
            || self.token != address(&p.token)?
            || self.spender != address(&p.spender)?
            || self.nonce.to_string() != p.nonce
            || self.finalized_block_timestamp == 0
            || self.finalized_block_timestamp > seconds(now)?
            || self.observed_at_ms > now
            || self.observed_at_ms < now - 10_000
        {
            return Err(conflict());
        }
        Ok(())
    }
}
pub struct StageSwapPermit<'a> {
    pub user: Uuid,
    pub wallet: Uuid,
    pub operation: Uuid,
    pub expected_version: i64,
    pub review_hash: &'a str,
    pub signature: &'a str,
    /// Required for a new admission, unnecessary for an exact retry acknowledgement.
    pub nonce: Option<&'a PermitNonceObservation>,
}
/// Worker-only sensitive context: deliberately neither Debug nor Serialize.
/// Reading it does not authorize an external request or renew the review.
pub struct SwapBuildContext {
    pub review: SwapReview,
    pub provider_quote: Zeroizing<Vec<u8>>,
    pub signature: Option<Zeroizing<String>>,
}
struct OpenReview {
    review: SwapReview,
    quote: Zeroizing<Vec<u8>>,
    hash: Vec<u8>,
}
fn aad(
    domain: &str,
    row: &PgRow,
    review_hash: &[u8],
    content: &[&[u8]],
    key: &str,
) -> Result<Vec<u8>, AppError> {
    serde_json::to_vec(&(
        domain,
        row.try_get::<Uuid, _>("id").map_err(unavailable)?,
        row.try_get::<Uuid, _>("user_id").map_err(unavailable)?,
        row.try_get::<Uuid, _>("wallet_id").map_err(unavailable)?,
        row.try_get::<Vec<u8>, _>("intent_hash")
            .map_err(unavailable)?,
        review_hash,
        content,
        key,
    ))
    .map_err(|_| AppError::Busy)
}
const SELECT: &str = "SELECT o.id,o.user_id,o.wallet_id,o.action,o.state,o.version,o.intent_hash,
 w.chain_id,w.address,i.canonical_json AS intent,r.canonical_json AS review,r.review_hash,r.quote_hash,
 r.key_id,r.encryption_nonce,r.ciphertext,(extract(epoch FROM r.expires_at)*1000)::bigint AS expires_ms,
 (extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms
 FROM operations o JOIN wallet_memberships w ON w.id=o.wallet_id AND w.user_id=o.user_id
 JOIN operation_intents i ON i.operation_id=o.id LEFT JOIN swap_reviews r ON r.operation_id=o.id
 WHERE o.id=$1 AND o.user_id=$2 AND o.wallet_id=$3";
fn bind_owner(row: &PgRow, review: &SwapReview) -> Result<(), AppError> {
    let intent: Value =
        serde_json::from_str(&row.try_get::<String, _>("intent").map_err(unavailable)?)
            .map_err(|_| AppError::Busy)?;
    let wallet: Uuid = row.try_get("wallet_id").map_err(unavailable)?;
    let expected = digest(
        &serde_json::to_vec(&(1, wallet, Action::Swap, intent)).map_err(|_| AppError::Busy)?,
    );
    if row.try_get::<String, _>("action").map_err(unavailable)? != "swap"
        || row
            .try_get::<Vec<u8>, _>("intent_hash")
            .map_err(unavailable)?
            != expected
        || review.intent_hash != hex::encode(expected)
        || review.authority.chain_id
            != row
                .try_get::<i64, _>("chain_id")
                .map_err(unavailable)?
                .to_string()
        || review.authority.owner
            != format!(
                "0x{}",
                hex::encode(row.try_get::<Vec<u8>, _>("address").map_err(unavailable)?)
            )
    {
        return Err(conflict());
    }
    Ok(())
}
fn open_review(row: &PgRow, keys: &SubmissionKeys) -> Result<OpenReview, AppError> {
    let encoded: String = row
        .try_get::<Option<String>, _>("review")
        .map_err(unavailable)?
        .ok_or(AppError::NotFound)?;
    let hash: Vec<u8> = row.try_get("review_hash").map_err(unavailable)?;
    let quote_hash: Vec<u8> = row.try_get("quote_hash").map_err(unavailable)?;
    let review: SwapReview = serde_json::from_str(&encoded).map_err(|_| AppError::Busy)?;
    if review.integrity_hash()? != hex::encode(&hash)
        || canonical(&review)?.as_str() != encoded
        || review.provider_quote_hash != hex::encode(&quote_hash)
        || review.expires_at_ms != row.try_get::<i64, _>("expires_ms").map_err(unavailable)?
    {
        return Err(AppError::Busy);
    }
    bind_owner(row, &review)?;
    let key: String = row.try_get("key_id").map_err(unavailable)?;
    let associated = aad(
        "honey.uniswap.review-quote.v1",
        row,
        &hash,
        &[&quote_hash],
        &key,
    )?;
    let quote = keys.open_bounded(
        &key,
        &row.try_get::<Vec<u8>, _>("encryption_nonce")
            .map_err(unavailable)?,
        &associated,
        &row.try_get::<Vec<u8>, _>("ciphertext")
            .map_err(unavailable)?,
        262144,
    )?;
    if digest(&quote) != quote_hash {
        return Err(AppError::Busy);
    }
    // Quote was validated on write and authenticated above. Avoid parsing the
    // secret-bearing provider payload into heap Strings during every retry/read.
    Ok(OpenReview {
        review,
        quote,
        hash,
    })
}
async fn signature_row(conn: &mut PgConnection, id: Uuid) -> Result<Option<PgRow>, AppError> {
    sqlx::query("SELECT review_hash,admitted_version,permit_digest,signature_hash,key_id,encryption_nonce,ciphertext FROM swap_permit_signatures WHERE operation_id=$1")
        .bind(id).fetch_optional(conn).await.map_err(unavailable)
}
fn open_signature(
    op: &PgRow,
    stored: &PgRow,
    review: &OpenReview,
    keys: &SubmissionKeys,
) -> Result<Zeroizing<Vec<u8>>, AppError> {
    let key: String = stored.try_get("key_id").map_err(unavailable)?;
    let permit: Vec<u8> = stored.try_get("permit_digest").map_err(unavailable)?;
    let signature: Vec<u8> = stored.try_get("signature_hash").map_err(unavailable)?;
    if stored
        .try_get::<Vec<u8>, _>("review_hash")
        .map_err(unavailable)?
        != review.hash
        || review
            .review
            .permit
            .as_ref()
            .ok_or(AppError::Busy)?
            .digest(seconds(review.review.reviewed_at_ms)?)
            .map_err(|_| AppError::Busy)?
            .as_slice()
            != permit
    {
        return Err(AppError::Busy);
    }
    let associated = aad(
        "honey.uniswap.permit.v1",
        op,
        &review.hash,
        &[
            &permit,
            &signature,
            &stored
                .try_get::<i64, _>("admitted_version")
                .map_err(unavailable)?
                .to_be_bytes(),
        ],
        &key,
    )?;
    let raw = keys.open_bounded(
        &key,
        &stored
            .try_get::<Vec<u8>, _>("encryption_nonce")
            .map_err(unavailable)?,
        &associated,
        &stored
            .try_get::<Vec<u8>, _>("ciphertext")
            .map_err(unavailable)?,
        65,
    )?;
    if ![64, 65].contains(&raw.len()) || digest(&raw) != signature {
        return Err(AppError::Busy);
    }
    Ok(raw)
}
async fn enqueue(conn: &mut PgConnection, id: Uuid, version: i64) -> Result<(), AppError> {
    sqlx::query("INSERT INTO jobs(id,topic,operation_id,operation_version) VALUES($1,'operation.changed',$2,$3)")
        .bind(Uuid::new_v4()).bind(id).bind(version).execute(conn).await.map_err(unavailable)?;
    Ok(())
}

impl WorkStore {
    /// Fence the initial quote worker and install the immutable user review.
    /// The no-permit path means a trusted adapter proved sufficient existing
    /// allowance; this repository alone does not perform that chain read.
    #[tracing::instrument(name = "work.persist_swap_review", skip_all)]
    pub async fn persist_swap_review(
        &self,
        keys: &SubmissionKeys,
        lease: &JobLease,
        review: &SwapReview,
        quote: &Value,
    ) -> Result<(), AppError> {
        review.validate()?;
        review.bind_quote(quote)?;
        let encoded = canonical(review)?;
        let review_hash = digest(encoded.as_bytes());
        let quote = canonical(quote)?;
        let quote_hash = digest(quote.as_bytes());
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let live: Option<Uuid> = sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND operation_id=$2 AND operation_version=$3 AND lease_token=$4 AND state='leased' AND lease_until>clock_timestamp() FOR UPDATE")
            .bind(lease.id).bind(lease.operation_id).bind(lease.operation_version).bind(lease.token).fetch_optional(&mut *tx).await.map_err(unavailable)?;
        if live.is_none() {
            return Err(conflict());
        }
        let owner = sqlx::query("SELECT user_id,wallet_id FROM operations WHERE id=$1")
            .bind(lease.operation_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
        let row = sqlx::query(&format!("{SELECT} FOR UPDATE OF o"))
            .bind(lease.operation_id)
            .bind(owner.try_get::<Uuid, _>("user_id").map_err(unavailable)?)
            .bind(owner.try_get::<Uuid, _>("wallet_id").map_err(unavailable)?)
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
        bind_owner(&row, review)?;
        let now: i64 = row.try_get("now_ms").map_err(unavailable)?;
        review.live(now)?;
        if now - review.reviewed_at_ms > 30_000
            || now - review.quote_observed_at_ms > 30_000
            || row.try_get::<String, _>("state").map_err(unavailable)? != "created"
            || row.try_get::<i64, _>("version").map_err(unavailable)? != lease.operation_version
        {
            return Err(conflict());
        }
        let associated = aad(
            "honey.uniswap.review-quote.v1",
            &row,
            &review_hash,
            &[&quote_hash],
            keys.active_id(),
        )?;
        let (nonce, cipher) = keys.seal(&associated, quote.as_bytes())?;
        let expires = timestamp(review.expires_at_ms)?;
        sqlx::query("INSERT INTO swap_reviews(operation_id,canonical_json,review_hash,quote_hash,expires_at,key_id,encryption_nonce,ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(lease.operation_id).bind(encoded.as_str()).bind(review_hash).bind(quote_hash).bind(expires)
            .bind(keys.active_id()).bind(nonce).bind(cipher).execute(&mut *tx).await.map_err(unavailable)?;
        let state = if review.permit.is_some() {
            "awaiting_permit"
        } else {
            "building_swap"
        };
        let changed = sqlx::query("UPDATE operations SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1
            AND EXISTS(SELECT 1 FROM jobs WHERE id=$3 AND lease_token=$4 AND lease_until>clock_timestamp())
            AND $5>clock_timestamp() AND $6>=clock_timestamp()-interval '30 seconds'")
            .bind(lease.operation_id).bind(state).bind(lease.id).bind(lease.token).bind(expires).bind(timestamp(review.quote_observed_at_ms)?)
            .execute(&mut *tx).await.map_err(unavailable)?.rows_affected();
        if changed != 1 {
            return Err(conflict());
        }
        sqlx::query("UPDATE jobs SET state='done',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=$1")
            .bind(lease.id).execute(&mut *tx).await.map_err(unavailable)?;
        if review.permit.is_none() {
            enqueue(&mut tx, lease.operation_id, lease.operation_version + 1).await?;
        }
        tx.commit().await.map_err(unavailable)
    }
    /// Authenticate the public terms before a wallet constructs a signature.
    /// Expired terms remain readable for history but cannot be admitted again.
    pub async fn load_swap_review(
        &self,
        keys: &SubmissionKeys,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<SwapReview, AppError> {
        let row = sqlx::query(SELECT)
            .bind(operation)
            .bind(user)
            .bind(wallet)
            .fetch_optional(&self.pool)
            .await
            .map_err(unavailable)?
            .ok_or(AppError::NotFound)?;
        Ok(open_review(&row, keys)?.review)
    }
    /// Trusted source block for a fresh permit-admission observation. Public
    /// callers cannot supply or override the quote's chain watermark.
    pub(crate) async fn swap_quote_block(
        &self,
        keys: &SubmissionKeys,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<String, AppError> {
        let row = sqlx::query(SELECT)
            .bind(operation)
            .bind(user)
            .bind(wallet)
            .fetch_optional(&self.pool)
            .await
            .map_err(unavailable)?
            .ok_or(AppError::NotFound)?;
        let opened = open_review(&row, keys)?;
        let quote: Value = serde_json::from_slice(&opened.quote).map_err(|_| AppError::Busy)?;
        let block = quote["blockNumber"].as_str().ok_or(AppError::Busy)?;
        let n = block.parse::<u64>().map_err(|_| AppError::Busy)?;
        if n.to_string() != block {
            return Err(AppError::Busy);
        }
        Ok(block.into())
    }
    /// Historical context for exact-call revalidation. Does not renew permit or
    /// build admission; preflight separately enforces expiry and current policy.
    pub(crate) async fn load_stored_swap_build(
        &self,
        keys: &SubmissionKeys,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<SwapBuildContext, AppError> {
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
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
        let context = stored_build_context(&mut tx, keys, user, wallet, operation)
            .await?
            .ok_or(AppError::NotFound)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(context)
    }
    #[tracing::instrument(name = "work.stage_swap_permit", skip_all)]
    pub async fn stage_swap_permit(
        &self,
        keys: &SubmissionKeys,
        input: StageSwapPermit<'_>,
    ) -> Result<Operation, AppError> {
        if !hash(input.review_hash)
            || ![130, 132].contains(&input.signature.len())
            || !input.signature.starts_with("0x")
        {
            return Err(invalid());
        }
        let raw = Zeroizing::new(hex::decode(&input.signature[2..]).map_err(|_| invalid())?);
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        let row = sqlx::query(&format!("{SELECT} FOR UPDATE OF o"))
            .bind(input.operation)
            .bind(input.user)
            .bind(input.wallet)
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?
            .ok_or(AppError::NotFound)?;
        let opened = open_review(&row, keys)?;
        if hex::encode(&opened.hash) != input.review_hash {
            return Err(conflict());
        }
        if let Some(stored) = signature_row(&mut tx, input.operation).await? {
            if stored
                .try_get::<i64, _>("admitted_version")
                .map_err(unavailable)?
                != input.expected_version
                || *open_signature(&row, &stored, &opened, keys)? != *raw
            {
                return Err(conflict());
            }
            // Exact acknowledgement after a crash/timeout. Never enqueue, reserve,
            // refresh, re-sign or revalidate expired authority as a new admission.
            return decode_operation(&row);
        }
        let now: i64 = row.try_get("now_ms").map_err(unavailable)?;
        opened.review.live(now)?;
        if row.try_get::<String, _>("state").map_err(unavailable)? != "awaiting_permit"
            || row.try_get::<i64, _>("version").map_err(unavailable)? != input.expected_version
        {
            return Err(conflict());
        }
        let permit = opened.review.permit.as_ref().ok_or_else(conflict)?;
        let observed = input.nonce.ok_or_else(conflict)?;
        observed.matches(permit, now)?;
        let permit_digest = permit
            .verify_signature(input.signature, seconds(now)?)
            .map_err(|_| invalid())?;
        let signature_hash = digest(&raw);
        let associated = aad(
            "honey.uniswap.permit.v1",
            &row,
            &opened.hash,
            &[
                permit_digest.as_slice(),
                &signature_hash,
                &input.expected_version.to_be_bytes(),
            ],
            keys.active_id(),
        )?;
        let (nonce, cipher) = keys.seal(&associated, &raw)?;
        // Permit2 accepts block.timestamp == sigDeadline. Hold through that whole
        // second; database fractional timestamps must not permit premature reuse.
        let invalid_after =
            timestamp((permit.sig_deadline.parse::<i64>().map_err(|_| invalid())? + 1) * 1000)?;
        let reserved = sqlx::query("INSERT INTO swap_permit_guards(chain_id,permit2,owner,token,spender,nonce,operation_id,invalid_after)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(chain_id,permit2,owner,token,spender,nonce)
            DO UPDATE SET operation_id=excluded.operation_id,invalid_after=excluded.invalid_after
            WHERE swap_permit_guards.invalid_after<clock_timestamp() AND swap_permit_guards.invalid_after<=$9")
            .bind(observed.chain_id as i64).bind(observed.permit2.as_slice()).bind(observed.owner.as_slice())
            .bind(observed.token.as_slice()).bind(observed.spender.as_slice()).bind(observed.nonce as i64)
            .bind(input.operation).bind(invalid_after).bind(timestamp((observed.finalized_block_timestamp as i64) * 1000)?).execute(&mut *tx).await.map_err(unavailable)?.rows_affected();
        if reserved != 1 {
            return Err(conflict());
        }
        sqlx::query("INSERT INTO swap_permit_signatures(operation_id,review_hash,admitted_version,permit_digest,signature_hash,key_id,encryption_nonce,ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(input.operation).bind(&opened.hash).bind(input.expected_version).bind(permit_digest.as_slice())
            .bind(signature_hash).bind(keys.active_id()).bind(nonce).bind(cipher).execute(&mut *tx).await.map_err(unavailable)?;
        let updated = sqlx::query("UPDATE operations SET state='building_swap',version=version+1,updated_at=clock_timestamp()
            WHERE id=$1 AND $2>clock_timestamp() AND $3<=clock_timestamp() AND $3>=clock_timestamp()-interval '10 seconds'
            RETURNING id,wallet_id,action,state,version")
            .bind(input.operation).bind(timestamp(opened.review.expires_at_ms)?).bind(timestamp(observed.observed_at_ms)?)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?.ok_or_else(conflict)?;
        enqueue(&mut tx, input.operation, input.expected_version + 1).await?;
        let result = decode_operation(&updated)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }
    /// Reconstruct exactly what was reviewed and signed after a worker restart.
    /// No replacement quote, signature or extended expiry is accepted here.
    #[tracing::instrument(name = "work.load_swap_build", skip_all)]
    pub async fn load_swap_build(
        &self,
        keys: &SubmissionKeys,
        user: Uuid,
        wallet: Uuid,
        operation: Uuid,
    ) -> Result<SwapBuildContext, AppError> {
        let mut tx = self.pool.begin().await.map_err(unavailable)?;
        // Lock the operation while reading the separate immutable evidence rows.
        let row = sqlx::query(&format!("{SELECT} FOR SHARE OF o"))
            .bind(operation)
            .bind(user)
            .bind(wallet)
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?
            .ok_or(AppError::NotFound)?;
        if row.try_get::<String, _>("state").map_err(unavailable)? != "building_swap" {
            return Err(conflict());
        }
        let opened = open_review(&row, keys)?;
        opened
            .review
            .live(row.try_get("now_ms").map_err(unavailable)?)?;
        let context = open_build_context(&mut tx, &row, opened, keys).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(context)
    }
}

/// Caller holds the operation lock. Historical evidence remains readable after
/// expiry; this helper grants no state transition, signature or execution authority.
pub(crate) async fn stored_build_context(
    conn: &mut PgConnection,
    keys: &SubmissionKeys,
    user: Uuid,
    wallet: Uuid,
    operation: Uuid,
) -> Result<Option<SwapBuildContext>, AppError> {
    let row = sqlx::query(SELECT)
        .bind(operation)
        .bind(user)
        .bind(wallet)
        .fetch_optional(&mut *conn)
        .await
        .map_err(unavailable)?
        .ok_or(AppError::NotFound)?;
    if row
        .try_get::<Option<String>, _>("review")
        .map_err(unavailable)?
        .is_none()
    {
        return Ok(None);
    }
    let opened = open_review(&row, keys)?;
    Ok(Some(open_build_context(conn, &row, opened, keys).await?))
}
async fn open_build_context(
    conn: &mut PgConnection,
    row: &PgRow,
    opened: OpenReview,
    keys: &SubmissionKeys,
) -> Result<SwapBuildContext, AppError> {
    let stored = signature_row(conn, row.try_get("id").map_err(unavailable)?).await?;
    let signature = match (opened.review.permit.as_ref(), stored) {
        (None, None) => None,
        (Some(_), Some(stored)) => Some(Zeroizing::new(format!(
            "0x{}",
            hex::encode(&*open_signature(row, &stored, &opened, keys)?)
        ))),
        _ => return Err(AppError::Busy),
    };
    Ok(SwapBuildContext {
        review: opened.review,
        provider_quote: opened.quote,
        signature,
    })
}
