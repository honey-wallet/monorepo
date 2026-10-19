//! Local-fork Across lifecycle: immutable quote consent, simulation, client signing,
//! journaled source dispatch, and evidence-gated destination completion.
use crate::{
    bridge_monitor::BridgeMonitor,
    earn_service::{decode_keys, load_file, uint},
    error::AppError,
    evm_envelope::{EvmEnvelopePolicy, verify_signed_bundle},
    identity::{Profile, digest, unavailable},
    preparation::{OperationRecovery, PreparationProvider},
    providers::{
        across_evidence::{self, DirectDepositTerms, EvidencePolicy},
        across_execution::{
            self, AcrossExecutionPolicy, AcrossPreparationRequest, AcrossPreparationReview,
            FEE_POLICY_REVISION,
        },
        across_quotes::{AcrossConfiguration, AcrossQuote, AcrossQuoteRequest, AcrossQuotes},
        bridge_status::CandidateRole,
        evm_prepare::{EvmPreparationError, PreparedEvm},
        evm_rpc::EvmReadRpc,
        rpc_budget::{RpcBudget, RpcBudgetConfig},
    },
    submissions::{DispatchObservation, NonceObservation, StageSubmission, SubmissionKeys},
    work::{Action, JobLease, NewOperation, OperationState, WorkStore},
};
use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "across_local_v1";
fn invalid() -> AppError {
    AppError::BadRequest("invalid Across operation".into())
}
fn conflict() -> AppError {
    AppError::Conflict(
        "Across quote, operation, or signing terms changed; recover current operation".into(),
    )
}
fn unix() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp_nanos() as i64 / 1_000_000
}
fn decimal(s: &str) -> Result<U256, AppError> {
    uint(s)
}

mod intent_millis {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Repr {
        String(String),
        Integer(i64),
    }

    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        match Repr::deserialize(deserializer)? {
            Repr::String(value) => value.parse().map_err(D::Error::custom),
            Repr::Integer(value) => Ok(value),
        }
    }
}

mod optional_intent_millis {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Repr {
        String(String),
        Integer(i64),
    }

