//! Independent signed-byte verification for the current single-chain EVM plan.
//! Pure CPU/memory work: no RPC, signing, persistence, nonce allocation or broadcast.
use crate::preparation::EvmPreparation;
use alloy_consensus::{TxEnvelope, transaction::SignerRecoverable};
use alloy_eips::eip2718::{Decodable2718, Encodable2718};
use alloy_primitives::{Address, B256, TxKind, U256, keccak256};

const MAX_SIGNED_BYTES: usize = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum EnvelopeError {
    #[error("invalid transaction preparation")]
    InvalidPlan,
    #[error("transaction preparation expired or clock context invalid")]
    Expired,
    #[error("invalid envelope validation policy")]
    InvalidPolicy,
    #[error("signed transaction count differs from prepared steps")]
    StepCount,
    #[error("invalid signed transaction encoding")]
    Encoding,
    #[error("unsupported signed transaction type")]
    UnsupportedType,
    #[error("invalid or noncanonical transaction signature")]
    Signature,
    #[error("transaction signer differs from prepared signer")]
    Signer,
    #[error("transaction chain differs from prepared chain")]
    Chain,
    #[error("transaction nonce differs from expected sequence")]
    Nonce,
    #[error("transaction call differs from prepared call")]
    Call,
    #[error("access lists require a separately reviewed preparation format")]
    AccessList,
    #[error("transaction gas limit violates the validated policy")]
    Gas,
    #[error("transaction fee bounds invalid or bundle fee ceiling exceeded")]
    Fees,
}

/// Supplied by the trusted execution service after fresh chain/RPC validation.
/// Not deserializable from an HTTP body. This verifier does not prove either value.
#[derive(Clone, Copy)]
pub struct EvmEnvelopePolicy {
    pub first_nonce: u64,
    pub maximum_gas_per_transaction: u64,
}

/// Constructible only by successful verification. No Debug/Serialize implementation:
/// signed bytes are a broadcastable authorization and must not enter logs/responses.
pub struct VerifiedEvmBundle {
    preparation_hash: String,
    chain_id: u64,
    signer: Address,
    transactions: Vec<VerifiedEvmTransaction>,
    maximum_execution_fee: U256,
}
pub struct VerifiedEvmTransaction {
    raw: zeroize::Zeroizing<Vec<u8>>,
    hash: B256,
    nonce: u64,
    gas_limit: u64,
    maximum_execution_fee: U256,
    max_priority_fee_per_gas: u128,
}
impl VerifiedEvmBundle {
    pub fn preparation_hash(&self) -> &str {
        &self.preparation_hash
    }
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }
    pub fn signer(&self) -> Address {
        self.signer
    }
    pub fn transactions(&self) -> &[VerifiedEvmTransaction] {
        &self.transactions
    }
    pub fn maximum_execution_fee(&self) -> U256 {
        self.maximum_execution_fee
    }
}
impl VerifiedEvmTransaction {
    pub fn max_priority_fee_per_gas(&self) -> u128 {
        self.max_priority_fee_per_gas
    }

    /// Explicit sensitive access for a future durable submission service. Possession
    /// of these bytes does not establish that a broadcast is currently authorized.
    pub fn expose_signed_bytes(&self) -> &[u8] {
        &self.raw
    }
    pub fn hash(&self) -> B256 {
        self.hash
    }
    pub fn nonce(&self) -> u64 {
        self.nonce
    }
    pub fn gas_limit(&self) -> u64 {
        self.gas_limit
    }
    pub fn maximum_execution_fee(&self) -> U256 {
        self.maximum_execution_fee
    }
}

