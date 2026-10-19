//! Morpho's typed boundary over the common durable Earn worker. Local fork only.
use crate::{
    earn_service::{EarnAdapter, EarnIdentity, LocalEarnService, invalid, uint},
    error::AppError,
    preparation::PreparationProvider,
    providers::{
        evm_prepare::{EvmPreparationError, PreparedEvm},
        evm_rpc::EvmReadRpc,
        morpho_execution::{self, MorphoAction, MorphoExecutionPolicy, MorphoPrepareRequest},
        rpc_budget::{RpcBudget, RpcBudgetConfig},
    },
    submissions::SubmissionKeys,
    work::WorkStore,
};
use alloy_primitives::{Address, U256};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateMorpho {
    pub vault: String,
    pub action: MorphoAction,
    pub amount_raw: String,
    pub minimum_shares_raw: Option<String>,
    pub acknowledge_unprotected_output: bool,
    #[serde(with = "deadline_string")]
    pub deadline: u64,
    pub maximum_network_fee_raw: String,
}
// Immutable operation intents prohibit JSON numbers. Preserve exact seconds in
// canonical decimal strings, including at the HTTP boundary.
mod deadline_string {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = String::deserialize(deserializer)?;
        let parsed = value.parse::<u64>().map_err(D::Error::custom)?;
        if parsed.to_string() != value {
            return Err(D::Error::custom("noncanonical deadline"));
        }
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::CreateMorpho;
    use serde_json::json;