    pub fn serialize<S: Serializer>(value: &Option<i64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => serializer.serialize_some(&value.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<i64>, D::Error> {
        Option::<Repr>::deserialize(deserializer)?.map_or(Ok(None), |value| match value {
            Repr::String(value) => value.parse().map(Some).map_err(D::Error::custom),
            Repr::Integer(value) => Ok(Some(value)),
        })
    }
}

fn dispatch_simulation_fits(signed: &PreparedEvm, fresh: &PreparedEvm, step: usize) -> bool {
    if step >= signed.plan.steps.len() {
        return false;
    }
    let remaining = &signed.plan.steps[step..];
    let expected_nonce = match signed
        .first_nonce
        .parse::<u64>()
        .ok()
        .and_then(|n| n.checked_add(step as u64))
    {
        Some(n) => n,
        None => return false,
    };
    if fresh.plan.intent_hash != signed.plan.intent_hash
        || fresh.plan.registry_revision != signed.plan.registry_revision
        || fresh.plan.fee_policy_revision != signed.plan.fee_policy_revision
        || fresh.plan.chain_id != signed.plan.chain_id
        || fresh.plan.signer != signed.plan.signer
        || fresh.first_nonce.parse::<u64>().ok() != Some(expected_nonce)
        || fresh.plan.steps.len() != remaining.len()
        || !remaining.iter().zip(&fresh.plan.steps).all(|(old, new)| {
            old.purpose == new.purpose
                && old.to == new.to
                && old.value_raw == new.value_raw
                && old.data == new.data
        })
    {
        return false;
    }
    let (Ok(old_max_fee), Ok(old_priority), Ok(fresh_max_fee), Ok(fresh_priority)) = (
        decimal(&signed.max_fee_per_gas),
        decimal(&signed.max_priority_fee_per_gas),
        decimal(&fresh.max_fee_per_gas),
        decimal(&fresh.max_priority_fee_per_gas),
    ) else {
        return false;
    };
    let Ok(remaining_gas) = signed.gas_limits[step..]
        .iter()
        .map(|gas| decimal(gas))
        .collect::<Result<Vec<_>, _>>()
    else {
        return false;
    };
    let gas_fits = remaining_gas
        .iter()
        .zip(&fresh.gas_limits)
        .all(|(signed, fresh)| decimal(fresh).is_ok_and(|fresh| fresh <= *signed));
    let fee_cap = remaining_gas.iter().try_fold(U256::ZERO, |sum, gas| {
        gas.checked_mul(old_max_fee)?.checked_add(sum)
    });
    gas_fits
        && fresh_max_fee <= old_max_fee
        && fresh_priority <= old_priority
        && fee_cap.is_some_and(|cap| {
            decimal(&fresh.plan.maximum_network_fee_raw).is_ok_and(|fee| fee <= cap)
        })
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAcross {
    pub route_id: String,
    pub quote_id: String,
    pub amount_raw: String,
    pub minimum_output_raw: String,
    pub recipient: String,
    /// Last permitted source-chain execution time, unix seconds.
    pub deadline: String,
    pub maximum_network_fee_raw: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    service: String,
    chain_id: String,
    registry_revision: String,
    fee_policy_revision: String,
    request: CreateAcross,
    terms: DirectDepositTerms,
    source_spoke: String,
    calldata: String,
    #[serde(with = "intent_millis")]
    quoted_at_ms: i64,
    #[serde(with = "intent_millis")]
    quote_expires_at_ms: i64,
    #[serde(with = "optional_intent_millis")]
    provider_expires_at_ms: Option<i64>,
}
/// Interpret immutable consent without rewriting it or consulting today's registry.
/// A service discriminator never falls back to the older proof-store format.
/// Historical registry pins must remain available to the worker until settlement.
pub(crate) fn stored_bridge_terms(value: &Value) -> Result<DirectDepositTerms, AppError> {
    if value.get("service").is_none() {
        return serde_json::from_value(value["acrossDirectDeposit"].clone())
            .map_err(|_| conflict());
    }
    let i: Intent = serde_json::from_value(value.clone()).map_err(|_| conflict())?;
    let deadline = i.request.deadline.parse::<i64>().map_err(|_| conflict())?;
    if i.service != SERVICE
        || i.chain_id != "31337"
        || i.terms.source_chain != 31337
        || i.terms.destination_chain != 31338
        || i.fee_policy_revision != FEE_POLICY_REVISION
        || deadline.to_string() != i.request.deadline
        || decimal(&i.request.amount_raw)? != i.terms.input_amount
        || decimal(&i.request.minimum_output_raw)? > i.terms.output_amount
        || i.request
            .recipient
            .parse::<Address>()
            .map_err(|_| conflict())?
            != i.terms.recipient
        || i.request.route_id.is_empty()
    {
        return Err(conflict());
    }
    // Validate the saved quote, calldata, expiry bounds and revision syntax at
    // their original timestamps. Settlement must remain possible after expiry.
    AcrossPreparationRequest {
        terms: i.terms.clone(),
        source_spoke: i.source_spoke,
        calldata: i.calldata,
        quote_id: i.request.quote_id,
        registry_revision: i.registry_revision,
        // This validator checks syntax; callers separately bind the entire
        // immutable intent hash and the signed source transaction.
        intent_hash: "0".repeat(64),
        quoted_at_ms: i.quoted_at_ms,
        quote_expires_at_ms: i.quote_expires_at_ms,
        provider_expires_at_ms: i.provider_expires_at_ms,
        execution_deadline_ms: deadline.checked_mul(1000).ok_or_else(conflict)?,
        maximum_network_fee_raw: i.request.maximum_network_fee_raw,
    }
    .validate()
    .map_err(|_| conflict())?;
    Ok(i.terms)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcrossExecutionConfiguration {
    pub mode: &'static str,
    pub quote: AcrossConfiguration,
    pub fee_policy_revision: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcrossSigningRequest {
    pub operation_id: Uuid,
    pub operation_version: String,
    pub plan_hash: String,
    pub review: AcrossPreparationReview,
    pub prepared: PreparedEvm,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcrossIntentRecovery {
    pub operation_id: Uuid,
    pub signer: String,
    pub chain_id: String,
    pub registry_revision: String,
    pub intent: CreateAcross,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitAcross {
    pub expected_version: String,
    pub plan_hash: String,
    pub signed_transactions: Vec<String>,
}
impl Drop for SubmitAcross {
    fn drop(&mut self) {
        self.signed_transactions.zeroize();
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedQuote {
    wallet_id: Uuid,
    sender: String,
    request: AcrossQuoteRequest,
    raw: Value,
    received_at_ms: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileConfig {
    mode: String,
    rpc_url: String,
    rpc_budget: RpcBudgetConfig,
    destination_rpc_url: String,
    destination_rpc_budget: RpcBudgetConfig,
    quote_config_file: String,
    quote_fixture_origin: String,
    status_fixture_origin: String,
    registry_revision: String,
    source_policy: EvidencePolicy,
    destination_policy: EvidencePolicy,
    decimals: u8,
    allow_empty_approval_return: bool,
    maximum_gas_per_transaction: u64,
    active_key_id: String,
    #[serde(deserialize_with = "decode_keys")]
    data_keys: BTreeMap<String, Zeroizing<String>>,
}
pub struct AcrossService {
    work: WorkStore,
    redis: crate::redis_store::RedisStore,
    quotes: Arc<AcrossQuotes>,
    rpc: EvmReadRpc,
    destination_rpc: EvmReadRpc,
    policy: AcrossExecutionPolicy,
    destination_policy: EvidencePolicy,
    keys: SubmissionKeys,
    monitor: Arc<BridgeMonitor>,
}
impl AcrossService {
    pub fn from_file(
        work: WorkStore,
        path: &str,
        redis: crate::redis_store::RedisStore,
        metrics: Arc<crate::metrics::Metrics>,
    ) -> Result<Self, AppError> {
        let c: FileConfig = load_file(path)?;
        if c.mode != "local_fork"
            || c.source_policy.chain != 31337
            || c.destination_policy.chain != 31338
            || c.registry_revision.is_empty()
            || c.registry_revision.len() > 64
            || c.decimals > 36
        {
            return Err(invalid());
        }
        let quotes = Arc::new(
            AcrossQuotes::from_local_file(
                &c.quote_config_file,
                &c.quote_fixture_origin,
                redis.clone(),
                metrics.clone(),
            )
            .map_err(|_| invalid())?,
        );
        if quotes.configuration().source_chain_id != "31337"
            || quotes.configuration().registry_revision != c.registry_revision
            || quotes.configuration().routes.len() != 1
            || quotes.configuration().routes[0].destination_chain_id != "31338"
            || quotes.configuration().routes[0].input_token.address
                != format!("{:#x}", c.source_policy.token.address)
            || quotes.configuration().routes[0].output_token.address
                != format!("{:#x}", c.destination_policy.token.address)
            || quotes.configuration().routes[0].source_spoke
                != format!("{:#x}", c.source_policy.spoke.address)
            || quotes.configuration().routes[0].input_token.decimals != c.decimals
            || quotes.configuration().routes[0].output_token.decimals != c.decimals
            || c.source_policy.chain != 31337
            || c.destination_policy.chain != 31338
        {
            return Err(invalid());
        }
        let mut keys = BTreeMap::new();
        for (id, value) in c.data_keys {
            let mut key = Zeroizing::new([0; 32]);
            hex::decode_to_slice(value.as_str(), key.as_mut()).map_err(|_| invalid())?;
            keys.insert(id, key);
        }
        let rpc = EvmReadRpc::with_budget(
            &c.rpc_url,
            RpcBudget::new(redis.clone(), c.rpc_budget).map_err(|_| invalid())?,
            metrics.clone(),
        )
        .map_err(|_| invalid())?;
        let destination_rpc = EvmReadRpc::with_budget(
            &c.destination_rpc_url,
            RpcBudget::new(redis.clone(), c.destination_rpc_budget).map_err(|_| invalid())?,
            metrics.clone(),
        )
        .map_err(|_| invalid())?;
        if !rpc.is_loopback() || !destination_rpc.is_loopback() {
            return Err(invalid());
        }
        let monitor = Arc::new(BridgeMonitor::with_client(
            work.clone(),
            AcrossQuotes::local_status(
                &c.quote_config_file,
                &c.status_fixture_origin,
                redis.clone(),
                metrics,
            )
            .map_err(|_| invalid())?,
        ));
        Ok(Self {
            work,
            redis,
            quotes,
            rpc,
            destination_rpc,
            policy: AcrossExecutionPolicy {
                source: c.source_policy,
                registry_revision: c.registry_revision,
                decimals: c.decimals,
                allow_empty_approval_return: c.allow_empty_approval_return,
                maximum_gas_per_transaction: c.maximum_gas_per_transaction,
            },
            destination_policy: c.destination_policy,
            keys: SubmissionKeys::new(c.active_key_id, keys)?,
            monitor,
        })
    }
    pub fn monitor(&self) -> Arc<BridgeMonitor> {
        self.monitor.clone()
    }
    pub fn configuration(&self) -> AcrossExecutionConfiguration {
        AcrossExecutionConfiguration {
            mode: "local_fork",
            quote: self.quotes.configuration().clone(),
            fee_policy_revision: FEE_POLICY_REVISION,
        }
    }
    fn cache_key(&self, wallet: Uuid, id: &str) -> String {
        self.redis.key("across-quote", &format!("{wallet}:{id}"))
    }
    pub async fn quote(
        &self,
        p: &Profile,
        r: &AcrossQuoteRequest,
    ) -> Result<AcrossQuote, AppError> {
        if p.wallet.chain_id != "eip155:31337" {
            return Err(invalid());
        }
        let artifact = self
            .quotes
            .quote(&p.wallet.address, r)
            .await
            .map_err(|error| {
                tracing::warn!(
                    provider = "across",
                    error = error.code(),
                    "Across quote failed"
                );
                AppError::Busy
            })?;
        let cache = CachedQuote {
            wallet_id: p.wallet.id,
            sender: p.wallet.address.to_ascii_lowercase(),
            request: r.clone(),
            raw: artifact.raw_quote().clone(),
            received_at_ms: artifact.quote().received_at_ms,
        };
        let encoded = serde_json::to_string(&cache).map_err(|_| AppError::Busy)?;
        let saved: Option<String> = self
            .redis
            .query(
                redis::cmd("SET")
                    .arg(self.cache_key(p.wallet.id, &artifact.quote().quote_id))
                    .arg(encoded)
                    .arg("EX")
                    .arg(30)
                    .arg("NX"),
            )
            .await?;
        if saved.as_deref() != Some("OK") {
            return Err(AppError::Busy);
        }
        Ok(artifact.quote().clone())
    }
    fn request(&self, r: &CreateAcross, signer: &str) -> Result<AcrossQuoteRequest, AppError> {
        let route = self
            .quotes
            .configuration()
            .routes
            .iter()
            .find(|x| x.id == r.route_id)
            .ok_or_else(invalid)?;
        let deadline = decimal(&r.deadline)?;
        let now = U256::from(unix());
        if deadline <= now
            || deadline > now + U256::from(900)
            || decimal(&r.maximum_network_fee_raw)? == U256::ZERO
        {
            return Err(invalid());
        }
        let q = AcrossQuoteRequest {
            route_id: r.route_id.clone(),
            amount_raw: r.amount_raw.clone(),
            minimum_output_raw: r.minimum_output_raw.clone(),
            recipient: r.recipient.clone(),
        };
        let recipient: Address = q.recipient.parse().map_err(|_| invalid())?;
        if recipient == Address::ZERO || signer.parse::<Address>().is_err() {
            return Err(invalid());
        }
        let input = decimal(&q.amount_raw)?;
        let floor = decimal(&q.minimum_output_raw)?;
        if input < decimal(&route.minimum_input_raw)?
            || input > decimal(&route.maximum_input_raw)?
            || floor > input
        {
            return Err(invalid());
        }
        Ok(q)
    }
    fn intent_hash(&self, wallet: Uuid, i: &Intent) -> Result<String, AppError> {
        Ok(hex::encode(digest(
            &serde_json::to_vec(&(
                1,
                wallet,
                Action::Bridge,
                serde_json::to_value(i).map_err(|_| AppError::Busy)?,
            ))
            .map_err(|_| AppError::Busy)?,
        )))
    }
    pub async fn create(
        &self,
        p: &Profile,
        key: &str,
        r: CreateAcross,
    ) -> Result<OperationRecovery, AppError> {
        if p.wallet.chain_id != "eip155:31337" {
            return Err(invalid());
        }
        // Idempotent replay must survive the short quote-cache TTL, but only if
        // the caller repeats the exact immutable request under the same key.
        let prior=sqlx::query("SELECT o.id,i.canonical_json FROM operations o JOIN operation_intents i ON i.operation_id=o.id WHERE o.user_id=$1 AND o.wallet_id=$2 AND o.action='bridge' AND o.idempotency_key=$3")
            .bind(p.user_id).bind(p.wallet.id).bind(key).fetch_optional(&self.work.pool).await.map_err(unavailable)?;
        if let Some(row) = prior {
            let id: Uuid = row.try_get("id").map_err(unavailable)?;
            let raw: String = row.try_get("canonical_json").map_err(unavailable)?;
            let saved: Intent = serde_json::from_str(&raw).map_err(|_| AppError::Busy)?;
            if saved.request != r {
                return Err(conflict());
            }
            return self.work.recover(p.user_id, p.wallet.id, id).await;
        }
        let request = self.request(&r, &p.wallet.address)?;
        let encoded: Option<String> = self
            .redis
            .query(redis::cmd("GET").arg(self.cache_key(p.wallet.id, &r.quote_id)))
            .await?;
        let encoded = encoded.ok_or_else(|| {
            AppError::Conflict("bridge quote expired; request a fresh quote".into())
        })?;
        let cached: CachedQuote = serde_json::from_str(&encoded).map_err(|_| AppError::Busy)?;
        if cached.wallet_id != p.wallet.id
            || cached.sender != p.wallet.address.to_ascii_lowercase()
            || cached.request.route_id != request.route_id
            || cached.request.amount_raw != request.amount_raw
            || cached.request.minimum_output_raw != request.minimum_output_raw
            || !cached
                .request
                .recipient
                .eq_ignore_ascii_case(&request.recipient)
        {
            return Err(conflict());
        }
        let artifact = self
            .quotes
            .restore_quote(
                &p.wallet.address,
                &request,
                &cached.raw,
                cached.received_at_ms,
            )
            .map_err(|_| conflict())?;
        if artifact.quote().quote_id != r.quote_id
            || artifact.quote().registry_revision != self.policy.registry_revision
            || !artifact
                .terms()
                .depositor
                .to_string()
                .eq_ignore_ascii_case(&p.wallet.address)
        {
            return Err(conflict());
        }
        let i = Intent {
            service: SERVICE.into(),
            chain_id: "31337".into(),
            registry_revision: self.policy.registry_revision.clone(),
            fee_policy_revision: FEE_POLICY_REVISION.into(),
            request: r.clone(),
            terms: artifact.terms().clone(),
            source_spoke: self.quotes.configuration().routes[0].source_spoke.clone(),
            calldata: artifact.calldata().into(),
            quoted_at_ms: artifact.quote().received_at_ms,
            quote_expires_at_ms: artifact.quote().expires_at_ms,
            provider_expires_at_ms: artifact.quote().provider_expires_at_ms,
        };
        // Same-key retries after quote-cache eviction are recovered from the original
        // immutable operation below; a new operation requires current quote evidence.
        let value = serde_json::to_value(&i).map_err(|_| invalid())?;
        stored_bridge_terms(&value)?;
        let op = self
            .work
            .create(NewOperation {
                user_id: p.user_id,
                wallet_id: p.wallet.id,
                action: Action::Bridge,
                idempotency_key: key,
                intent: &value,
            })
            .await?;
        self.work.recover(p.user_id, p.wallet.id, op.id).await
    }
    async fn saved(
        &self,
        user: Uuid,
        wallet: Uuid,
        id: Uuid,
    ) -> Result<(Intent, String, String), AppError> {
        let row=sqlx::query("SELECT i.canonical_json,o.intent_hash,w.address,w.chain_id FROM operation_intents i JOIN operations o ON o.id=i.operation_id JOIN wallet_memberships w ON w.id=o.wallet_id AND w.user_id=o.user_id WHERE o.id=$1 AND o.user_id=$2 AND o.wallet_id=$3 AND o.action='bridge'").bind(id).bind(user).bind(wallet).fetch_optional(&self.work.pool).await.map_err(unavailable)?.ok_or(AppError::NotFound)?;
        let raw: String = row.try_get("canonical_json").map_err(unavailable)?;
        let i: Intent = serde_json::from_str(&raw).map_err(|_| AppError::NotFound)?;
        if i.service != SERVICE
            || i.chain_id != "31337"
            || row.try_get::<i64, _>("chain_id").map_err(unavailable)? != 31337
        {
            return Err(AppError::NotFound);
        }
        let expected = self.intent_hash(wallet, &i)?;
        if row
            .try_get::<Vec<u8>, _>("intent_hash")
            .map_err(unavailable)?
            != hex::decode(&expected).map_err(|_| AppError::Busy)?
        {
            return Err(AppError::Busy);
        }
        let signer = format!(
            "0x{}",
            hex::encode(row.try_get::<Vec<u8>, _>("address").map_err(unavailable)?)
        );
        Ok((i, expected, signer))
    }
    pub async fn recover_intent(
        &self,
        p: &Profile,
        id: Uuid,
    ) -> Result<AcrossIntentRecovery, AppError> {
        let (i, _, signer) = self.saved(p.user_id, p.wallet.id, id).await?;
        Ok(AcrossIntentRecovery {
            operation_id: id,
            signer,
            chain_id: i.chain_id,
            registry_revision: i.registry_revision,
            intent: i.request,
        })
    }
    fn bind(
        &self,
        i: &Intent,
        hash: &str,
        signer: &str,
        r: &AcrossPreparationReview,
    ) -> Result<(), AppError> {
        let deadline = i
            .request
            .deadline
            .parse::<i64>()
            .map_err(|_| invalid())?
            .saturating_mul(1000);
        if r.intent_hash != hash
            || r.terms != i.terms
            || r.calldata != i.calldata
            || r.source_spoke != i.source_spoke
            || r.quote_id != i.request.quote_id
            || r.registry_revision != i.registry_revision
            || r.maximum_network_fee_raw != i.request.maximum_network_fee_raw
            || r.quoted_at_ms != i.quoted_at_ms
            || r.quote_expires_at_ms != i.quote_expires_at_ms
            || r.provider_expires_at_ms != i.provider_expires_at_ms
            || r.execution_deadline_ms != deadline
            || r.terms.depositor.to_string().to_ascii_lowercase() != signer
        {
            return Err(conflict());
        }
        r.validate().map_err(|_| conflict())?;
        Ok(())
    }
    fn bind_request(
        &self,
        i: &Intent,
        hash: &str,
        signer: &str,
        r: &AcrossPreparationRequest,
    ) -> Result<(), AppError> {
        let deadline = i
            .request
            .deadline
            .parse::<i64>()
            .map_err(|_| invalid())?
            .saturating_mul(1000);
        if r.intent_hash != hash
            || r.terms != i.terms
            || r.calldata != i.calldata
            || r.source_spoke != i.source_spoke
            || r.quote_id != i.request.quote_id
            || r.registry_revision != i.registry_revision
            || r.maximum_network_fee_raw != i.request.maximum_network_fee_raw
            || r.quoted_at_ms != i.quoted_at_ms
            || r.quote_expires_at_ms != i.quote_expires_at_ms
            || r.provider_expires_at_ms != i.provider_expires_at_ms
            || r.execution_deadline_ms != deadline
            || r.terms.depositor.to_string().to_ascii_lowercase() != signer
        {
            return Err(conflict());
        }
        r.validate().map_err(|_| conflict())
    }
    pub async fn signing_request(
        &self,
        p: &Profile,
        id: Uuid,
    ) -> Result<AcrossSigningRequest, AppError> {
        let (i, hash, signer) = self.saved(p.user_id, p.wallet.id, id).await?;
        let prep = self
            .work
            .load_preparation(p.user_id, p.wallet.id, id)
            .await?;
        if prep.provider != PreparationProvider::Across {
            return Err(AppError::NotFound);
        }
        let json: String = sqlx::query_scalar(
            "SELECT canonical_json FROM evm_signing_requests WHERE operation_id=$1",
        )
        .bind(id)
        .fetch_optional(&self.work.pool)
        .await
        .map_err(unavailable)?
        .ok_or(AppError::NotFound)?;
        let stored: PreparedEvm = serde_json::from_str(&json).map_err(|_| AppError::Busy)?;
        stored
            .validate_signing_terms()
            .map_err(|_| AppError::Busy)?;
        if stored.plan.integrity_hash()? != prep.integrity_hash()? {
            return Err(AppError::Busy);
        }
        let review = AcrossPreparationReview {
            terms: i.terms.clone(),
            source_spoke: i.source_spoke.clone(),
            calldata: i.calldata.clone(),
            quote_id: i.request.quote_id.clone(),
            registry_revision: i.registry_revision.clone(),
            intent_hash: hash,
            quoted_at_ms: i.quoted_at_ms,
            quote_expires_at_ms: i.quote_expires_at_ms,
            provider_expires_at_ms: i.provider_expires_at_ms,
            execution_deadline_ms: i
                .request
                .deadline
                .parse::<i64>()
                .map_err(|_| invalid())?
                .saturating_mul(1000),
            prepared_at_ms: stored.plan.simulation.observed_at_ms,
            expires_at_ms: stored.plan.expires_at_ms,
            maximum_network_fee_raw: i.request.maximum_network_fee_raw.clone(),
        };
        review.validate().map_err(|_| AppError::Busy)?;
        self.bind(&i, &review.intent_hash, &signer, &review)?;
        let operation = self.work.get(p.user_id, p.wallet.id, id).await?;
        Ok(AcrossSigningRequest {
            operation_id: id,
            operation_version: operation.version,
            plan_hash: prep.integrity_hash()?,
            review,
            prepared: stored,
        })
    }
    pub async fn submit(
        &self,
        p: &Profile,
        id: Uuid,
        input: SubmitAcross,
    ) -> Result<OperationRecovery, AppError> {
        let signing = self.signing_request(p, id).await?;
        if input.plan_hash != signing.plan_hash {
            return Err(conflict());
        }
        let bundle = verify_signed_bundle(
            &signing.prepared.plan,
            EvmEnvelopePolicy {
                first_nonce: signing
                    .prepared
                    .first_nonce
                    .parse()
                    .map_err(|_| invalid())?,
                maximum_gas_per_transaction: self.policy.maximum_gas_per_transaction,
            },
            &input.signed_transactions,
            // Verify historical bytes for idempotent recovery after expiry.
            // New submissions still require current-time checks below and in stage_signed.
            signing.prepared.plan.simulation.observed_at_ms,
        )
        .map_err(|_| invalid())?;
        signing.prepared.validate_bundle_terms(&bundle)?;
        let existing = self.work.recover(p.user_id, p.wallet.id, id).await?;
        if let Some(old) = &existing.submission {
            if old.transaction_hashes
                == bundle
                    .transactions()
                    .iter()
                    .map(|t| format!("{:#x}", t.hash()))
                    .collect::<Vec<_>>()
            {
                return Ok(existing);
            }
            return Err(conflict());
        }
        let version = signing.operation_version.parse().map_err(|_| invalid())?;
        if input.expected_version != signing.operation_version
            || signing.prepared.plan.expires_at_ms <= now()
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
                    expected_version: version,
                    bundle: &bundle,
                    nonce: self.nonce(&signing.prepared.plan.signer).await?,
                },
            )
            .await?;
        self.work.recover(p.user_id, p.wallet.id, id).await
    }
    async fn nonce(&self, signer: &str) -> Result<NonceObservation, AppError> {
        let a = self
            .rpc
            .nonce(signer, "latest")
            .await
            .map_err(|_| AppError::Busy)?;
        let b = self
            .rpc
            .nonce(signer, "pending")
            .await
            .map_err(|_| AppError::Busy)?;
        if a != b {
            return Err(conflict());
        }
        let value = a
            .as_str()
            .and_then(|s| s.strip_prefix("0x"))
            .ok_or(AppError::Busy)?;
        Ok(NonceObservation {
            nonce: u64::from_str_radix(value, 16).map_err(|_| AppError::Busy)?,
            observed_at_ms: now(),
        })
    }
    pub async fn start(
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
                        error_code = "across_worker_retry",
                        "Across worker could not complete work"
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
        let Some(lease) = self.claim().await? else {
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
    async fn claim(&self) -> Result<Option<JobLease>, AppError> {
        let token = Uuid::new_v4();
        let row=sqlx::query("WITH candidate AS (SELECT j.id FROM jobs j JOIN operations o ON o.id=j.operation_id AND o.version=j.operation_version JOIN operation_intents i ON i.operation_id=o.id WHERE i.canonical_json::jsonb->>'service'=$1 AND o.state IN ('created','signed','unknown','confirming','bridging') AND ((j.state='ready' AND j.available_at<=clock_timestamp()) OR (j.state='leased' AND j.lease_until<=clock_timestamp())) ORDER BY j.available_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED) UPDATE jobs SET state='leased',lease_token=$2,lease_until=clock_timestamp()+interval '240 seconds',attempts=1 WHERE id IN (SELECT id FROM candidate) RETURNING id,operation_id,operation_version").bind(SERVICE).bind(token).fetch_optional(&self.work.pool).await.map_err(unavailable)?;
        row.map(|r| {
            Ok(JobLease {
                id: r.try_get("id").map_err(unavailable)?,
                operation_id: r.try_get("operation_id").map_err(unavailable)?,
                operation_version: r.try_get("operation_version").map_err(unavailable)?,
                token,
                attempts: 1,
            })
        })
        .transpose()
    }
    async fn defer(&self, l: &JobLease) -> Result<(), AppError> {
        sqlx::query("UPDATE jobs SET state='ready',lease_token=NULL,lease_until=NULL,attempts=0,available_at=clock_timestamp()+interval '10 seconds',last_error_code='upstream_unavailable' WHERE id=$1 AND lease_token=$2 AND state='leased' AND lease_until>clock_timestamp()").bind(l.id).bind(l.token).execute(&self.work.pool).await.map_err(unavailable)?;
        Ok(())
    }
    async fn process(
        &self,
        l: &JobLease,
        health: Option<&crate::runtime::RuntimeHealth>,
    ) -> Result<(), AppError> {
        let(row_user,row_wallet,raw,signer):(Uuid,Uuid,String,Vec<u8>)=sqlx::query_as("SELECT o.user_id,o.wallet_id,i.canonical_json,w.address FROM operations o JOIN operation_intents i ON i.operation_id=o.id JOIN wallet_memberships w ON w.id=o.wallet_id WHERE o.id=$1").bind(l.operation_id).fetch_one(&self.work.pool).await.map_err(unavailable)?;
        let i: Intent = serde_json::from_str(&raw).map_err(|_| AppError::Busy)?;
        let recovery = self
            .work
            .recover(row_user, row_wallet, l.operation_id)
            .await?;
        let signer = Address::from_slice(&signer);
        if i.service != SERVICE
            || i.registry_revision != self.policy.registry_revision
            || i.fee_policy_revision != FEE_POLICY_REVISION
            || i.terms.depositor != signer
        {
            return Err(conflict());
        }
        let hash = self.intent_hash(row_wallet, &i)?;
        if recovery.operation.state == OperationState::Created {
            let request = AcrossPreparationRequest {
                terms: i.terms.clone(),
                source_spoke: i.source_spoke.clone(),
                calldata: i.calldata.clone(),
                quote_id: i.request.quote_id.clone(),
                registry_revision: i.registry_revision.clone(),
                intent_hash: hash,
                quoted_at_ms: i.quoted_at_ms,
                quote_expires_at_ms: i.quote_expires_at_ms,
                provider_expires_at_ms: i.provider_expires_at_ms,
                execution_deadline_ms: i
                    .request
                    .deadline
                    .parse::<i64>()
                    .map_err(|_| invalid())?
                    .saturating_mul(1000),
                maximum_network_fee_raw: i.request.maximum_network_fee_raw.clone(),
            };
            self.bind_request(
                &i,
                &request.intent_hash,
                &format!("{:#x}", signer),
                &request,
            )?;
            match across_execution::prepare(&self.rpc, &self.policy, &request).await {
                Ok(p) => self.work.persist_evm_preparation(l, &p).await,
                Err(EvmPreparationError::Rpc(_) | EvmPreparationError::Timeout) => {
                    Err(AppError::Busy)
                }
                Err(_) => {
                    self.work
                        .transition(
                            l.operation_id,
                            l.operation_version,
                            OperationState::Failed,
                            l,
                        )
                        .await?;
                    Ok(())
                }
            }
        } else if matches!(
            recovery.operation.state,
            OperationState::Signed | OperationState::Unknown | OperationState::Confirming
        ) {
            self.reconcile_source(l, row_user, row_wallet, health).await
        } else if recovery.operation.state == OperationState::Bridging {
            self.reconcile_delivery(l, row_user, row_wallet, health)
                .await
        } else {
            Ok(())
        }
    }
    async fn reconcile_source(
        &self,
        l: &JobLease,
        user: Uuid,
        wallet: Uuid,
        health: Option<&crate::runtime::RuntimeHealth>,
    ) -> Result<(), AppError> {
        let recovery = self.work.recover(user, wallet, l.operation_id).await?;
        let prepared = self
            .work
            .load_preparation(user, wallet, l.operation_id)
            .await?;
        let raw: String = sqlx::query_scalar(
            "SELECT canonical_json FROM evm_signing_requests WHERE operation_id=$1",
        )
        .bind(l.operation_id)
        .fetch_one(&self.work.pool)
        .await
        .map_err(unavailable)?;
        let p: PreparedEvm = serde_json::from_str(&raw).map_err(|_| AppError::Busy)?;
        let attempted:Vec<i16>=sqlx::query_scalar("SELECT t.step FROM evm_signed_transactions t JOIN evm_dispatch_attempts d ON d.transaction_id=t.id WHERE t.operation_id=$1 ORDER BY t.step").bind(l.operation_id).fetch_all(&self.work.pool).await.map_err(unavailable)?;
        let next = (0..p.plan.steps.len()).find(|i| !attempted.contains(&(*i as i16)));
        let ctx = self
            .work
            .reconciliation_context(&self.keys, l.operation_id)
            .await?;
        let report = crate::reconciliation::collect(&self.rpc, &ctx)
            .await
            .map_err(|_| AppError::Busy)?;
        self.work.record_reconciliation(l, &report).await?;
        if matches!(
            recovery.operation.state,
            OperationState::Signed | OperationState::Confirming | OperationState::Unknown
        ) && p.plan.expires_at_ms > now()
            && let Some(step) = next
            && let Some(current) = self.claim_same(l.operation_id).await?
        {
            self.dispatch(&current, &p, step, health).await?;
        }
        let _ = prepared;
        Ok(())
    }

    /// Re-simulate the exact immutable Across intent before each transaction is
    /// released to the RPC. The signed envelope is never replaced: if its next
    /// call, nonce, or fee/gas ceiling no longer covers the fresh simulation we
    /// stop and leave recovery to the user.
    async fn preflight_dispatch(
        &self,
        operation: Uuid,
        signed: &PreparedEvm,
        step: usize,
    ) -> Result<(), AppError> {
        let row = sqlx::query(
            "SELECT o.wallet_id,i.canonical_json FROM operations o JOIN operation_intents i ON i.operation_id=o.id WHERE o.id=$1",
        )
        .bind(operation)
        .fetch_optional(&self.work.pool)
        .await
        .map_err(unavailable)?
        .ok_or(AppError::NotFound)?;
        let wallet: Uuid = row.try_get("wallet_id").map_err(unavailable)?;
        let raw: String = row.try_get("canonical_json").map_err(unavailable)?;
        let intent: Intent = serde_json::from_str(&raw).map_err(|_| AppError::Busy)?;
        let hash = self.intent_hash(wallet, &intent)?;
        let request = AcrossPreparationRequest {
            terms: intent.terms.clone(),
            source_spoke: intent.source_spoke.clone(),
            calldata: intent.calldata.clone(),
            quote_id: intent.request.quote_id.clone(),
            registry_revision: intent.registry_revision.clone(),
            intent_hash: hash.clone(),
            quoted_at_ms: intent.quoted_at_ms,
            quote_expires_at_ms: intent.quote_expires_at_ms,
            provider_expires_at_ms: intent.provider_expires_at_ms,
            execution_deadline_ms: intent
                .request
                .deadline
                .parse::<i64>()
                .map_err(|_| invalid())?
                .saturating_mul(1000),
            maximum_network_fee_raw: intent.request.maximum_network_fee_raw.clone(),
        };
        let signer = format!(
            "{:#x}",
            signed
                .plan
                .signer
                .parse::<Address>()
                .map_err(|_| conflict())?
        );
        self.bind_request(&intent, &hash, &signer, &request)?;
        signed.validate_signing_terms().map_err(|_| conflict())?;
        if step >= signed.plan.steps.len() || signed.plan.expires_at_ms <= now() {
            return Err(conflict());
        }

        let fresh = across_execution::revalidate(
            &self.rpc,
            &self.policy,
            &request,
            signed.plan.expires_at_ms,
        )
        .await
        .map_err(|_| conflict())?;
        if !dispatch_simulation_fits(signed, &fresh, step) {
            return Err(conflict());
        }
        Ok(())
    }

    async fn reconcile_delivery(
        &self,
        l: &JobLease,
        user: Uuid,
        wallet: Uuid,
        health: Option<&crate::runtime::RuntimeHealth>,
    ) -> Result<(), AppError> {
        if health.is_some_and(|h| h.is_draining()) {
            return Err(AppError::Busy);
        }
        let i: Intent = serde_json::from_str(
            &sqlx::query_scalar::<_, String>(
                "SELECT canonical_json FROM operation_intents WHERE operation_id=$1",
            )
            .bind(l.operation_id)
            .fetch_one(&self.work.pool)
            .await
            .map_err(unavailable)?,
        )
        .map_err(|_| AppError::Busy)?;
        let hashes: Vec<Vec<u8>> = sqlx::query_scalar(
            "SELECT tx_hash FROM evm_signed_transactions WHERE operation_id=$1 ORDER BY step",
        )
        .bind(l.operation_id)
        .fetch_all(&self.work.pool)
        .await
        .map_err(unavailable)?;
        let hash = B256::from_slice(hashes.last().ok_or_else(conflict)?);
        let deposit =
            across_evidence::verify_deposit(&self.rpc, &self.policy.source, &i.terms, hash)
                .await
                .map_err(|_| AppError::Busy)?;
        self.monitor.attach_across(l.operation_id, &deposit).await?;
        self.monitor.tick().await?;
        let result = self.monitor.recover(user, wallet, l.operation_id).await?;
        let Some(candidate) = result.observation.and_then(|o| {
            o.candidates.into_iter().find(|c| {
                c.role == CandidateRole::DestinationFill
                    && c.chain_id == i.terms.destination_chain.to_string()
            })
        }) else {
            return Err(AppError::Busy);
        };
        let tx: B256 = candidate.transaction_hash.parse().map_err(|_| conflict())?;
        let proof = across_evidence::verify_delivery(
            &self.rpc,
            &self.policy.source,
            &self.destination_rpc,
            &self.destination_policy,
            &i.terms,
            hash,
            tx,
        )
        .await
        .map_err(|_| AppError::Busy)?;
        self.work.complete_across_delivery(l, &proof).await
    }
    async fn claim_same(&self, id: Uuid) -> Result<Option<JobLease>, AppError> {
        let token = Uuid::new_v4();
        let row=sqlx::query("WITH candidate AS (SELECT j.id FROM jobs j JOIN operations o ON o.id=j.operation_id AND o.version=j.operation_version WHERE o.id=$1 AND j.state='ready' AND j.available_at<=clock_timestamp() ORDER BY j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED) UPDATE jobs SET state='leased',lease_token=$2,lease_until=clock_timestamp()+interval '240 seconds',attempts=1 WHERE id IN (SELECT id FROM candidate) RETURNING id,operation_id,operation_version").bind(id).bind(token).fetch_optional(&self.work.pool).await.map_err(unavailable)?;
        row.map(|r| {
            Ok(JobLease {
                id: r.try_get("id").map_err(unavailable)?,
                operation_id: r.try_get("operation_id").map_err(unavailable)?,
                operation_version: r.try_get("operation_version").map_err(unavailable)?,
                token,
                attempts: 1,
            })
        })
        .transpose()
    }
    async fn dispatch(
        &self,
        l: &JobLease,
        p: &PreparedEvm,
        step: usize,
        health: Option<&crate::runtime::RuntimeHealth>,
    ) -> Result<(), AppError> {
        self.preflight_dispatch(l.operation_id, p, step).await?;
        let nonce = self.nonce(&p.plan.signer).await?;
        let expected_nonce = p
            .first_nonce
            .parse::<u64>()
            .map_err(|_| conflict())?
            .checked_add(step as u64)
            .ok_or_else(conflict)?;
        if nonce.nonce != expected_nonce {
            return Err(conflict());
        }
        let permit = self
            .rpc
            .reserve_local_broadcast()
            .await
            .map_err(|_| AppError::Busy)?;
        if health.is_some_and(|h| h.is_draining()) {
            return Err(conflict());
        }
        let attempt = self
            .work
            .begin_dispatch_step(&self.keys, l, nonce, step as u8)
            .await?;
        // Draining may begin while the dispatch journal waits on a database lock.
        // Keep the durable unknown outcome, but do not start a new broadcast.
        let outcome =
            if !health.is_some_and(|h| h.is_draining()) && permit.send(&attempt).await.is_ok() {
                DispatchObservation::Acknowledged
            } else {
                DispatchObservation::Unknown
            };
        self.work.observe_dispatch(&attempt, outcome).await
    }
}

#[cfg(test)]
pub(crate) fn test_service_intent(terms: &DirectDepositTerms) -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/across-direct-evidence.json"
    ))
    .unwrap();
    let mut calldata = fixture["calldata"].as_str().unwrap().to_owned();
    calldata.replace_range(
        10 + 6 * 64..10 + 7 * 64,
        &format!("{:064x}", terms.destination_chain),
    );
    calldata.push_str("1dc0deabcd73c0de");
    let intent = Intent {
        service: SERVICE.into(),
        chain_id: "31337".into(),
        registry_revision: "historical-v1".into(),
        fee_policy_revision: FEE_POLICY_REVISION.into(),
        request: CreateAcross {
            route_id: "usdc-local".into(),
            quote_id: "quote-1".into(),
            amount_raw: "1000000".into(),
            minimum_output_raw: "980000".into(),
            recipient: format!("{:#x}", terms.recipient),
            deadline: "1700000900".into(),
            maximum_network_fee_raw: "100000000000000000".into(),
        },
        terms: terms.clone(),
        source_spoke: "0x0000000000000000000000000000000000000005".into(),
        calldata,
        quoted_at_ms: 1700000000000,
        quote_expires_at_ms: 1700000030000,
        provider_expires_at_ms: None,
    };
    serde_json::to_value(intent).unwrap()
}

#[cfg(test)]
mod dispatch_preflight_tests {
    use super::*;
    use crate::preparation::{
        AssetAmount, CallPurpose, EvmCall, EvmPreparation, PreparationProvider, SimulationRecord,
    };

    #[test]
    fn immutable_service_intent_binds_terms_route_revisions_and_calldata() {
        use crate::{bridge_monitor::BridgeBinding, providers::bridge_status::BridgeProvider};
        use serde_json::json;
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/across-direct-evidence.json"
        ))
        .unwrap();
        let mut terms: DirectDepositTerms =
            serde_json::from_value(fixture["terms"].clone()).unwrap();
        terms.source_chain = 31337;
        terms.destination_chain = 31338;
        terms.swap_api_integrator_id = Some("0xabcd".into());
        let value = test_service_intent(&terms);
        let canonical = serde_json::to_string(&value).unwrap();
        let binding = BridgeBinding {
            provider: BridgeProvider::Across,
            provider_reference: "1".into(),
            source_chain_id: "31337".into(),
            destination_chain_id: "31338".into(),
            refund_chain_id: "31337".into(),
            source_transaction_hash: format!("0x{}", "11".repeat(32)),
        };
        // Expired consent remains readable; the signed source and fresh verified
        // evidence, not quote freshness, govern settlement.
        assert_eq!(binding.across_intent_terms(&value).unwrap(), terms);
        assert_eq!(serde_json::to_string(&value).unwrap(), canonical);
        for (pointer, replacement) in [
            ("/service", json!("unknown")),
            ("/chainId", json!("1")),
            ("/registryRevision", json!("")),
            ("/feePolicyRevision", json!("changed")),
            ("/request/amountRaw", json!("999999")),
            ("/request/minimumOutputRaw", json!("990001")),
            (
                "/request/recipient",
                json!("0x0000000000000000000000000000000000000007"),
            ),
            ("/terms/destinationChain", json!("1")),
            ("/calldata", json!("0x")),
            ("/quoteExpiresAtMs", json!("1700000030001")),
        ] {
            let mut changed = value.clone();
            *changed.pointer_mut(pointer).unwrap() = replacement;
            assert!(binding.across_intent_terms(&changed).is_err(), "{pointer}");
        }
        let mut mixed = value.clone();
        mixed["bridgeTracking"] = binding.intent_terms().unwrap();
        mixed["acrossDirectDeposit"] = serde_json::to_value(&terms).unwrap();
        assert!(binding.across_intent_terms(&mixed).is_err());
        for field in ["sourceChainId", "destinationChainId", "refundChainId"] {
            let mut changed = serde_json::to_value(&binding).unwrap();
            changed[field] = json!("10");
            let changed: BridgeBinding = serde_json::from_value(changed).unwrap();
            assert!(changed.across_intent_terms(&value).is_err(), "{field}");
        }
    }

    fn prepared(nonce: &str, to: &str, gas: &str, max_fee: &str) -> PreparedEvm {
        PreparedEvm {
            plan: EvmPreparation {
                schema_version: 1,
                provider: PreparationProvider::Across,
                chain_id: "31337".into(),
                signer: "0x0000000000000000000000000000000000000001".into(),
                intent_hash: "a".repeat(64),
                registry_revision: "local-v1".into(),
                fee_policy_revision: FEE_POLICY_REVISION.into(),
                quote_reference: Some("quote-1".into()),
                expires_at_ms: 10_000,
                maximum_network_fee_raw: "500000".into(),
                maximum_spend: AssetAmount {
                    asset_address: Some("0x0000000000000000000000000000000000000002".into()),
                    amount_raw: "1".into(),
                    recipient: "0x0000000000000000000000000000000000000003".into(),
                },
                minimum_receive: None,
                fees: vec![],
                simulation: SimulationRecord {
                    block_number: "1".into(),
                    block_hash: format!("0x{}", "1".repeat(64)),
                    calls_hash: "b".repeat(64),
                    observed_at_ms: 1,
                },
                steps: vec![EvmCall {
                    purpose: CallPurpose::Action,
                    to: to.into(),
                    value_raw: "0".into(),
                    data: "0x1234".into(),
                }],
            },
            first_nonce: nonce.into(),
            gas_limits: vec![gas.into()],
            max_fee_per_gas: max_fee.into(),
            max_priority_fee_per_gas: "2".into(),
        }
    }

    #[test]
    fn dispatch_preflight_requires_exact_call_and_signed_nonce_fee_gas_bounds() {
        let signed = prepared(
            "5",
            "0x0000000000000000000000000000000000000004",
            "50000",
            "10",
        );
        assert!(dispatch_simulation_fits(&signed, &signed, 0));

        let changed_call = prepared(
            "5",
            "0x0000000000000000000000000000000000000005",
            "50000",
            "10",
        );
        assert!(!dispatch_simulation_fits(&signed, &changed_call, 0));
        let changed_nonce = prepared(
            "6",
            "0x0000000000000000000000000000000000000004",
            "50000",
            "10",
        );
        assert!(!dispatch_simulation_fits(&signed, &changed_nonce, 0));
        let higher_gas = prepared(
            "5",
            "0x0000000000000000000000000000000000000004",
            "50001",
            "10",
        );
        assert!(!dispatch_simulation_fits(&signed, &higher_gas, 0));
        let higher_fee = prepared(
            "5",
            "0x0000000000000000000000000000000000000004",
            "50000",
            "11",
        );
        assert!(!dispatch_simulation_fits(&signed, &higher_fee, 0));
    }
}
