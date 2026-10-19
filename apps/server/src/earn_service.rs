//! Shared durable orchestration; provider adapters own economics, calldata and registry checks.
use crate::{
    error::AppError,
    evm_envelope::{EvmEnvelopePolicy, verify_signed_bundle},
    identity::{Profile, digest, unavailable},
    preparation::{OperationRecovery, PreparationProvider},
    providers::{
        evm_prepare::{EvmPreparationError, PreparedEvm},
        evm_rpc::EvmReadRpc,
    },
    submissions::{DispatchObservation, NonceObservation, StageSubmission, SubmissionKeys},
    work::{Action, JobLease, NewOperation, OperationState, WorkStore},
};
use alloy_primitives::{Address, U256};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sqlx::Row;
use std::{future::Future, sync::Arc, time::Duration};
use uuid::Uuid;

pub struct EarnIdentity {
    pub chain_id: String,
    pub asset: String,
    pub registry_revision: String,
    pub fee_policy_revision: String,
}
pub trait EarnAdapter: Send + Sync + 'static {
    type Request: Clone + Serialize + DeserializeOwned + Send + Sync;
    type Configuration: Clone + Serialize;
    const SERVICE: &'static str;
    const PROVIDER: PreparationProvider;
    fn identity(&self) -> EarnIdentity;
    fn configuration(&self) -> Self::Configuration;
    fn validate(&self, request: &Self::Request) -> Result<(), AppError>;
    fn validate_new(&self, request: &Self::Request) -> Result<(), AppError> {
        self.validate(request)
    }
    fn network_budget(&self, request: &Self::Request) -> Result<U256, AppError>;
    fn prepare(
        &self,
        rpc: &EvmReadRpc,
        request: &Self::Request,
        signer: Address,
        intent_hash: String,
        maximum_network_fee: U256,
    ) -> impl Future<Output = Result<PreparedEvm, EvmPreparationError>> + Send;
}
pub(crate) fn invalid() -> AppError {
    AppError::BadRequest("invalid Earn execution request".into())
}
fn conflict() -> AppError {
    AppError::Conflict("Earn signing request changed, expired, or is unavailable".into())
}
fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
pub(crate) fn uint(s: &str) -> Result<U256, AppError> {
    if s.is_empty()
        || s.len() > 78
        || (s.len() > 1 && s.starts_with('0'))
        || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid());
    }
    U256::from_str_radix(s, 10).map_err(|_| invalid())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent<R> {
    service: String,
    chain_id: String,
    asset: String,
    registry_revision: String,
    fee_policy_revision: String,
    request: R,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarnIntentRecovery<R> {
    pub operation_id: Uuid,
    pub signer: String,
    pub chain_id: String,
    pub asset: String,
    pub registry_revision: String,
    pub fee_policy_revision: String,
    pub intent: R,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EarnSigningRequest {
    pub operation_id: Uuid,
    pub operation_version: String,
    pub plan_hash: String,
    pub prepared: PreparedEvm,
}
// No Debug. Signed bytes are broadcast authority.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitEarn {
    pub expected_version: String,
    pub plan_hash: String,
    pub signed_transactions: Vec<String>,
}
impl Drop for SubmitEarn {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.signed_transactions.zeroize();
    }
}