/// Verify a complete ordered bundle against an immutable preparation. Every planned
/// call appears exactly once. Fee ceilings are summed across approvals AND action.
/// `now_ms` must come from a trusted clock, not a request. This result is not a
/// capability to broadcast; prerequisite receipts/chain/fee/eligibility checks remain.
#[tracing::instrument(name = "execution.verify_envelopes", skip_all)]
pub fn verify_signed_bundle(
    plan: &EvmPreparation,
    policy: EvmEnvelopePolicy,
    signed: &[String],
    now_ms: i64,
) -> Result<VerifiedEvmBundle, EnvelopeError> {
    use EnvelopeError as E;
    plan.validate().map_err(|_| E::InvalidPlan)?;
    if now_ms <= 0 || now_ms < plan.simulation.observed_at_ms || now_ms >= plan.expires_at_ms {
        return Err(E::Expired);
    }
    // Chain-dependent fork/transaction/block gas limits must be supplied by the
    // service. The 21000 lower bound is only the basic EVM intrinsic floor.
    if policy.maximum_gas_per_transaction < 21000 || policy.first_nonce == u64::MAX {
        return Err(E::InvalidPolicy);
    }
    if signed.len() != plan.steps.len() {
        return Err(E::StepCount);
    }
    let signer = plan.signer.parse::<Address>().map_err(|_| E::InvalidPlan)?;
    let chain = plan.chain_id.parse::<u64>().map_err(|_| E::InvalidPlan)?;
    let budget =
        U256::from_str_radix(&plan.maximum_network_fee_raw, 10).map_err(|_| E::InvalidPlan)?;
    let mut total = U256::ZERO;
    let mut transactions = Vec::with_capacity(signed.len());
    for (i, (encoded, call)) in signed.iter().zip(&plan.steps).enumerate() {
        let maximum_bytes = if plan.provider == crate::preparation::PreparationProvider::Uniswap {
            66560
        } else {
            MAX_SIGNED_BYTES
        };
        if encoded.len() > maximum_bytes * 2 + 2
            || encoded.len() < 4
            || encoded.len() % 2 != 0
            || !encoded.starts_with("0x")
        {
            return Err(E::Encoding);
        }
        let raw = zeroize::Zeroizing::new(hex::decode(&encoded[2..]).map_err(|_| E::Encoding)?);
        if raw.first() != Some(&2) {
            return Err(E::UnsupportedType);
        }
        // Standalone RPC bytes, not p2p's outer RLP wrapper. Exact decode plus
        // canonical re-encode rejects trailing data and alternate encodings.
        let envelope = TxEnvelope::decode_2718_exact(&raw).map_err(|_| E::Encoding)?;
        let reencoded = zeroize::Zeroizing::new(envelope.encoded_2718());
        if reencoded.as_slice() != raw.as_slice() {
            return Err(E::Encoding);
        }
        let TxEnvelope::Eip1559(signed_tx) = &envelope else {
            return Err(E::UnsupportedType);
        };
        let tx = signed_tx.tx();
        if tx.chain_id != chain {
            return Err(E::Chain);
        }
        let nonce = policy
            .first_nonce
            .checked_add(i as u64)
            .filter(|n| *n < u64::MAX)
            .ok_or(E::Nonce)?;
        if tx.nonce != nonce {
            return Err(E::Nonce);
        }
        if !tx.access_list.0.is_empty() {
            return Err(E::AccessList);
        }
        let expected_data =
            zeroize::Zeroizing::new(hex::decode(&call.data[2..]).map_err(|_| E::InvalidPlan)?);
        if tx.to != TxKind::Call(call.to.parse::<Address>().map_err(|_| E::InvalidPlan)?)
            || tx.value != U256::from_str_radix(&call.value_raw, 10).map_err(|_| E::InvalidPlan)?
            || tx.input.as_ref() != expected_data.as_slice()
        {
            return Err(E::Call);
        }
        // EIP-1559 baseline intrinsic gas. Fork-specific floors (e.g. calldata
        // pricing) and actual execution gas still require fresh RPC simulation.
        let intrinsic = 21000u64
            + tx.input
                .iter()
                .map(|b| if *b == 0 { 4 } else { 16 })
                .sum::<u64>();
        if tx.gas_limit < intrinsic || tx.gas_limit > policy.maximum_gas_per_transaction {
            return Err(E::Gas);
        }
        if tx.max_fee_per_gas < tx.max_priority_fee_per_gas {
            return Err(E::Fees);
        }
        let fee = U256::from(tx.gas_limit)
            .checked_mul(U256::from(tx.max_fee_per_gas))
            .ok_or(E::Fees)?;
        total = total.checked_add(fee).ok_or(E::Fees)?;
        if total > budget {
            return Err(E::Fees);
        }
        // Explicit trait dispatch matters: Signed<T>'s similarly named inherent
        // recovery method does not enforce low-S. The checked trait does (EIP-2).
        if SignerRecoverable::recover_signer(&envelope).map_err(|_| E::Signature)? != signer {
            return Err(E::Signer);
        }
        let hash = keccak256(&raw);
        if envelope.tx_hash() != &hash {
            return Err(E::Encoding);
        }
        transactions.push(VerifiedEvmTransaction {
            raw,
            hash,
            nonce,
            gas_limit: tx.gas_limit,
            maximum_execution_fee: fee,
            max_priority_fee_per_gas: tx.max_priority_fee_per_gas,
        });
    }
    Ok(VerifiedEvmBundle {
        preparation_hash: plan.integrity_hash().map_err(|_| E::InvalidPlan)?,
        chain_id: chain,
        signer,
        transactions,
        maximum_execution_fee: total,
    })
}
