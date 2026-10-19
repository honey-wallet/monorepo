//! Source-chain preparation for a reviewed Across direct ERC20 deposit.
//! Destination output is a separate immutable obligation, never source simulation evidence.
use super::{
    across_evidence::{DirectDepositTerms, EvidencePolicy, TokenProxy},
    across_quotes::ValidatedAcrossQuote,
    evm_prepare::{
        self, ContractPin, EvmPreparationError as E, PreparedEvm, abi_address, abi_word, bytes,
        encode_call, hex_address, now_ms, quantity, verify_implementation, word,
    },
    evm_rpc::EvmReadRpc,
};
use crate::{
    identity::digest,
    preparation::{
        AssetAmount, CallPurpose, EvmCall, EvmPreparation, PreparationProvider, SimulationRecord,
        calls_hash, canonical,
    },
};
use alloy_primitives::{Address, B256, U256, keccak256};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
type Result<T> = std::result::Result<T, E>;
pub const FEE_POLICY_REVISION: &str = "across-zero-app-fee-v1";

/// Operator-owned pins. The enclosing service must also bind the quote's route
/// to its approved destination asset; source simulation cannot prove equivalence.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcrossExecutionPolicy {
    pub source: EvidencePolicy,
    pub registry_revision: String,
    pub decimals: u8,
    pub allow_empty_approval_return: bool,
    pub maximum_gas_per_transaction: u64,
}
/// Serializable consent, not a provider attestation. Restore only from an owner-
/// bound immutable intent, validate it, and compare its intent hash before use.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcrossPreparationRequest {
    pub terms: DirectDepositTerms,
    pub source_spoke: String,
    pub calldata: String,
    pub quote_id: String,
    pub registry_revision: String,
    pub intent_hash: String,
    pub quoted_at_ms: i64,
    /// Short local quote-cache/freshness bound; must be at most 30 seconds after receipt.
    pub quote_expires_at_ms: i64,
    /// Provider-declared hard expiry, preserved separately from the local TTL.
    pub provider_expires_at_ms: Option<i64>,
    /// User's last permitted execution time in milliseconds.
    pub execution_deadline_ms: i64,
    pub maximum_network_fee_raw: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcrossPreparationReview {
    pub terms: DirectDepositTerms,
    pub source_spoke: String,
    pub calldata: String,
    pub quote_id: String,
    pub registry_revision: String,
    pub intent_hash: String,
    pub quoted_at_ms: i64,
    pub quote_expires_at_ms: i64,
    pub provider_expires_at_ms: Option<i64>,
    pub execution_deadline_ms: i64,
    pub prepared_at_ms: i64,
    pub expires_at_ms: i64,
    pub maximum_network_fee_raw: String,
}
impl AcrossPreparationReview {
    pub fn validate(&self) -> Result<()> {
        let request = AcrossPreparationRequest {
            terms: self.terms.clone(),
            source_spoke: self.source_spoke.clone(),
            calldata: self.calldata.clone(),
            quote_id: self.quote_id.clone(),
            registry_revision: self.registry_revision.clone(),
            intent_hash: self.intent_hash.clone(),
            quoted_at_ms: self.quoted_at_ms,
            quote_expires_at_ms: self.quote_expires_at_ms,
            provider_expires_at_ms: self.provider_expires_at_ms,
            execution_deadline_ms: self.execution_deadline_ms,
            maximum_network_fee_raw: self.maximum_network_fee_raw.clone(),
        };
        request.validate()?;
        let expiry = self.expires_at_ms;
        let prepared = self.prepared_at_ms;
        let quote_time = i64::from(self.terms.quote_timestamp);
        let fill = i64::from(self.terms.fill_deadline);
        let exclusive = i64::from(self.terms.exclusivity_parameter);
        if prepared < self.quoted_at_ms
            || expiry <= prepared
            || expiry > prepared.saturating_add(300_000)
            || expiry > self.execution_deadline_ms
            || expiry > (quote_time + 300).saturating_mul(1000)
            || expiry > (fill - 30).saturating_mul(1000)
            || self.provider_expires_at_ms.is_some_and(|cap| expiry > cap)
            || exclusive <= 31_536_000 && expiry > (fill - exclusive).saturating_mul(1000)
            || exclusive > 31_536_000 && expiry > exclusive.saturating_mul(1000)
        {
            return Err(E::Invalid);
        }
        Ok(())
    }
    pub fn integrity_hash(&self) -> Result<String> {
        self.validate()?;
        Ok(hex::encode(digest(
            canonical(self).map_err(|_| E::Invalid)?.as_bytes(),
        )))
    }
}
fn uint(s: &str) -> Result<U256> {
    if s.is_empty() || s.len() > 78 || !s.bytes().all(|c| c.is_ascii_digit()) {
        return Err(E::Invalid);
    }
    let n = U256::from_str_radix(s, 10).map_err(|_| E::Invalid)?;
    if n.to_string() != s {
        return Err(E::Invalid);
    }
    Ok(n)
}
fn addr(s: &str) -> Result<Address> {
    let a: Address = s.parse().map_err(|_| E::Invalid)?;
    if hex_address(a) != s || a == Address::ZERO {
        return Err(E::Invalid);
    }
    Ok(a)
}
fn label(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}
impl AcrossPreparationRequest {
    pub fn from_quote(
        q: &ValidatedAcrossQuote,
        source_spoke: &str,
        intent_hash: &str,
        execution_deadline_ms: i64,
        maximum_network_fee_raw: &str,
    ) -> Result<Self> {
        let v = q.quote();
        let r = Self {
            terms: q.terms().clone(),
            source_spoke: source_spoke.into(),
            calldata: q.calldata().into(),
            quote_id: v.quote_id.clone(),
            registry_revision: v.registry_revision.clone(),
            intent_hash: intent_hash.into(),
            quoted_at_ms: v.received_at_ms,
            quote_expires_at_ms: v.expires_at_ms,
            provider_expires_at_ms: v.provider_expires_at_ms,
            execution_deadline_ms,
            maximum_network_fee_raw: maximum_network_fee_raw.into(),
        };
        r.validate()?;
        Ok(r)
    }
    /// Structural/economic validation intentionally does not claim quote provenance.
    pub fn validate(&self) -> Result<()> {
        self.terms
            .validate_calldata(&self.calldata, U256::ZERO)
            .map_err(|_| E::Invalid)?;
        if self.terms.swap_api_integrator_id.is_none()
            || self.terms.output_amount > self.terms.input_amount
            || self.calldata.bytes().any(|c| c.is_ascii_uppercase())
            || !label(&self.quote_id, 128)
            || !label(&self.registry_revision, 64)
            || self.intent_hash.len() != 64
            || !self
                .intent_hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || self.quoted_at_ms <= 0
            || self.quoted_at_ms > 9_007_199_254_710_991
            || self.quote_expires_at_ms <= self.quoted_at_ms
            || self.quote_expires_at_ms > self.quoted_at_ms + 30000
            || self.execution_deadline_ms <= self.quoted_at_ms
            || self.quote_expires_at_ms > self.execution_deadline_ms
            || self
                .provider_expires_at_ms
                .is_some_and(|expiry| expiry <= self.quoted_at_ms)
            || uint(&self.maximum_network_fee_raw)? == U256::ZERO
        {
            return Err(E::Invalid);
        }
        let spoke = addr(&self.source_spoke)?;
        if [self.terms.depositor, self.terms.input_token].contains(&spoke) {
            return Err(E::Invalid);
        }
        let quoted = (self.quoted_at_ms / 1000) as u64;
        let expiry = ((self.quote_expires_at_ms + 999) / 1000) as u64;
        let qt = u64::from(self.terms.quote_timestamp);
        let fill = u64::from(self.terms.fill_deadline);
        if qt > quoted + 15
            || qt + 300 < expiry
            || fill < expiry + 30
            || fill > quoted + 86400
            || self.execution_deadline_ms / 1000 > fill.saturating_sub(30) as i64
        {
            return Err(E::Invalid);
        }
        let exclusive = u64::from(self.terms.exclusivity_parameter);
        if exclusive <= 31_536_000 && expiry + exclusive > fill
            || exclusive > 31_536_000 && (exclusive < expiry || exclusive > fill)
        {
            return Err(E::Invalid);
        }
        if self
            .provider_expires_at_ms
            .is_some_and(|provider| self.quote_expires_at_ms > provider)
            || exclusive > 31_536_000
                && self.execution_deadline_ms > i64::from(self.terms.exclusivity_parameter) * 1000
        {
            return Err(E::Invalid);
        }
        Ok(())
    }
    pub fn integrity_hash(&self) -> Result<String> {
        self.validate()?;
        Ok(hex::encode(digest(
            canonical(self).map_err(|_| E::Invalid)?.as_bytes(),
        )))
    }
}
fn valid_pin(p: &ContractPin) -> bool {
    p.address != Address::ZERO && p.code_hash != B256::ZERO && p.code_hash != keccak256([])
}
fn policy(
    rpc: &EvmReadRpc,
    p: &AcrossExecutionPolicy,
    r: &AcrossPreparationRequest,
    require_fresh_quote: bool,
) -> Result<()> {
    r.validate()?;
    let source = &p.source;
    if !(source.chain == 1 || source.chain == 31337 && rpc.is_loopback())
        || source.chain != r.terms.source_chain
        || hex_address(source.spoke.address) != r.source_spoke
        || source.token.address != r.terms.input_token
        || source.wrapped_native == Address::ZERO
        || source.token.address == source.wrapped_native
        || p.registry_revision != r.registry_revision
        || p.decimals > 36
        || !(21000..=2_000_000).contains(&p.maximum_gas_per_transaction)
        || now_ms() < r.quoted_at_ms
        || now_ms() >= r.execution_deadline_ms
        || r.provider_expires_at_ms
            .is_some_and(|expiry| now_ms() >= expiry)
        || (require_fresh_quote && (now_ms() < r.quoted_at_ms || now_ms() >= r.quote_expires_at_ms))
    {
        return Err(E::Invalid);
    }
    let pins = [&source.spoke, &source.spoke_implementation, &source.token];
    if pins.iter().any(|p| !valid_pin(p))
        || source.spoke.address == source.spoke_implementation.address
        || source.token.address == source.spoke.address
    {
        return Err(E::Invalid);
    }
    if let Some((_, pin)) = &source.token_implementation
        && (!valid_pin(pin) || pin.address == source.token.address)
    {
        return Err(E::Invalid);
    }
    Ok(())
}
async fn pin(rpc: &EvmReadRpc, p: &ContractPin, tag: &str) -> Result<()> {
    let code = bytes(&rpc.code(&hex_address(p.address), tag).await?)?;
    if code.is_empty() || keccak256(code) != p.code_hash {
        return Err(E::Identity);
    }
    Ok(())
}
fn hash(v: &Value) -> Result<B256> {
    let h: B256 = v
        .as_str()
        .ok_or(E::Identity)?
        .parse()
        .map_err(|_| E::Identity)?;
    if h == B256::ZERO {
        return Err(E::Identity);
    }
    Ok(h)
}
fn output(v: &Value) -> Result<U256> {
    if v["status"] != "0x1" || v.get("error").is_some() {
        return Err(E::Simulation);
    }
    abi_word(v["returnData"].clone()).map_err(|_| E::Simulation)
}
fn read(from: &str, to: &str, data: String) -> Value {
    json!({"from":from,"to":to,"data":data,"value":"0x0","gas":"0x186a0"})
}
/// No transaction broadcast or destination balance claim. A fresh simulation is
/// required again before dispatch, including after any partial approval bundle.
#[tracing::instrument(name = "provider.across_prepare", skip_all)]
pub async fn prepare(
    rpc: &EvmReadRpc,
    p: &AcrossExecutionPolicy,
    r: &AcrossPreparationRequest,
) -> Result<PreparedEvm> {
    let remaining = r.quote_expires_at_ms.saturating_sub(now_ms());
    if remaining <= 0 {
        return Err(E::Invalid);
    }
    tokio::time::timeout(
        Duration::from_millis((remaining as u64).min(60000)),
        prepare_inner(rpc, p, r, None),
    )
    .await
    .map_err(|_| E::Timeout)?
}
/// Re-simulates an already-prepared immutable operation after the short-lived quote
/// cache has expired. `signed_expiry_ms` must come from the owner-bound persisted plan.
#[tracing::instrument(name = "provider.across_revalidate", skip_all)]
pub async fn revalidate(
    rpc: &EvmReadRpc,
    p: &AcrossExecutionPolicy,
    r: &AcrossPreparationRequest,
    signed_expiry_ms: i64,
) -> Result<PreparedEvm> {
    let now = now_ms();
    let remaining = signed_expiry_ms.saturating_sub(now);
    if remaining <= 0
        || signed_expiry_ms > r.execution_deadline_ms
        || r.provider_expires_at_ms
            .is_some_and(|expiry| signed_expiry_ms > expiry)
    {
        return Err(E::Invalid);
    }
    tokio::time::timeout(
        Duration::from_millis((remaining as u64).min(60000)),
        prepare_inner(rpc, p, r, Some(signed_expiry_ms)),
    )
    .await
    .map_err(|_| E::Timeout)?
}
async fn prepare_inner(
    rpc: &EvmReadRpc,
    p: &AcrossExecutionPolicy,
    r: &AcrossPreparationRequest,
    signed_expiry_ms: Option<i64>,
) -> Result<PreparedEvm> {
    policy(rpc, p, r, signed_expiry_ms.is_none())?;
    if quantity(&rpc.chain_id().await?)? != U256::from(p.source.chain) {
        return Err(E::Identity);
    }
    let head = rpc.block("latest").await?;
    let number = quantity(&head["number"])?;
    let block_hash = hash(&head["hash"])?;
    let timestamp = quantity(&head["timestamp"])?;
    let now = U256::from((now_ms() / 1000) as u64);
    if number > U256::from(u64::MAX)
        || timestamp > now + U256::from(15)
        || timestamp + U256::from(120) < now
        || timestamp > U256::from(u32::MAX)
    {
        return Err(E::Identity);
    }
    let tag = format!("{number:#x}");
    let owner = hex_address(r.terms.depositor);
    let token = hex_address(r.terms.input_token);
    let spoke = &r.source_spoke;
    if !bytes(&rpc.code(&owner, &tag).await?)?.is_empty() {
        return Err(E::Identity);
    }
    pin(rpc, &p.source.spoke, &tag).await?;
    verify_implementation(
        rpc,
        spoke,
        evm_prepare::AAVE_IMPLEMENTATION_SLOT,
        &p.source.spoke_implementation,
        &tag,
    )
    .await?;
    pin(rpc, &p.source.token, &tag).await?;
    if let Some((family, pin)) = &p.source.token_implementation {
        verify_implementation(
            rpc,
            &token,
            match family {
                TokenProxy::Eip1967 => evm_prepare::AAVE_IMPLEMENTATION_SLOT,
                TokenProxy::Usdc => evm_prepare::USDC_IMPLEMENTATION_SLOT,
            },
            pin,
            &tag,
        )
        .await?;
    }
    let decimals_call = encode_call("decimals()", &[]);
    let wrapped_call = encode_call("wrappedNativeToken()", &[]);
    let (decimals, wrapped) = tokio::try_join!(
        rpc.call(&token, &decimals_call, &tag),
        rpc.call(spoke, &wrapped_call, &tag)
    )?;
    if abi_word(decimals)? != U256::from(p.decimals)
        || abi_address(wrapped)? != p.source.wrapped_native
    {
        return Err(E::Identity);
    }
    let allowance_data = encode_call(
        "allowance(address,address)",
        &[word(r.terms.depositor), word(p.source.spoke.address)],
    );
    let owner_balance_data = encode_call("balanceOf(address)", &[word(r.terms.depositor)]);
    let spoke_balance_data = encode_call("balanceOf(address)", &[word(p.source.spoke.address)]);
    let (nonce, pending, native) = tokio::try_join!(
        rpc.nonce(&owner, &tag),
        rpc.nonce(&owner, "pending"),
        rpc.balance(&owner, &tag)
    )?;
    let nonce = quantity(&nonce)?;
    if nonce != quantity(&pending)? || nonce >= U256::from(u64::MAX) {
        return Err(E::Pending);
    }
    let (balance, spoke_balance, allowance) = tokio::try_join!(
        rpc.call(&token, &owner_balance_data, &tag),
        rpc.call(&token, &spoke_balance_data, &tag),
        rpc.call(&token, &allowance_data, &tag)
    )?;
    let balance = abi_word(balance)?;
    let spoke_balance = abi_word(spoke_balance)?;
    let allowance = abi_word(allowance)?;
    let amount = r.terms.input_amount;
    if balance < amount {
        return Err(E::Balance);
    }
    let mut steps = Vec::new();
    if allowance < amount {
        if allowance != U256::ZERO {
            steps.push(EvmCall {
                purpose: CallPurpose::Approval,
                to: token.clone(),
                value_raw: "0".into(),
                data: encode_call(
                    "approve(address,uint256)",
                    &[word(p.source.spoke.address), [0; 32]],
                ),
            });
        }
        steps.push(EvmCall {
            purpose: CallPurpose::Approval,
            to: token.clone(),
            value_raw: "0".into(),
            data: encode_call(
                "approve(address,uint256)",
                &[word(p.source.spoke.address), amount.to_be_bytes()],
            ),
        });
    }
    steps.push(EvmCall {
        purpose: CallPurpose::Action,
        to: spoke.clone(),
        value_raw: "0".into(),
        data: r.calldata.clone(),
    });
    if nonce + U256::from(steps.len()) > U256::from(u64::MAX) {
        return Err(E::Pending);
    }
    let reads = vec![
        read(&owner, &token, owner_balance_data),
        read(&owner, &token, spoke_balance_data),
        read(&owner, &token, allowance_data),
    ];
    let mut calls = reads.clone();
    calls.extend(steps.iter().map(|c|json!({"from":owner,"to":c.to,"data":c.data,"value":"0x0","gas":format!("0x{:x}",p.maximum_gas_per_transaction)})));
    calls.extend(reads);
    let simulation = rpc.simulate(calls, &tag).await?;
    let blocks = simulation
        .as_array()
        .filter(|b| b.len() == 1)
        .ok_or(E::Simulation)?;
    let sim_time = quantity(&blocks[0]["timestamp"])?;
    let qt = U256::from(r.terms.quote_timestamp);
    let fill = U256::from(r.terms.fill_deadline);
    let exclusive = U256::from(r.terms.exclusivity_parameter);
    if hash(&blocks[0]["parentHash"])? != block_hash
        || sim_time <= timestamp
        || sim_time >= U256::from((r.execution_deadline_ms / 1000) as u64)
        || r.provider_expires_at_ms
            .is_some_and(|expiry| sim_time >= U256::from((expiry / 1000) as u64))
        || sim_time < qt
        || sim_time > qt + U256::from(300)
        || sim_time + U256::from(30) > fill
        || r.terms.exclusivity_parameter <= 31_536_000 && sim_time + exclusive > fill
    {
        return Err(E::Simulation);
    }
    let results = blocks[0]["calls"]
        .as_array()
        .filter(|c| c.len() == 6 + steps.len())
        .ok_or(E::Simulation)?;
    let before = results[..3]
        .iter()
        .map(output)
        .collect::<Result<Vec<_>>>()?;
    let after = results[3 + steps.len()..]
        .iter()
        .map(output)
        .collect::<Result<Vec<_>>>()?;
    let granted = if allowance < amount {
        amount
    } else {
        allowance
    };
    let remaining = granted - amount;
    if before != [balance, spoke_balance, allowance]
        || after[0] != balance - amount
        || after[1] != spoke_balance.checked_add(amount).ok_or(E::Simulation)?
        || !(after[2] == remaining || granted == U256::MAX && after[2] == U256::MAX)
    {
        return Err(E::Simulation);
    }
    let mut gas_limits = Vec::new();
    let mut total = U256::ZERO;
    for (step, result) in steps.iter().zip(&results[3..3 + steps.len()]) {
        if result["status"] != "0x1" || result.get("error").is_some() {
            return Err(E::Simulation);
        }
        if step.purpose == CallPurpose::Approval {
            if !(p.allow_empty_approval_return && result["returnData"] == "0x")
                && abi_word(result["returnData"].clone()).map_err(|_| E::Simulation)?
                    != U256::from(1)
            {
                return Err(E::Simulation);
            }
        } else if result["returnData"] != "0x" {
            return Err(E::Simulation);
        }
        let used = quantity(&result["gasUsed"])?;
        if used < U256::from(21000) {
            return Err(E::Simulation);
        }
        let gas = used
            .checked_mul(U256::from(120))
            .and_then(|g| g.checked_div(U256::from(100)))
            .and_then(|g| g.checked_add(U256::from(10000)))
            .filter(|g| *g <= U256::from(p.maximum_gas_per_transaction))
            .ok_or(E::Fees)?;
        total = total.checked_add(gas).ok_or(E::Fees)?;
        gas_limits.push(gas.to_string());
    }
    let priority = quantity(&rpc.priority_fee().await?)?;
    let max_fee = quantity(&head["baseFeePerGas"])?
        .checked_mul(U256::from(2))
        .and_then(|v| v.checked_add(priority))
        .filter(|v| *v <= U256::from(u128::MAX))
        .ok_or(E::Fees)?;
    let fee = total.checked_mul(max_fee).ok_or(E::Fees)?;
    if max_fee == U256::ZERO || fee > uint(&r.maximum_network_fee_raw)? || fee > quantity(&native)?
    {
        return Err(E::Fees);
    }
    let canonical = rpc.block(&tag).await?;
    if quantity(&canonical["number"])? != number || hash(&canonical["hash"])? != block_hash {
        return Err(E::Identity);
    }
    if quantity(&rpc.nonce(&owner, "pending").await?)? != nonce {
        return Err(E::Pending);
    }
    policy(rpc, p, r, signed_expiry_ms.is_none())?;
    let prepared_at_ms = now_ms();
    let mut expires_at_ms = prepared_at_ms
        .saturating_add(300_000)
        .min(r.execution_deadline_ms);
    if let Some(provider_expiry) = r.provider_expires_at_ms {
        expires_at_ms = expires_at_ms.min(provider_expiry);
    }
    if let Some(signed_expiry) = signed_expiry_ms {
        expires_at_ms = expires_at_ms.min(signed_expiry);
    }
    expires_at_ms = expires_at_ms
        .min((r.terms.quote_timestamp as i64 + 300).saturating_mul(1000))
        .min((r.terms.fill_deadline as i64 - 30).saturating_mul(1000));
    let exclusive = i64::from(r.terms.exclusivity_parameter);
    if exclusive <= 31_536_000 {
        expires_at_ms =
            expires_at_ms.min((i64::from(r.terms.fill_deadline) - exclusive).saturating_mul(1000));
    } else {
        expires_at_ms = expires_at_ms.min(exclusive.saturating_mul(1000));
    }
    if expires_at_ms <= prepared_at_ms {
        return Err(E::Invalid);
    }
    let plan = EvmPreparation {
        schema_version: 1,
        provider: PreparationProvider::Across,
        chain_id: r.terms.source_chain.to_string(),
        signer: owner,
        intent_hash: r.intent_hash.clone(),
        registry_revision: r.registry_revision.clone(),
        fee_policy_revision: FEE_POLICY_REVISION.into(),
        quote_reference: Some(r.quote_id.clone()),
        expires_at_ms,
        maximum_network_fee_raw: fee.to_string(),
        maximum_spend: AssetAmount {
            asset_address: Some(token),
            amount_raw: amount.to_string(),
            recipient: spoke.clone(),
        },
        minimum_receive: None,
        fees: vec![],
        simulation: SimulationRecord {
            block_number: number.to_string(),
            block_hash: format!("{block_hash:#x}"),
            calls_hash: calls_hash(&steps).map_err(|_| E::Invalid)?,
            observed_at_ms: prepared_at_ms,
        },
        steps,
    };
    let prepared = PreparedEvm {
        plan,
        first_nonce: nonce.to_string(),
        gas_limits,
        max_fee_per_gas: max_fee.to_string(),
        max_priority_fee_per_gas: priority.to_string(),
    };
    prepared.validate_signing_terms().map_err(|_| E::Invalid)?;
    Ok(prepared)
}
#[cfg(test)]
mod tests;
