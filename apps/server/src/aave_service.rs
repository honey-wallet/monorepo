//! Authenticated, durable Aave orchestration. Activation is deliberately restricted
//! to an explicitly configured local fork until production registry/upgrade policy
//! and RPC quotas have independent launch evidence.
use crate::{
    earn_service::{EarnAdapter, EarnIdentity, LocalEarnService, invalid, uint},
    error::AppError,
    preparation::PreparationProvider,
    providers::{
        aave_execution::{
            self, AaveAction, AaveExecutionPolicy, AavePrepareRequest, ImplementationPin,
        },
        evm_prepare::{EvmPreparationError, PreparedEvm},
        evm_rpc::EvmReadRpc,
        rpc_budget::{RpcBudget, RpcBudgetConfig},
    },
    submissions::SubmissionKeys,
    work::WorkStore,
};
use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileConfig {
    mode: String,
    rpc_url: String,
    rpc_budget: RpcBudgetConfig,
    chain_id: String,
    pool: String,
    asset: String,
    a_token: String,
    decimals: u8,
    pool_code_hash: String,
    asset_code_hash: String,
    a_token_code_hash: String,
    pool_implementation: FileImplementationPin,
    asset_implementation: FileImplementationPin,
    a_token_implementation: FileImplementationPin,
    registry_revision: String,
    zero_fee_policy_revision: String,
    maximum_gas_per_transaction: u64,
    maximum_atoken_rounding_raw: String,
    active_key_id: String,
    #[serde(deserialize_with = "crate::earn_service::decode_keys")]
    data_keys: BTreeMap<String, Zeroizing<String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileImplementationPin {
    address: String,
    code_hash: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionConfiguration {
    pub mode: &'static str,
    pub chain_id: String,
    pub pool: String,
    pub asset: String,
    pub a_token: String,
    pub decimals: u8,
    pub maximum_atoken_rounding_raw: String,
    pub registry_revision: String,
    pub fee_policy_revision: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAave {
    pub action: AaveAction,
    pub amount_raw: String,
    pub maximum_network_fee_raw: String,
}

pub type AaveService = LocalEarnService<AaveAdapter>;
pub type AaveSigningRequest = crate::earn_service::EarnSigningRequest;
pub type SubmitAave = crate::earn_service::SubmitEarn;
pub type AaveIntentRecovery = crate::earn_service::EarnIntentRecovery<CreateAave>;
pub struct AaveAdapter {
    policy: AaveExecutionPolicy,
    configuration: ExecutionConfiguration,
}
impl AaveService {
    /// Secret-mounted file, no keys in environment/debug output; no defaults. File
    /// size and permissions checked before parsing. This is an application DEK only.
    pub fn from_file(
        work: WorkStore,
        path: &str,
        redis: crate::redis_store::RedisStore,
        metrics: Arc<crate::metrics::Metrics>,
    ) -> Result<Self, AppError> {
        let c: FileConfig = crate::earn_service::load_file(path)?;
        let url = reqwest::Url::parse(&c.rpc_url).map_err(|_| invalid())?;
        // Literal loopback, not a DNS name. Production chain activation is a separate
        // reviewed change, not a flag that silently trusts test contract identities.
        if c.mode != "local_fork"
            || c.chain_id != "31337"
            || url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || c.decimals > 18
            || !(21000..=2_000_000).contains(&c.maximum_gas_per_transaction)
            || c.registry_revision.is_empty()
            || c.registry_revision.len() > 128
            || c.zero_fee_policy_revision.is_empty()
            || c.zero_fee_policy_revision.len() > 128
        {
            return Err(invalid());
        }
        let address = |s: &str| {
            s.parse::<Address>()
                .ok()
                .filter(|a| *a != Address::ZERO)
                .ok_or_else(invalid)
        };
        let hash = |s: &str| {
            s.parse::<B256>()
                .ok()
                .filter(|a| *a != B256::ZERO)
                .ok_or_else(invalid)
        };
        let implementation = |pin: &FileImplementationPin| -> Result<ImplementationPin, AppError> {
            let code_hash = hash(&pin.code_hash)?;
            if code_hash == alloy_primitives::keccak256([]) {
                return Err(invalid());
            }
            Ok(ImplementationPin {
                address: address(&pin.address)?,
                code_hash,
            })
        };
        let p = AaveExecutionPolicy {
            chain_id: 31337,
            pool: address(&c.pool)?,
            asset: address(&c.asset)?,
            a_token: address(&c.a_token)?,
            decimals: c.decimals,
            pool_code_hash: hash(&c.pool_code_hash)?,
            asset_code_hash: hash(&c.asset_code_hash)?,
            a_token_code_hash: hash(&c.a_token_code_hash)?,
            pool_implementation: implementation(&c.pool_implementation)?,
            asset_implementation: implementation(&c.asset_implementation)?,
            a_token_implementation: implementation(&c.a_token_implementation)?,
            registry_revision: c.registry_revision,
            zero_fee_policy_revision: c.zero_fee_policy_revision,
            maximum_gas_per_transaction: c.maximum_gas_per_transaction,
            maximum_atoken_rounding_raw: uint(&c.maximum_atoken_rounding_raw)?,
        };
        let mut keys = BTreeMap::new();
        for (id, value) in c.data_keys {
            let mut key = Zeroizing::new([0u8; 32]);
            hex::decode_to_slice(value.as_str(), key.as_mut()).map_err(|_| invalid())?;
            keys.insert(id, key);
        }
        let configuration = ExecutionConfiguration {
            mode: "local_fork",
            chain_id: "31337".into(),
            pool: format!("{:#x}", p.pool),
            asset: format!("{:#x}", p.asset),
            a_token: format!("{:#x}", p.a_token),
            decimals: p.decimals,
            maximum_atoken_rounding_raw: p.maximum_atoken_rounding_raw.to_string(),
            registry_revision: p.registry_revision.clone(),
            fee_policy_revision: p.zero_fee_policy_revision.clone(),
        };
        Ok(Self {
            work,
            rpc: EvmReadRpc::with_budget(
                &c.rpc_url,
                RpcBudget::new(redis, c.rpc_budget).map_err(|_| invalid())?,
                metrics,
            )
            .map_err(|_| invalid())?,
            keys: SubmissionKeys::new(c.active_key_id, keys)?,
            adapter: AaveAdapter {
                policy: p,
                configuration,
            },
        })
    }
}
impl EarnAdapter for AaveAdapter {
    type Request = CreateAave;
    type Configuration = ExecutionConfiguration;
    const SERVICE: &'static str = "aave_v1";
    const PROVIDER: PreparationProvider = PreparationProvider::AaveV3;
    fn identity(&self) -> EarnIdentity {
        EarnIdentity {
            chain_id: self.configuration.chain_id.clone(),
            asset: self.configuration.asset.clone(),
            registry_revision: self.configuration.registry_revision.clone(),
            fee_policy_revision: self.configuration.fee_policy_revision.clone(),
        }
    }
    fn configuration(&self) -> ExecutionConfiguration {
        self.configuration.clone()
    }
    fn validate(&self, r: &CreateAave) -> Result<(), AppError> {
        let amount = uint(&r.amount_raw)?;
        if amount == U256::ZERO || amount == U256::MAX || self.network_budget(r)? == U256::ZERO {
            return Err(invalid());
        }
        Ok(())
    }
    fn network_budget(&self, r: &CreateAave) -> Result<U256, AppError> {
        uint(&r.maximum_network_fee_raw)
    }
    async fn prepare(
        &self,
        rpc: &EvmReadRpc,
        r: &CreateAave,
        signer: Address,
        intent_hash: String,
        maximum_network_fee: U256,
    ) -> Result<PreparedEvm, EvmPreparationError> {
        aave_execution::prepare(
            rpc,
            &self.policy,
            AavePrepareRequest {
                action: r.action,
                signer,
                amount: uint(&r.amount_raw).map_err(|_| EvmPreparationError::Invalid)?,
                intent_hash,
                maximum_network_fee,
            },
        )
        .await
    }
}