    #[test]
    fn deadline_is_a_canonical_string_in_the_immutable_intent() {
        let value = json!({"vault":"0x04422053addbc9bb2759b248b574e3fca76bc145",
            "action":"deposit","amountRaw":"1000000","minimumSharesRaw":"100",
            "acknowledgeUnprotectedOutput":false,"deadline":"1792323000",
            "maximumNetworkFeeRaw":"1000000"});
        let parsed: CreateMorpho = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        for deadline in [
            json!(1792323000),
            json!("01792323000"),
            json!("1e9"),
            json!("-1"),
        ] {
            let mut invalid = value.clone();
            invalid["deadline"] = deadline;
            assert!(serde_json::from_value::<CreateMorpho>(invalid).is_err());
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MorphoExecutionConfiguration {
    pub mode: &'static str,
    pub chain_id: String,
    pub vault: String,
    pub bundle: String,
    pub asset: String,
    pub asset_decimals: u8,
    pub share_decimals: u8,
    pub performance_fee_wad: String,
    pub management_fee_per_second_wad: String,
    pub registry_revision: String,
    pub fee_policy_revision: String,
    pub redemption_output_protection: &'static str,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileConfig {
    mode: String,
    rpc_url: String,
    rpc_budget: RpcBudgetConfig,
    registry: MorphoExecutionPolicy,
    active_key_id: String,
    #[serde(deserialize_with = "crate::earn_service::decode_keys")]
    data_keys: BTreeMap<String, Zeroizing<String>>,
}
pub struct MorphoAdapter {
    policy: MorphoExecutionPolicy,
    configuration: MorphoExecutionConfiguration,
}
pub type MorphoService = LocalEarnService<MorphoAdapter>;
pub type MorphoSigningRequest = crate::earn_service::EarnSigningRequest;
pub type MorphoIntentRecovery = crate::earn_service::EarnIntentRecovery<CreateMorpho>;
pub type SubmitMorpho = crate::earn_service::SubmitEarn;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuoteMorpho {
    pub action: MorphoAction,
    pub amount_raw: String,
}
impl MorphoService {
    pub async fn quote(
        &self,
        profile: &crate::identity::Profile,
        input: QuoteMorpho,
    ) -> Result<morpho_execution::MorphoQuote, AppError> {
        if profile.wallet.chain_id != "eip155:31337" {
            return Err(invalid());
        }
        morpho_execution::quote(
            &self.rpc,
            &self.adapter.policy,
            profile.wallet.address.parse().map_err(|_| invalid())?,
            input.action,
            uint(&input.amount_raw)?,
        )
        .await
        .map_err(|_| AppError::Busy)
    }
    pub fn from_file(
        work: WorkStore,
        path: &str,
        redis: crate::redis_store::RedisStore,
        metrics: Arc<crate::metrics::Metrics>,
    ) -> Result<Self, AppError> {
        let c: FileConfig = crate::earn_service::load_file(path)?;
        let url = reqwest::Url::parse(&c.rpc_url).map_err(|_| invalid())?;
        let p = c.registry;
        if c.mode != "local_fork"
            || p.chain_id != 31337
            || url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || p.asset_decimals > 18
            || p.share_decimals > 36
            || p.adapters.len() > 8
            || !(21000..=2_000_000).contains(&p.maximum_gas_per_transaction)
            || [&p.registry_revision, &p.zero_fee_policy_revision]
                .iter()
                .any(|s| {
                    s.is_empty()
                        || s.len() > 128
                        || !s
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
                })
            || [&p.vault, &p.bundle, &p.asset, &p.asset_implementation]
                .into_iter()
                .chain(p.adapters.iter())
                .any(|pin| {
                    pin.address == Address::ZERO
                        || pin.code_hash == alloy_primitives::B256::ZERO
                        || pin.code_hash == alloy_primitives::keccak256([])
                })
        {
            return Err(invalid());
        }
        let configuration = MorphoExecutionConfiguration {
            mode: "local_fork",
            chain_id: "31337".into(),
            vault: format!("{:#x}", p.vault.address),
            bundle: format!("{:#x}", p.bundle.address),
            asset: format!("{:#x}", p.asset.address),
            asset_decimals: p.asset_decimals,
            share_decimals: p.share_decimals,
            performance_fee_wad: p.performance_fee_wad.to_string(),
            management_fee_per_second_wad: p.management_fee_per_second_wad.to_string(),
            registry_revision: p.registry_revision.clone(),
            fee_policy_revision: p.zero_fee_policy_revision.clone(),
            redemption_output_protection: "none",
        };
        let mut keys = BTreeMap::new();
        for (id, value) in c.data_keys {
            let mut key = Zeroizing::new([0u8; 32]);
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
            adapter: MorphoAdapter {
                policy: p,
                configuration,
            },
        })
    }
}
impl EarnAdapter for MorphoAdapter {
    type Request = CreateMorpho;
    type Configuration = MorphoExecutionConfiguration;
    const SERVICE: &'static str = "morpho_v1";
    const PROVIDER: PreparationProvider = PreparationProvider::MorphoVaultV2;
    fn identity(&self) -> EarnIdentity {
        EarnIdentity {
            chain_id: self.configuration.chain_id.clone(),
            asset: self.configuration.asset.clone(),
            registry_revision: self.configuration.registry_revision.clone(),
            fee_policy_revision: self.configuration.fee_policy_revision.clone(),
        }
    }
    fn configuration(&self) -> MorphoExecutionConfiguration {
        self.configuration.clone()
    }
    fn validate(&self, r: &CreateMorpho) -> Result<(), AppError> {
        let amount = uint(&r.amount_raw)?;
        let minimum = r.minimum_shares_raw.as_deref().map(uint).transpose()?;
        if r.vault.parse::<Address>().is_err()
            || r.vault.len() != 42
            || r.vault != r.vault.to_lowercase()
            || r.vault == format!("{:#x}", Address::ZERO)
            || amount == U256::ZERO
            || amount == U256::MAX
            || self.network_budget(r)? == U256::ZERO
            || r.deadline == 0
            || r.deadline > 9_007_199_254_740
            || (r.action == MorphoAction::Deposit
                && (minimum.is_none_or(|v| v == U256::ZERO || v == U256::MAX)
                    || r.acknowledge_unprotected_output))
            || (r.action == MorphoAction::Redeem
                && (minimum.is_some() || !r.acknowledge_unprotected_output))
        {
            return Err(invalid());
        }
        Ok(())
    }
    fn validate_new(&self, r: &CreateMorpho) -> Result<(), AppError> {
        self.validate(r)?;
        let now = time::OffsetDateTime::now_utc().unix_timestamp() as u64;
        if r.vault != self.configuration.vault || r.deadline <= now || r.deadline > now + 900 {
            return Err(invalid());
        }
        Ok(())
    }
    fn network_budget(&self, r: &CreateMorpho) -> Result<U256, AppError> {
        uint(&r.maximum_network_fee_raw)
    }
    async fn prepare(
        &self,
        rpc: &EvmReadRpc,
        r: &CreateMorpho,
        signer: Address,
        intent_hash: String,
        maximum_network_fee: U256,
    ) -> Result<PreparedEvm, EvmPreparationError> {
        if r.vault != self.configuration.vault {
            return Err(EvmPreparationError::Identity);
        }
        morpho_execution::prepare(
            rpc,
            &self.policy,
            MorphoPrepareRequest {
                action: r.action,
                amount: uint(&r.amount_raw).map_err(|_| EvmPreparationError::Invalid)?,
                minimum_shares: r
                    .minimum_shares_raw
                    .as_deref()
                    .map(uint)
                    .transpose()
                    .map_err(|_| EvmPreparationError::Invalid)?,
                acknowledge_unprotected_output: r.acknowledge_unprotected_output,
                signer,
                intent_hash,
                maximum_network_fee,
                deadline: r.deadline,
            },
        )
        .await
    }
}
