//! Reviewed Uniswap operation lifecycle. Explicit local-fork acceptance only;
//! production Trading API credentials and broadcast activation are separate work.
use crate::{
    earn_service::{load_file, uint},
    error::AppError,
    evm_envelope::{EvmEnvelopePolicy, verify_signed_bundle},
    identity::{Profile, digest, unavailable},
    preparation::OperationRecovery,
    providers::{
        evm_prepare::{EvmPreparationError, PreparedEvm},
        evm_rpc::EvmReadRpc,
        rpc_budget::{RpcBudget, RpcBudgetConfig},
        uniswap::{ReviewOptions, SwapQuoteConfiguration, SwapQuoteRequest, UniswapQuotes},
        uniswap_execution::{self, UniswapExecutionPolicy},
    },
    submissions::{DispatchObservation, NonceObservation, StageSubmission, SubmissionKeys},
    swap_review::{StageSwapPermit, SwapReview},
    work::{Action, JobLease, NewOperation, OperationState, WorkStore},
};
use alloy_primitives::U256;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};
const SERVICE: &str = "uniswap_local_v1";
fn invalid() -> AppError {
    AppError::BadRequest("invalid swap execution request".into())
}
fn conflict() -> AppError {
    AppError::Conflict("swap review changed or expired; recover current operation".into())
}
fn now() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSwap {
    pub token_in: String,
    pub token_out: String,
    pub amount_raw: String,
    /// Decimal strings preserve the existing immutable-intent no-JSON-number rule.
    pub slippage_bps: String,
    pub minimum_output_raw: String,
    pub deadline: String,
    pub maximum_network_fee_raw: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    service: String,
    chain_id: String,
    registry_revision: String,
    fee_policy_revision: String,
    maximum_fee_rounding_raw: String,
    request: CreateSwap,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapExecutionConfiguration {
    pub mode: &'static str,
    pub quote: SwapQuoteConfiguration,
    pub maximum_fee_rounding_raw: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapReviewRequest {
    pub operation_id: Uuid,
    pub operation_version: String,
    pub review_hash: String,
    pub review: SwapReview,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapSigningRequest {
    pub operation_id: Uuid,
    pub operation_version: String,
    pub plan_hash: String,
    pub review_hash: String,
    pub review: SwapReview,
    pub prepared: PreparedEvm,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapIntentRecovery {
    pub operation_id: Uuid,
    pub signer: String,
    pub chain_id: String,
    pub registry_revision: String,
    pub fee_policy_revision: String,
    pub intent: CreateSwap,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitSwapPermit {
    pub expected_version: String,
    pub review_hash: String,
    pub signature: String,
}
impl Drop for SubmitSwapPermit {
    fn drop(&mut self) {
        self.signature.zeroize();
    }
}
pub type SubmitSwap = crate::earn_service::SubmitEarn;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileConfig {
    mode: String,
    rpc_url: String,
    rpc_budget: RpcBudgetConfig,
    registry: UniswapExecutionPolicy,
    quote_config_file: String,
    fixture_origin: String,
    maximum_fee_rounding_raw: u8,
    active_key_id: String,
    #[serde(deserialize_with = "crate::earn_service::decode_keys")]
    data_keys: BTreeMap<String, Zeroizing<String>>,
}
pub struct UniswapService {
    work: WorkStore,
    rpc: EvmReadRpc,
    keys: SubmissionKeys,
    policy: UniswapExecutionPolicy,
    quotes: Arc<UniswapQuotes>,
    rounding: u8,
}
impl UniswapService {
    pub fn from_file(
        work: WorkStore,
        path: &str,
        redis: crate::redis_store::RedisStore,
        metrics: Arc<crate::metrics::Metrics>,
    ) -> Result<Self, AppError> {
        let c: FileConfig = load_file(path)?;
        let url = reqwest::Url::parse(&c.rpc_url).map_err(|_| invalid())?;
        if c.mode != "local_fork"
            || c.registry.chain_id != 31337
            || c.maximum_fee_rounding_raw > 1
            || url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
        {
            return Err(invalid());
        }
        let quotes = Arc::new(UniswapQuotes::from_local_file(
            &c.quote_config_file,
            &c.fixture_origin,
            redis.clone(),
            metrics.clone(),
        )?);
        let q = quotes.configuration();
        let p = &c.registry;
        if q.router != format!("{:#x}", p.router.address)
            || q.permit2 != format!("{:#x}", p.permit2.address)
            || q.registry_revision != p.registry_revision
            || q.fee_policy_revision != p.fee_policy_revision
            || q.tokens.len() != p.tokens.len()
            || q.tokens.iter().zip(&p.tokens).any(|(q, p)| {
                q.address != format!("{:#x}", p.contract.address) || q.decimals != p.decimals
            })
        {
            return Err(invalid());
        }
        let mut keys = BTreeMap::new();
        for (id, value) in c.data_keys {
            let mut key = Zeroizing::new([0; 32]);
            hex::decode_to_slice(value.as_str(), key.as_mut()).map_err(|_| invalid())?;
            keys.insert(id, key);
        }
        Ok(Self {
            work,
            rpc: EvmReadRpc::with_budget(
                &c.rpc_url,
                RpcBudget::new(redis, c.rpc_budget).map_err(|_| invalid())?,
                metrics,
            )
            .map_err(|_| invalid())?,
            keys: SubmissionKeys::new(c.active_key_id, keys)?,
            policy: c.registry,
            quotes,
            rounding: c.maximum_fee_rounding_raw,
        })
    }
    pub fn quotes(&self) -> Arc<UniswapQuotes> {
        self.quotes.clone()
    }
    pub fn configuration(&self) -> SwapExecutionConfiguration {
        SwapExecutionConfiguration {
            mode: "local_fork",
            quote: self.quotes.configuration(),
            maximum_fee_rounding_raw: self.rounding.to_string(),
        }
    }
    fn request(&self, signer: &str, r: &CreateSwap) -> Result<SwapQuoteRequest, AppError> {
        let slip = uint(&r.slippage_bps)?;
        if slip > U256::from(1000)
            || uint(&r.minimum_output_raw)? == U256::ZERO
            || uint(&r.maximum_network_fee_raw)? == U256::ZERO
            || uint(&r.deadline)? > U256::from(9_007_199_254_740u64)
        {
            return Err(invalid());
        }
        let q = SwapQuoteRequest {
            token_in: r.token_in.clone(),
            token_out: r.token_out.clone(),
            amount_raw: r.amount_raw.clone(),
            slippage_bps: slip.to::<u16>(),
        };
        self.quotes.validate_request(signer, &q)?;
        Ok(q)
    }
    fn intent(&self, signer: &str, r: CreateSwap) -> Result<Intent, AppError> {
        self.request(signer, &r)?;
        Ok(Intent {
            service: SERVICE.into(),
            chain_id: "31337".into(),
            registry_revision: self.policy.registry_revision.clone(),
            fee_policy_revision: self.policy.fee_policy_revision.clone(),
            maximum_fee_rounding_raw: self.rounding.to_string(),
            request: r,
        })
    }
    pub async fn create(
        &self,
        profile: &Profile,
        key: &str,
        input: CreateSwap,
    ) -> Result<OperationRecovery, AppError> {
        if profile.wallet.chain_id != "eip155:31337" {
            return Err(invalid());
        }
        let intent = self.intent(&profile.wallet.address, input)?;
        let deadline = uint(&intent.request.deadline)?;
        if deadline <= U256::from((now() / 1000) as u64)
            || deadline > U256::from((now() / 1000 + 900) as u64)
        {
            return Err(invalid());
        }
        let op = self
            .work
            .create(NewOperation {
                user_id: profile.user_id,
                wallet_id: profile.wallet.id,
                action: Action::Swap,
                idempotency_key: key,
                intent: &serde_json::to_value(intent).map_err(|_| invalid())?,
            })
            .await?;
        self.work
            .recover(profile.user_id, profile.wallet.id, op.id)
            .await
    }
    async fn saved(
        &self,
        user: Uuid,
        wallet: Uuid,
        id: Uuid,
    ) -> Result<(Intent, String, String), AppError> {
        let row=sqlx::query("SELECT i.canonical_json,o.intent_hash,w.address FROM operations o JOIN operation_intents i ON i.operation_id=o.id JOIN wallet_memberships w ON w.id=o.wallet_id AND w.user_id=o.user_id WHERE o.id=$1 AND o.user_id=$2 AND o.wallet_id=$3 AND o.action='swap' AND w.chain_id=31337")
            .bind(id).bind(user).bind(wallet).fetch_optional(&self.work.pool).await.map_err(unavailable)?.ok_or(AppError::NotFound)?;
        let raw: String = row.try_get("canonical_json").map_err(unavailable)?;
        let saved: Intent = serde_json::from_str(&raw).map_err(|_| AppError::NotFound)?;
        if saved.service != SERVICE || saved.chain_id != "31337" {
            return Err(AppError::NotFound);
        }
        let hash = digest(
            &serde_json::to_vec(&(
                1,
                wallet,
                Action::Swap,
                serde_json::from_str::<serde_json::Value>(&raw).map_err(|_| AppError::Busy)?,
            ))
            .map_err(|_| AppError::Busy)?,
        );
        if row
            .try_get::<Vec<u8>, _>("intent_hash")
            .map_err(unavailable)?
            != hash
        {
            return Err(AppError::Busy);
        }
        let signer = format!(
            "0x{}",
            hex::encode(row.try_get::<Vec<u8>, _>("address").map_err(unavailable)?)
        );
        Ok((saved, hex::encode(hash), signer))
    }
    pub async fn recover_intent(
        &self,
        p: &Profile,
        id: Uuid,
    ) -> Result<SwapIntentRecovery, AppError> {
        let (i, _, signer) = self.saved(p.user_id, p.wallet.id, id).await?;
        Ok(SwapIntentRecovery {
            operation_id: id,
            signer,
            chain_id: i.chain_id,
            registry_revision: i.registry_revision,
            fee_policy_revision: i.fee_policy_revision,
            intent: i.request,
        })
    }
    fn bind_review(
        &self,
        i: &Intent,
        hash: &str,
        signer: &str,
        r: &SwapReview,
    ) -> Result<(), AppError> {
        if r.intent_hash != hash
            || r.authority.owner != signer
            || r.authority.chain_id != i.chain_id
            || r.registry_revision != i.registry_revision
            || r.fee_policy_revision != i.fee_policy_revision
            || r.authority.token_in != i.request.token_in
            || r.authority.token_out != i.request.token_out
            || r.authority.maximum_input_raw != i.request.amount_raw
            || uint(&r.authority.minimum_output_raw)? < uint(&i.request.minimum_output_raw)?
            || r.authority.deadline != i.request.deadline
            || r.maximum_network_fee_raw != i.request.maximum_network_fee_raw
            || r.authority
                .fees
                .iter()
                .any(|f| f.maximum_rounding_raw != i.maximum_fee_rounding_raw)
        {
            return Err(conflict());
        }
        Ok(())
    }
    pub async fn review(&self, p: &Profile, id: Uuid) -> Result<SwapReviewRequest, AppError> {
        let (i, hash, signer) = self.saved(p.user_id, p.wallet.id, id).await?;
        let r = self
            .work
            .load_swap_review(&self.keys, p.user_id, p.wallet.id, id)
            .await?;
        self.bind_review(&i, &hash, &signer, &r)?;
        let op = self.work.get(p.user_id, p.wallet.id, id).await?;
        Ok(SwapReviewRequest {
            operation_id: id,
            operation_version: op.version,
            review_hash: r.integrity_hash()?,
            review: r,
        })
    }
    pub async fn permit(
        &self,
        p: &Profile,
        id: Uuid,
        input: SubmitSwapPermit,
    ) -> Result<OperationRecovery, AppError> {
        let review = self.review(p, id).await?;
        // An exact retry acknowledgement needs no live RPC. The repository still
        // verifies exact bytes/version; no new signature can use this branch.
        let recovery = self.work.recover(p.user_id, p.wallet.id, id).await?;
        let observation = if recovery.operation.state == OperationState::AwaitingPermit {
            let context = self.review_quote_block(p.user_id, p.wallet.id, id).await?;
            Some(
                uniswap_execution::observe(&self.rpc, &self.policy, &review.review, &context)
                    .await
                    .map_err(|_| conflict())?
                    .permit_observation(&review.review)
                    .map_err(|_| conflict())?,
            )
        } else {
            None
        };
        self.work
            .stage_swap_permit(
                &self.keys,
                StageSwapPermit {
                    user: p.user_id,
                    wallet: p.wallet.id,
                    operation: id,
                    expected_version: input.expected_version.parse().map_err(|_| invalid())?,
                    review_hash: &input.review_hash,
                    signature: &input.signature,
                    nonce: observation.as_ref(),
                },
            )
            .await?;
        self.work.recover(p.user_id, p.wallet.id, id).await
    }
    async fn review_quote_block(
        &self,
        user: Uuid,
        wallet: Uuid,
        id: Uuid,
    ) -> Result<String, AppError> {
        self.work
            .swap_quote_block(&self.keys, user, wallet, id)
            .await
    }
    async fn signing_for(
        &self,
        user: Uuid,
        wallet: Uuid,
        id: Uuid,
    ) -> Result<SwapSigningRequest, AppError> {
        let (i, hash, signer) = self.saved(user, wallet, id).await?;
        let e = self
            .work
            .load_reviewed_swap_preparation(&self.keys, user, wallet, id)
            .await?;
        self.bind_review(&i, &hash, &signer, &e.review)?;
        let op = self.work.get(user, wallet, id).await?;
        Ok(SwapSigningRequest {
            operation_id: id,
            operation_version: op.version,
            plan_hash: e.prepared.plan.integrity_hash()?,
            review_hash: e.review.integrity_hash()?,
            review: e.review,
            prepared: e.prepared,
        })
    }
    pub async fn signing_request(
        &self,
        p: &Profile,
        id: Uuid,
    ) -> Result<SwapSigningRequest, AppError> {
        self.signing_for(p.user_id, p.wallet.id, id).await
    }
    async fn nonce(&self, signer: &str) -> Result<NonceObservation, AppError> {
        if self.rpc.chain_id().await.map_err(|_| AppError::Busy)? != "0x7a69" {
            return Err(AppError::Busy);
        }
        let (a, b) = tokio::try_join!(
            self.rpc.nonce(signer, "latest"),
            self.rpc.nonce(signer, "pending")
        )
        .map_err(|_| AppError::Busy)?;
        if a != b {
            return Err(conflict());
        }
        let nonce = u64::from_str_radix(
            a.as_str()
                .and_then(|s| s.strip_prefix("0x"))
                .ok_or(AppError::Busy)?,
            16,
        )
        .map_err(|_| AppError::Busy)?;
        Ok(NonceObservation {
            nonce,
            observed_at_ms: now(),
        })
    }
    pub async fn submit(
        &self,
        p: &Profile,
        id: Uuid,
        input: SubmitSwap,
    ) -> Result<OperationRecovery, AppError> {
        let signing = self.signing_request(p, id).await?;
        let prepared = &signing.prepared;
        if input.plan_hash != signing.plan_hash {
            return Err(conflict());
        }
        let bundle = verify_signed_bundle(
            &prepared.plan,
            EvmEnvelopePolicy {
                first_nonce: prepared.first_nonce.parse().map_err(|_| invalid())?,
                maximum_gas_per_transaction: self.policy.maximum_gas_per_transaction,
            },
            &input.signed_transactions,
            // Verify historical bytes for idempotent recovery after expiry.
            // New submissions still require current-time checks below and in stage_signed.
            prepared.plan.simulation.observed_at_ms,
        )
        .map_err(|_| invalid())?;
        prepared.validate_bundle_terms(&bundle)?;
        let recovery = self.work.recover(p.user_id, p.wallet.id, id).await?;
        if let Some(existing) = &recovery.submission {
            if existing.transaction_hashes
                == bundle
                    .transactions()
                    .iter()
                    .map(|t| format!("{:#x}", t.hash()))
                    .collect::<Vec<_>>()
            {
                return Ok(recovery);
            }
            return Err(conflict());
        }
        if input.expected_version != signing.operation_version
            || prepared.plan.expires_at_ms <= now()
        {
            return Err(conflict());
        }
        self.work
            .stage_signed(
                &self.keys,
                StageSubmission {
                    user: p.user_id,
                    wallet: p.wallet.id,
                    operation: id,
                    expected_version: input.expected_version.parse().map_err(|_| invalid())?,
                    bundle: &bundle,
                    nonce: self.nonce(&prepared.plan.signer).await?,
                },
            )
            .await?;
        self.work.recover(p.user_id, p.wallet.id, id).await
    }
    pub fn start(
        self: Arc<Self>,
        health: crate::runtime::RuntimeHealth,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                if !health.is_draining() && self.tick_inner(Some(&health)).await.is_err() {
                    tracing::warn!(
                        error_code = "swap_worker_retry",
                        "Swap worker deferred work"
                    );
                }
            }
        })
    }
    pub async fn tick(&self) -> Result<bool, AppError> {
        self.tick_inner(None).await
    }
    async fn tick_inner(
        &self,
        health: Option<&crate::runtime::RuntimeHealth>,
    ) -> Result<bool, AppError> {
        let Some(lease) = self.claim(None).await? else {
            return Ok(false);
        };
        let result = tokio::time::timeout(Duration::from_secs(180), self.process(&lease, health))
            .await
            .unwrap_or(Err(AppError::Timeout));
        if result.is_err() {
            self.defer(&lease).await?;
        }
        result.map(|_| true)
    }
    async fn claim(&self, immediate: Option<Uuid>) -> Result<Option<JobLease>, AppError> {
        let token = Uuid::new_v4();
        let row=sqlx::query("WITH candidate AS (SELECT j.id FROM jobs j JOIN operations o ON o.id=j.operation_id AND o.version=j.operation_version JOIN operation_intents i ON i.operation_id=o.id WHERE i.canonical_json::jsonb->>'service'=$3 AND o.state IN ('created','building_swap','signed','unknown','confirming') AND ($1::uuid IS NULL OR o.id=$1) AND ((j.state='ready' AND (j.available_at<=clock_timestamp() OR $1::uuid IS NOT NULL)) OR (j.state='leased' AND j.lease_until<=clock_timestamp())) ORDER BY j.available_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED) UPDATE jobs SET state='leased',lease_token=$2,lease_until=clock_timestamp()+interval '240 seconds',attempts=LEAST(attempts+1,8) WHERE id IN (SELECT id FROM candidate) RETURNING id,operation_id,operation_version,attempts")
            .bind(immediate).bind(token).bind(SERVICE).fetch_optional(&self.work.pool).await.map_err(unavailable)?;
        row.map(|r| {
            Ok(JobLease {
                id: r.try_get("id").map_err(unavailable)?,
                operation_id: r.try_get("operation_id").map_err(unavailable)?,
                operation_version: r.try_get("operation_version").map_err(unavailable)?,
                token,
                attempts: r.try_get("attempts").map_err(unavailable)?,
            })
        })
        .transpose()
    }
    async fn defer(&self, lease: &JobLease) -> Result<(), AppError> {
        let delay = crate::work::retry_delay_seconds(lease.attempts);
        sqlx::query("UPDATE jobs SET state='ready',lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+make_interval(secs=>$3::double precision),last_error_code='upstream_unavailable' WHERE id=$1 AND lease_token=$2 AND state='leased' AND lease_until>clock_timestamp()")
            .bind(lease.id).bind(lease.token).bind(f64::from(delay)).execute(&self.work.pool).await.map_err(unavailable)?;
        Ok(())
    }
    async fn fail(&self, lease: &JobLease) -> Result<(), AppError> {
        self.work
            .transition(
                lease.operation_id,
                lease.operation_version,
                OperationState::Failed,
                lease,
            )
            .await?;
        Ok(())
    }
    #[tracing::instrument(name="execution.swap_job",skip_all,fields(operation_id=%lease.operation_id,operation_version=lease.operation_version))]
    async fn process(
        &self,
        lease: &JobLease,
        health: Option<&crate::runtime::RuntimeHealth>,
    ) -> Result<(), AppError> {
        let row = sqlx::query("SELECT user_id,wallet_id FROM operations WHERE id=$1")
            .bind(lease.operation_id)
            .fetch_one(&self.work.pool)
            .await
            .map_err(unavailable)?;
        let user = row.try_get("user_id").map_err(unavailable)?;
        let wallet = row.try_get("wallet_id").map_err(unavailable)?;
        let id = lease.operation_id;
        let (intent, hash, signer) = self.saved(user, wallet, id).await?;
        let recovery = self.work.recover(user, wallet, id).await?;
        if matches!(
            recovery.operation.state,
            OperationState::Created | OperationState::BuildingSwap
        ) {
            let valid = self.intent(&signer, intent.request.clone())?;
            if serde_json::to_value(&intent).ok() != serde_json::to_value(valid).ok()
                || uint(&intent.request.deadline)? <= U256::from((now() / 1000) as u64)
            {
                return self.fail(lease).await;
            }
        }
        if recovery.operation.state == OperationState::Created {
            let artifact = self
                .quotes
                .quote_for_review(&signer, self.request(&signer, &intent.request)?)
                .await?;
            if uint(&artifact.quote().minimum_output_raw)?
                < uint(&intent.request.minimum_output_raw)?
            {
                return self.fail(lease).await;
            }
            let review = artifact.review(ReviewOptions {
                intent_hash: hash,
                deadline: intent.request.deadline.clone(),
                maximum_network_fee_raw: intent.request.maximum_network_fee_raw.clone(),
                maximum_fee_rounding_raw: self.rounding,
            })?;
            self.bind_review(&intent, &review.intent_hash, &signer, &review)?;
            match uniswap_execution::observe(
                &self.rpc,
                &self.policy,
                &review,
                &artifact.quote().source_block,
            )
            .await
            {
                Ok(_) => {}
                Err(EvmPreparationError::Rpc(_) | EvmPreparationError::Timeout) => {
                    return Err(AppError::Busy);
                }
                Err(_) => return self.fail(lease).await,
            }
            return self
                .work
                .persist_swap_review(
                    &self.keys,
                    lease,
                    &review,
                    &serde_json::from_slice(artifact.raw_quote()).map_err(|_| AppError::Busy)?,
                )
                .await;
        }
        if recovery.operation.state == OperationState::BuildingSwap {
            let context = self
                .work
                .load_swap_build(&self.keys, user, wallet, id)
                .await?;
            self.bind_review(&intent, &hash, &signer, &context.review)?;
            let build = self.quotes.build_swap(&context).await?;
            return match uniswap_execution::prepare(
                &self.rpc,
                &self.policy,
                &context.review,
                &build,
            )
            .await
            {
                Ok(p) => {
                    self.work
                        .persist_reviewed_swap_preparation(&self.keys, lease, &p)
                        .await
                }
                Err(EvmPreparationError::Rpc(_) | EvmPreparationError::Timeout) => {
                    Err(AppError::Busy)
                }
                Err(_) => self.fail(lease).await,
            };
        }
        let signing = self.signing_for(user, wallet, id).await?;
        let p = &signing.prepared;
        let attempted:Vec<i16>=sqlx::query_scalar("SELECT t.step FROM evm_signed_transactions t JOIN evm_dispatch_attempts d ON d.transaction_id=t.id WHERE t.operation_id=$1 ORDER BY t.step").bind(id).fetch_all(&self.work.pool).await.map_err(unavailable)?;
        let next = (0..p.plan.steps.len()).find(|i| !attempted.contains(&(*i as i16)));
        let preflight = if let Some(step) = next {
            self.preflight(user, wallet, id, p, step)
                .await
                .map(|_| (step, now()))
        } else {
            Err(conflict())
        };
        let context = self.work.reconciliation_context(&self.keys, id).await?;
        let report = crate::reconciliation::collect(&self.rpc, &context)
            .await
            .map_err(|_| AppError::Busy)?;
        self.work.record_reconciliation(lease, &report).await?;
        if let Ok((step, at)) = preflight
            && let Some(next) = self.claim(Some(id)).await?
        {
            let result = self.dispatch(&next, p, step, at, health).await;
            if result.is_err() {
                self.defer(&next).await?;
            }
            result?;
        }
        Ok(())
    }
    async fn preflight(
        &self,
        user: Uuid,
        wallet: Uuid,
        id: Uuid,
        p: &PreparedEvm,
        step: usize,
    ) -> Result<(), AppError> {
        let evidence = self
            .work
            .load_reviewed_swap_preparation(&self.keys, user, wallet, id)
            .await?;
        let context = self
            .work
            .load_stored_swap_build(&self.keys, user, wallet, id)
            .await?;
        let build = self
            .quotes
            .restore_build(&context, p, &evidence.build_request_id)?;
        let current = uniswap_execution::prepare(&self.rpc, &self.policy, &context.review, &build)
            .await
            .map_err(|_| conflict())?;
        let current = current.prepared();
        if current.first_nonce != (uint(&p.first_nonce)? + U256::from(step)).to_string()
            || serde_json::to_value(&current.plan.steps).ok()
                != serde_json::to_value(&p.plan.steps[step..]).ok()
            || uint(&current.max_fee_per_gas)? > uint(&p.max_fee_per_gas)?
            || current.gas_limits.len() != p.gas_limits[step..].len()
            || current
                .gas_limits
                .iter()
                .zip(&p.gas_limits[step..])
                .any(|(a, b)| uint(a).ok() > uint(b).ok())
        {
            return Err(conflict());
        }
        Ok(())
    }
    async fn dispatch(
        &self,
        lease: &JobLease,
        p: &PreparedEvm,
        step: usize,
        at: i64,
        health: Option<&crate::runtime::RuntimeHealth>,
    ) -> Result<(), AppError> {
        let nonce = self.nonce(&p.plan.signer).await?;
        let admission = self
            .rpc
            .reserve_local_broadcast()
            .await
            .map_err(|_| AppError::Busy)?;
        if now() - at > 10_000 || health.is_some_and(|h| h.is_draining()) {
            return Err(conflict());
        }
        let attempt = self
            .work
            .begin_dispatch_step(&self.keys, lease, nonce, step as u8)
            .await?;
        let outcome =
            if !health.is_some_and(|h| h.is_draining()) && admission.send(&attempt).await.is_ok() {
                DispatchObservation::Acknowledged
            } else {
                DispatchObservation::Unknown
            };
        self.work.observe_dispatch(&attempt, outcome).await
    }
}

#[cfg(test)]
mod tests;
