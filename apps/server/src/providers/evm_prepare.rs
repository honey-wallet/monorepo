//! Common EVM encoding, parsing and immutable signing terms for provider adapters.
use super::evm_rpc::{EvmReadRpc, RpcError};
use crate::{
    error::AppError,
    preparation::{EvmPreparation, PreparationProvider},
};
use alloy_primitives::{Address, B256, U256, keccak256};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Debug, thiserror::Error)]
pub enum EvmPreparationError {
    #[error("invalid EVM preparation request or policy")]
    Invalid,
    #[error("contract identity or policy changed")]
    Identity,
    #[error("contract is unavailable for this action")]
    Restricted,
    #[error("insufficient balance")]
    Balance,
    #[error("pending wallet activity; refresh after confirmation")]
    Pending,
    #[error("EVM simulation failed")]
    Simulation,
    #[error("estimated execution fee exceeds requested limit")]
    Fees,
    #[error("EVM preparation deadline exceeded")]
    Timeout,
    #[error(transparent)]
    Rpc(#[from] RpcError),
}
pub(super) type Result<T, E = EvmPreparationError> = std::result::Result<T, E>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedEvm {
    pub plan: EvmPreparation,
    pub first_nonce: String,
    pub gas_limits: Vec<String>,
    pub max_fee_per_gas: String,
    pub max_priority_fee_per_gas: String,
}

pub(super) fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
pub fn encode_call(signature: &str, words: &[[u8; 32]]) -> String {
    let mut data = keccak256(signature.as_bytes())[..4].to_vec();
    for word in words {
        data.extend_from_slice(word);
    }
    format!("0x{}", hex::encode(data))
}
pub(super) fn word(address: Address) -> [u8; 32] {
    let mut v = [0; 32];
    v[12..].copy_from_slice(address.as_slice());
    v
}
pub(super) fn quantity(v: &Value) -> Result<U256> {
    let s = v.as_str().ok_or(EvmPreparationError::Invalid)?;
    if !s.starts_with("0x")
        || s.len() < 3
        || s.len() > 66
        || (s.len() > 3 && s.as_bytes()[2] == b'0')
    {
        return Err(EvmPreparationError::Invalid);
    }
    U256::from_str_radix(&s[2..], 16).map_err(|_| EvmPreparationError::Invalid)
}
pub(super) fn bytes(v: &Value) -> Result<Vec<u8>> {
    let s = v.as_str().ok_or(EvmPreparationError::Invalid)?;
    if !s.starts_with("0x") || s.len() % 2 != 0 {
        return Err(EvmPreparationError::Invalid);
    }
    hex::decode(&s[2..]).map_err(|_| EvmPreparationError::Invalid)
}
pub(super) fn abi_word(v: Value) -> Result<U256> {
    let b = bytes(&v)?;
    if b.len() != 32 {
        return Err(EvmPreparationError::Invalid);
    }
    Ok(U256::from_be_slice(&b))
}
pub(super) fn abi_address(v: Value) -> Result<Address> {
    let b = bytes(&v)?;
    if b.len() != 32 || b[..12].iter().any(|b| *b != 0) {
        return Err(EvmPreparationError::Identity);
    }
    Ok(Address::from_slice(&b[12..]))
}
pub(super) fn hex_address(address: Address) -> String {
    format!("{address:#x}")
}

fn invalid_terms() -> AppError {
    AppError::BadRequest("invalid EVM signing terms".into())
}
fn uint(s: &str) -> Result<U256, AppError> {
    if s.is_empty()
        || s.len() > 78
        || (s.len() > 1 && s.starts_with('0'))
        || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(invalid_terms());
    }
    U256::from_str_radix(s, 10).map_err(|_| invalid_terms())
}
impl PreparedEvm {
    /// Exact reviewed nonce/gas/fee terms, in addition to the plan's economic cap.
    pub fn validate_bundle_terms(
        &self,
        bundle: &crate::evm_envelope::VerifiedEvmBundle,
    ) -> Result<(), AppError> {
        self.validate_signing_terms()?;
        let first: u64 = self.first_nonce.parse().map_err(|_| invalid_terms())?;
        if bundle.preparation_hash() != self.plan.integrity_hash()?
            || bundle.transactions().len() != self.gas_limits.len()
        {
            return Err(invalid_terms());
        }
        for (i, (transaction, gas)) in bundle
            .transactions()
            .iter()
            .zip(&self.gas_limits)
            .enumerate()
        {
            if transaction.nonce() != first.checked_add(i as u64).ok_or_else(invalid_terms)?
                || transaction.gas_limit().to_string() != *gas
                || transaction.max_priority_fee_per_gas().to_string()
                    != self.max_priority_fee_per_gas
                || transaction.maximum_execution_fee()
                    != uint(gas)?
                        .checked_mul(uint(&self.max_fee_per_gas)?)
                        .ok_or_else(invalid_terms)?
            {
                return Err(invalid_terms());
            }
        }
        Ok(())
    }
    pub fn validate_signing_terms(&self) -> Result<(), AppError> {
        self.plan.validate()?;
        let nonce = uint(&self.first_nonce)?;
        let max = uint(&self.max_fee_per_gas)?;
        let priority = uint(&self.max_priority_fee_per_gas)?;
        if !matches!(
            self.plan.provider,
            PreparationProvider::AaveV3
                | PreparationProvider::MorphoVaultV2
                | PreparationProvider::Uniswap
        ) || nonce >= U256::from(u64::MAX)
            || nonce
                .checked_add(U256::from(self.plan.steps.len()))
                .is_none_or(|v| v > U256::from(u64::MAX))
            || max > U256::from(u128::MAX)
            || priority > max
            || self.gas_limits.len() != self.plan.steps.len()
        {
            return Err(invalid_terms());
        }
        let mut total = U256::ZERO;
        for gas in &self.gas_limits {
            let gas = uint(gas)?;
            if gas < U256::from(21000) || gas > U256::from(2_000_000) {
                return Err(invalid_terms());
            }
            total = total
                .checked_add(gas.checked_mul(max).ok_or_else(invalid_terms)?)
                .ok_or_else(invalid_terms)?;
        }
        if total != uint(&self.plan.maximum_network_fee_raw)? {
            return Err(invalid_terms());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContractPin {
    #[serde(with = "address_serde")]
    pub address: Address,
    #[serde(with = "hash_serde")]
    pub code_hash: B256,
}
pub(super) mod address_serde {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        v: &Address,
        s: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{v:#x}"))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<Address, D::Error> {
        String::deserialize(d)?
            .parse()
            .map_err(|_| serde::de::Error::custom("invalid address"))
    }
}
pub(super) mod hash_serde {
    use super::*;
    pub fn serialize<S: serde::Serializer>(v: &B256, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{v:#x}"))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<B256, D::Error> {
        String::deserialize(d)?
            .parse()
            .map_err(|_| serde::de::Error::custom("invalid code hash"))
    }
}
pub(super) mod uint_serde {
    use super::*;
    pub fn serialize<S: serde::Serializer>(v: &U256, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<U256, D::Error> {
        uint(&String::deserialize(d)?)
            .map_err(|_| serde::de::Error::custom("invalid unsigned amount"))
    }
}
// Fixed by the reviewed proxy families, never supplied by an API caller.
pub const AAVE_IMPLEMENTATION_SLOT: &str =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
pub const USDC_IMPLEMENTATION_SLOT: &str =
    "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

pub(super) async fn verify_implementation(
    rpc: &EvmReadRpc,
    proxy: &str,
    slot: &str,
    pin: &ContractPin,
    block: &str,
) -> Result<()> {
    let actual = abi_address(rpc.storage(proxy, slot, block).await?)?;
    if actual != pin.address {
        return Err(EvmPreparationError::Identity);
    }
    let code = bytes(&rpc.code(&hex_address(actual), block).await?)?;
    if code.is_empty() || keccak256(&code) != pin.code_hash {
        return Err(EvmPreparationError::Identity);
    }
    Ok(())
}