pub struct LocalEarnService<A: EarnAdapter> {
    pub(crate) work: WorkStore,
    pub(crate) rpc: EvmReadRpc,
    pub(crate) keys: SubmissionKeys,
    pub(crate) adapter: A,
}
impl<A: EarnAdapter> LocalEarnService<A> {
    pub fn configuration(&self) -> A::Configuration {
        self.adapter.configuration()
    }
    fn intent(&self, request: A::Request) -> Result<Intent<A::Request>, AppError> {
        self.adapter.validate(&request)?;
        let identity = self.adapter.identity();
        Ok(Intent {
            service: A::SERVICE.into(),
            chain_id: identity.chain_id,
            asset: identity.asset,
            registry_revision: identity.registry_revision,
            fee_policy_revision: identity.fee_policy_revision,
            request,
        })
    }
    pub async fn create(
        &self,
        profile: &Profile,
        key: &str,
        input: A::Request,
    ) -> Result<OperationRecovery, AppError> {
        if profile.wallet.chain_id != "eip155:31337" {
            return Err(invalid());
        }
        self.adapter.validate_new(&input)?;
        let intent = serde_json::to_value(self.intent(input)?).map_err(|_| invalid())?;
        let op = self
            .work
            .create(NewOperation {
                user_id: profile.user_id,
                wallet_id: profile.wallet.id,
                action: Action::Earn,
                idempotency_key: key,
                intent: &intent,
            })
            .await?;
        self.work
            .recover(profile.user_id, profile.wallet.id, op.id)
            .await
    }
    /// Read the immutable typed intent for a NEW explicit review after app restart.
    /// This endpoint cannot authorize signing or reconstruct an arbitrary intent.
    pub async fn recover_intent(
        &self,
        profile: &Profile,
        id: Uuid,
    ) -> Result<EarnIntentRecovery<A::Request>, AppError> {
        let recovery = self
            .work
            .recover(profile.user_id, profile.wallet.id, id)
            .await?;
        if recovery.operation.action != Action::Earn {
            return Err(AppError::NotFound);
        }
        let json:String=sqlx::query_scalar("SELECT i.canonical_json FROM operation_intents i JOIN operations o ON o.id=i.operation_id WHERE o.id=$1 AND o.user_id=$2 AND o.wallet_id=$3")
            .bind(id).bind(profile.user_id).bind(profile.wallet.id).fetch_optional(&self.work.pool).await.map_err(unavailable)?.ok_or(AppError::NotFound)?;
        let saved: Intent<A::Request> =
            serde_json::from_str(&json).map_err(|_| AppError::NotFound)?;
        if saved.service != A::SERVICE {
            return Err(AppError::NotFound);
        }
        // Reject corrupted exact amounts. The saved revisions remain historical;
        // callers must compare against the current registry before another review.
        self.intent(saved.request.clone())?;
        Ok(EarnIntentRecovery {
            operation_id: id,
            signer: profile.wallet.address.to_lowercase(),
            chain_id: saved.chain_id,
            asset: saved.asset,
            registry_revision: saved.registry_revision,
            fee_policy_revision: saved.fee_policy_revision,
            intent: saved.request,
        })
    }
    pub async fn signing_request(
        &self,
        profile: &Profile,
        id: Uuid,
    ) -> Result<EarnSigningRequest, AppError> {
        self.signing_for(profile.user_id, profile.wallet.id, id)
            .await
    }
    async fn signing_for(
        &self,
        user: Uuid,
        wallet: Uuid,
        id: Uuid,
    ) -> Result<EarnSigningRequest, AppError> {
        let row=sqlx::query("SELECT s.canonical_json,s.request_hash,o.version FROM evm_signing_requests s JOIN operations o ON o.id=s.operation_id WHERE o.id=$1 AND o.user_id=$2 AND o.wallet_id=$3")
            .bind(id).bind(user).bind(wallet).fetch_optional(&self.work.pool).await.map_err(unavailable)?.ok_or(AppError::NotFound)?;
        let json: String = row.try_get("canonical_json").map_err(unavailable)?;
        if digest(json.as_bytes())
            != row
                .try_get::<Vec<u8>, _>("request_hash")
                .map_err(unavailable)?
        {
            return Err(AppError::Busy);
        }
        let prepared: PreparedEvm = serde_json::from_str(&json).map_err(|_| AppError::Busy)?;
        if prepared.plan.provider != A::PROVIDER {
            return Err(AppError::NotFound);
        }
        prepared
            .validate_signing_terms()
            .map_err(|_| AppError::Busy)?;
        let plan = self.work.load_preparation(user, wallet, id).await?;
        let plan_hash = plan.integrity_hash()?;
        if plan_hash != prepared.plan.integrity_hash()? {
            return Err(AppError::Busy);
        }
        Ok(EarnSigningRequest {
            operation_id: id,
            operation_version: row
                .try_get::<i64, _>("version")
                .map_err(unavailable)?
                .to_string(),
            plan_hash,
            prepared,
        })
    }
    async fn nonce(&self, signer: &str) -> Result<NonceObservation, AppError> {
        let chain = self.rpc.chain_id().await.map_err(|_| AppError::Busy)?;
        if chain != "0x7a69" {
            return Err(AppError::Busy);
        }
        let pending = self
            .rpc
            .nonce(signer, "pending")
            .await
            .map_err(|_| AppError::Busy)?;
        let latest = self
            .rpc
            .nonce(signer, "latest")
            .await
            .map_err(|_| AppError::Busy)?;
        if pending != latest {
            return Err(conflict());
        }
        let s = pending
            .as_str()
            .and_then(|s| s.strip_prefix("0x"))
            .ok_or(AppError::Busy)?;
        let nonce = u64::from_str_radix(s, 16).map_err(|_| AppError::Busy)?;
        Ok(NonceObservation {
            nonce,
            observed_at_ms: now_ms(),
        })
    }
    pub async fn submit(
        &self,
        profile: &Profile,
        id: Uuid,
        input: SubmitEarn,
    ) -> Result<OperationRecovery, AppError> {
        let signing = self.signing_request(profile, id).await?;
        let p = &signing.prepared;
        if input.plan_hash != signing.plan_hash {
            return Err(conflict());
        }
        let bundle = verify_signed_bundle(
            &p.plan,
            EvmEnvelopePolicy {
                first_nonce: p.first_nonce.parse().map_err(|_| AppError::Busy)?,
                maximum_gas_per_transaction: 2_000_000,
            },
            &input.signed_transactions,
            // Verify historical bytes for idempotent recovery after expiry.
            // New submissions still require current-time checks below and in stage_signed.
            p.plan.simulation.observed_at_ms,
        )
        .map_err(|_| invalid())?;
        p.validate_bundle_terms(&bundle).map_err(|_| invalid())?;
        let recovery = self
            .work
            .recover(profile.user_id, profile.wallet.id, id)
            .await?;
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
        if input.expected_version != signing.operation_version || p.plan.expires_at_ms <= now_ms() {
            return Err(conflict());
        }
        let nonce = self.nonce(&p.plan.signer).await?;
        self.work
            .stage_signed(
                &self.keys,
                StageSubmission {
                    user: profile.user_id,
                    wallet: profile.wallet.id,
                    operation: id,
                    expected_version: input.expected_version.parse().map_err(|_| invalid())?,
                    bundle: &bundle,
                    nonce,
                },
            )
            .await?;
        self.work
            .recover(profile.user_id, profile.wallet.id, id)
            .await
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
                if health.is_draining() {
                    continue;
                }
                if self.tick_inner(Some(&health)).await.is_err() {
                    tracing::warn!(
                        error_code = "earn_worker_retry",
                        "Earn worker could not complete work"
                    );
                }
            }
        })
    }
    // Public for deterministic service acceptance tests; same function is supervised
    // in main. One bounded job per tick, no unbounded per-user spawn.
    pub async fn tick(&self) -> Result<bool, AppError> {
        self.tick_inner(None).await
    }
    #[tracing::instrument(name = "execution.earn_worker", skip_all)]
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
            tracing::warn!(operation_id=%lease.operation_id, error_code="earn_job_deferred", "Earn job deferred for reconciliation or retry");
            // Unknown money movement must remain reconcilable. Retry reads with a
            // bounded delay, never dead-letter or resend signed payloads on timeout.
            self.defer(&lease).await?;
        }
        result.map(|_| true)
    }
    async fn claim(&self, immediate: Option<Uuid>) -> Result<Option<JobLease>, AppError> {
        let token = Uuid::new_v4();
        let row=sqlx::query("WITH candidate AS (SELECT j.id FROM jobs j JOIN operations o ON o.id=j.operation_id AND o.version=j.operation_version JOIN operation_intents i ON i.operation_id=o.id WHERE i.canonical_json::jsonb->>'service'=$3 AND o.state IN ('created','signed','unknown','confirming') AND ($1::uuid IS NULL OR o.id=$1) AND ((j.state='ready' AND (j.available_at<=clock_timestamp() OR $1::uuid IS NOT NULL)) OR (j.state='leased' AND j.lease_until<=clock_timestamp())) ORDER BY j.available_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED) UPDATE jobs SET state='leased',lease_token=$2,lease_until=clock_timestamp()+interval '240 seconds',attempts=LEAST(attempts+1,8) WHERE id IN (SELECT id FROM candidate) RETURNING id,operation_id,operation_version,attempts")
            .bind(immediate).bind(token).bind(A::SERVICE).fetch_optional(&self.work.pool).await.map_err(unavailable)?;
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
    #[tracing::instrument(name="execution.earn_job", skip_all, fields(operation_id=%lease.operation_id, operation_version=lease.operation_version))]
    async fn process(
        &self,
        lease: &JobLease,
        health: Option<&crate::runtime::RuntimeHealth>,
    ) -> Result<(), AppError> {
        let row=sqlx::query("SELECT o.user_id,o.wallet_id,i.canonical_json,w.address FROM operations o JOIN operation_intents i ON i.operation_id=o.id JOIN wallet_memberships w ON w.id=o.wallet_id WHERE o.id=$1")
            .bind(lease.operation_id).fetch_one(&self.work.pool).await.map_err(unavailable)?;
        let user: Uuid = row.try_get("user_id").map_err(unavailable)?;
        let wallet: Uuid = row.try_get("wallet_id").map_err(unavailable)?;
        let recovery = self.work.recover(user, wallet, lease.operation_id).await?;
        let intent: Intent<A::Request> = serde_json::from_str(
            &row.try_get::<String, _>("canonical_json")
                .map_err(unavailable)?,
        )
        .map_err(|_| AppError::Busy)?;
        let valid = self.intent(intent.request.clone())?;
        if recovery.operation.state == OperationState::Created
            && serde_json::to_value(&intent).ok() != serde_json::to_value(&valid).ok()
        {
            return Err(conflict());
        }
        let signer =
            Address::from_slice(&row.try_get::<Vec<u8>, _>("address").map_err(unavailable)?);
        let intent_hash = hex::encode(digest(
            &serde_json::to_vec(&(
                1,
                wallet,
                Action::Earn,
                serde_json::to_value(&intent).map_err(|_| AppError::Busy)?,
            ))
            .map_err(|_| AppError::Busy)?,
        ));
        if recovery.operation.state == OperationState::Created {
            let prepared = self
                .adapter
                .prepare(
                    &self.rpc,
                    &intent.request,
                    signer,
                    intent_hash,
                    self.adapter.network_budget(&intent.request)?,
                )
                .await;
            return match prepared {
                Ok(p) => self.work.persist_evm_preparation(lease, &p).await,
                Err(EvmPreparationError::Rpc(_) | EvmPreparationError::Timeout) => {
                    Err(AppError::Busy)
                }
                Err(_) => {
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
            };
        }
        let signing = self.signing_for(user, wallet, lease.operation_id).await?;
        let p = &signing.prepared;
        let attempted:Vec<i16>=sqlx::query_scalar("SELECT t.step FROM evm_signed_transactions t JOIN evm_dispatch_attempts d ON d.transaction_id=t.id WHERE t.operation_id=$1 ORDER BY t.step")
            .bind(lease.operation_id).fetch_all(&self.work.pool).await.map_err(unavailable)?;
        let next = (0..p.plan.steps.len()).find(|i| !attempted.contains(&(*i as i16)));
        let preflight = if let Some(step) = next {
            self.preflight(p, &intent, step)
                .await
                .map(|_| (step, now_ms()))
        } else {
            Err(conflict())
        };
        // Reconciliation runs even when policy/fees/expiry prohibit any new send.
        let context = self
            .work
            .reconciliation_context(&self.keys, lease.operation_id)
            .await?;
        let report = crate::reconciliation::collect(&self.rpc, &context)
            .await
            .map_err(|_| AppError::Busy)?;
        self.work.record_reconciliation(lease, &report).await?;
        if let Ok((step, preflight_at)) = preflight {
            // Reclaim only this operation's current notification; the receipt commit
            // consumed the original lease. A competing worker wins by fencing.
            if let Some(next_lease) = self.claim(Some(lease.operation_id)).await? {
                let result = self
                    .dispatch(&next_lease, p, step, preflight_at, health)
                    .await;
                if result.is_err() {
                    self.defer(&next_lease).await?;
                }
                result?;
            }
        }
        Ok(())
    }
    async fn preflight(
        &self,
        p: &PreparedEvm,
        intent: &Intent<A::Request>,
        step: usize,
    ) -> Result<(), AppError> {
        if p.plan.expires_at_ms <= now_ms()
            || p.plan.registry_revision != self.adapter.identity().registry_revision
            || p.plan.fee_policy_revision != self.adapter.identity().fee_policy_revision
        {
            return Err(conflict());
        }
        let current = self
            .adapter
            .prepare(
                &self.rpc,
                &intent.request,
                p.plan.signer.parse().map_err(|_| AppError::Busy)?,
                p.plan.intent_hash.clone(),
                uint(&p.plan.maximum_network_fee_raw)?,
            )
            .await
            .map_err(|_| conflict())?;
        if current.first_nonce != (uint(&p.first_nonce)? + U256::from(step)).to_string()
            || serde_json::to_value(&current.plan.steps).ok()
                != serde_json::to_value(&p.plan.steps[step..]).ok()
            || uint(&current.max_fee_per_gas)? > uint(&p.max_fee_per_gas)?
            || current.plan.maximum_spend.amount_raw != p.plan.maximum_spend.amount_raw
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
        preflight_at: i64,
        health: Option<&crate::runtime::RuntimeHealth>,
    ) -> Result<(), AppError> {
        let nonce = self.nonce(&p.plan.signer).await?;
        let admission = self
            .rpc
            .reserve_local_broadcast()
            .await
            .map_err(|_| AppError::Busy)?;
        if now_ms() - preflight_at > 10_000 || health.is_some_and(|h| h.is_draining()) {
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

pub(crate) fn load_file<T: DeserializeOwned>(path: &str) -> Result<T, AppError> {
    use std::io::Read;
    use zeroize::Zeroizing;
    let file = std::fs::File::open(path).map_err(|_| invalid())?;
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.len() > 65536 {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(invalid());
        }
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > 65536 {
        return Err(invalid());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
pub(crate) fn decode_keys<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<std::collections::BTreeMap<String, zeroize::Zeroizing<String>>, D::Error> {
    Ok(
        std::collections::BTreeMap::<String, String>::deserialize(d)?
            .into_iter()
            .map(|(k, v)| (k, zeroize::Zeroizing::new(v)))
            .collect(),
    )
}
