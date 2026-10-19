//! Ethereum CLASSIC preparation from immutable review and independently verified
//! calldata. Registry/RPC are trusted operator inputs; no HTTP or broadcast here.
use super::{
    evm_prepare::{
        self, ContractPin, EvmPreparationError as E, PreparedEvm, abi_word, bytes, encode_call,
        hex_address, now_ms, quantity, verify_implementation, word,
    },
    evm_rpc::EvmReadRpc,
    uniswap::VerifiedSwapBuild,
};
use crate::{
    preparation::{
        AssetAmount, CallPurpose, EvmCall, EvmPreparation, FeeKind, PlanFee, PreparationProvider,
        SimulationRecord, calls_hash,
    },
    swap_review::{PermitNonceObservation, SwapReview},
};
use alloy_primitives::{Address, B256, U256, keccak256};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, time::Duration};
type Result<T> = std::result::Result<T, E>;

/// Explicitly reviewed proxy family. No arbitrary slot supplied by a user.
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    content = "implementation",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum TokenCode {
    Direct,
    Eip1967(ContractPin),
    Usdc(ContractPin),
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwapTokenPin {
    pub contract: ContractPin,
    pub decimals: u8,
    /// Explicit registry opt-in for legacy ERC20 approve() with no return value.
    pub allow_empty_approval_return: bool,
    pub code: TokenCode,
}
/// Registry approval must bind these dependency addresses to the pinned router's
/// constructor/immutable parameters. Merely discovering on-chain hashes is not
/// registry approval. Only standard, non-rebasing/non-tax ERC20s are supported.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UniswapExecutionPolicy {
    pub chain_id: u64,
    pub router: ContractPin,
    pub permit2: ContractPin,
    pub v2_factory: ContractPin,
    pub v3_factory: ContractPin,
    pub pool_manager: ContractPin,
    pub wrapped_native: ContractPin,
    pub tokens: Vec<SwapTokenPin>,
    pub registry_revision: String,
    pub fee_policy_revision: String,
    pub maximum_gas_per_transaction: u64,
    pub maximum_quote_block_lag: u64,
}
/// Private evidence produced only by pinned RPC observation. Never deserialize
/// this from an HTTP request or treat it as lasting approval to submit.
pub struct SwapChainObservation {
    block_number: U256,
    block_hash: B256,
    block_timestamp: u64,
    finalized_number: U256,
    finalized_hash: B256,
    finalized_timestamp: u64,
    base_fee: U256,
    nonce: U256,
    permit_nonce: u64,
    permit_amount: U256,
    permit_expiration: u64,
    erc20_allowance: U256,
    input_balance: U256,
    native_balance: U256,
    observed_at_ms: i64,
    review_hash: String,
}
impl SwapChainObservation {
    pub fn requires_erc20_approval(&self, review: &SwapReview) -> Result<bool> {
        self.bind(review)?;
        Ok(self.erc20_allowance < decimal(&review.authority.maximum_input_raw)?)
    }
    pub fn permit_observation(&self, review: &SwapReview) -> Result<PermitNonceObservation> {
        self.bind(review)?;
        Ok(PermitNonceObservation {
            chain_id: review.authority.chain_id.parse().map_err(|_| E::Invalid)?,
            permit2: addr(&review.permit2)?,
            owner: addr(&review.authority.owner)?,
            token: addr(&review.authority.token_in)?,
            spender: addr(&review.authority.router)?,
            nonce: self.permit_nonce,
            observed_at_ms: self.observed_at_ms,
            finalized_block_timestamp: self.finalized_timestamp,
        })
    }
    fn bind(&self, review: &SwapReview) -> Result<()> {
        if self.review_hash != review.integrity_hash().map_err(|_| E::Invalid)?
            || now_ms() < self.observed_at_ms
            || now_ms() - self.observed_at_ms > 10_000
        {
            return Err(E::Pending);
        }
        Ok(())
    }
}
/// Produced only after fresh chain checks and successful whole-sequence simulation.
/// PreparedEvm remains sensitive; this result deliberately has no Debug/Serialize.
pub struct PreparedSwap {
    prepared: PreparedEvm,
    review_hash: String,
    build_request_id: String,
}
impl PreparedSwap {
    pub fn prepared(&self) -> &PreparedEvm {
        &self.prepared
    }
    pub fn review_hash(&self) -> &str {
        &self.review_hash
    }
    pub fn build_request_id(&self) -> &str {
        &self.build_request_id
    }
}
fn addr(s: &str) -> Result<Address> {
    s.parse().map_err(|_| E::Invalid)
}
fn decimal(s: &str) -> Result<U256> {
    let n = U256::from_str_radix(s, 10).map_err(|_| E::Invalid)?;
    if n.to_string() != s {
        return Err(E::Invalid);
    }
    Ok(n)
}
fn hash(v: &Value) -> Result<B256> {
    let value: B256 = v
        .as_str()
        .ok_or(E::Identity)?
        .parse()
        .map_err(|_| E::Identity)?;
    if value == B256::ZERO {
        return Err(E::Identity);
    }
    Ok(value)
}
fn valid_pin(p: &ContractPin) -> bool {
    p.address != Address::ZERO && p.code_hash != B256::ZERO && p.code_hash != keccak256([])
}
fn policy(rpc: &EvmReadRpc, p: &UniswapExecutionPolicy, r: &SwapReview) -> Result<()> {
    r.validate().map_err(|_| E::Invalid)?;
    let now = now_ms();
    if !(p.chain_id == 1 || p.chain_id == 31337 && rpc.is_loopback())
        || r.authority.chain_id != p.chain_id.to_string()
        || r.authority.router != hex_address(p.router.address)
        || r.permit2 != hex_address(p.permit2.address)
        || r.registry_revision != p.registry_revision
        || r.fee_policy_revision != p.fee_policy_revision
        || now < r.reviewed_at_ms
        || now >= r.expires_at_ms
        || !(21000..=2_000_000).contains(&p.maximum_gas_per_transaction)
        || !(1..=128).contains(&p.maximum_quote_block_lag)
        || !(2..=64).contains(&p.tokens.len())
        || p.tokens
            .iter()
            .map(|t| hex_address(t.contract.address))
            .collect::<Vec<_>>()
            != r.authority.tokens
    {
        return Err(E::Invalid);
    }
    let dependencies = [
        &p.router,
        &p.permit2,
        &p.v2_factory,
        &p.v3_factory,
        &p.pool_manager,
        &p.wrapped_native,
    ];
    if dependencies.iter().any(|p| !valid_pin(p))
        || dependencies
            .iter()
            .map(|p| p.address)
            .collect::<BTreeSet<_>>()
            .len()
            != dependencies.len()
    {
        return Err(E::Invalid);
    }
    for token in &p.tokens {
        if !valid_pin(&token.contract) || token.decimals > 36 {
            return Err(E::Invalid);
        }
        match &token.code {
            TokenCode::Direct => {}
            TokenCode::Eip1967(pin) | TokenCode::Usdc(pin) => {
                if !valid_pin(pin) || pin.address == token.contract.address {
                    return Err(E::Invalid);
                }
            }
        }
    }
    Ok(())
}
async fn pin(rpc: &EvmReadRpc, p: &ContractPin, tag: &str) -> Result<()> {
    let code = bytes(&rpc.code(&hex_address(p.address), tag).await?)?;
    if code.is_empty() || keccak256(&code) != p.code_hash {
        return Err(E::Identity);
    }
    Ok(())
}
fn permit_allowance(value: Value) -> Result<(U256, u64, u64)> {
    let b = bytes(&value)?;
    if b.len() != 96 {
        return Err(E::Identity);
    }
    let amount = U256::from_be_slice(&b[..32]);
    let expiration = U256::from_be_slice(&b[32..64]);
    let nonce = U256::from_be_slice(&b[64..]);
    if amount >= U256::from(1).wrapping_shl(160)
        || expiration >= U256::from(1).wrapping_shl(48)
        || nonce >= U256::from(1).wrapping_shl(48)
    {
        return Err(E::Identity);
    }
    Ok((amount, expiration.to::<u64>(), nonce.to::<u64>()))
}
async fn canonical(rpc: &EvmReadRpc, s: &SwapChainObservation) -> Result<()> {
    let head_tag = format!("{:#x}", s.block_number);
    let finalized_tag = format!("{:#x}", s.finalized_number);
    let (head, finalized) = tokio::try_join!(rpc.block(&head_tag), rpc.block(&finalized_tag))?;
    if hash(&head["hash"])? != s.block_hash
        || quantity(&head["number"])? != s.block_number
        || hash(&finalized["hash"])? != s.finalized_hash
        || quantity(&finalized["number"])? != s.finalized_number
    {
        return Err(E::Identity);
    }
    Ok(())
}
/// Fresh pinned observations for both permit admission and build preparation.
/// The same reviewed authority is bound to the result; no nonce comes from a client.
#[tracing::instrument(name = "provider.uniswap_observe", skip_all)]
pub async fn observe(
    rpc: &EvmReadRpc,
    p: &UniswapExecutionPolicy,
    r: &SwapReview,
    quote_block: &str,
) -> Result<SwapChainObservation> {
    tokio::time::timeout(
        Duration::from_secs(60),
        observe_inner(rpc, p, r, quote_block),
    )
    .await
    .map_err(|_| E::Timeout)?
}
async fn observe_inner(
    rpc: &EvmReadRpc,
    p: &UniswapExecutionPolicy,
    r: &SwapReview,
    quote_block: &str,
) -> Result<SwapChainObservation> {
    policy(rpc, p, r)?;
    if quantity(&rpc.chain_id().await?)? != U256::from(p.chain_id) {
        return Err(E::Identity);
    }
    let (head, finalized) = tokio::try_join!(rpc.block("latest"), rpc.block("finalized"))?;
    let block_number = quantity(&head["number"])?;
    let finalized_number = quantity(&finalized["number"])?;
    let quote = decimal(quote_block)?;
    let timestamp = quantity(&head["timestamp"])?;
    let final_time = quantity(&finalized["timestamp"])?;
    let now = U256::from((now_ms() / 1000) as u64);
    if block_number > U256::from(u64::MAX)
        || finalized_number > block_number
        || timestamp > now + U256::from(15)
        || final_time > now
        || final_time > timestamp
        || final_time == U256::ZERO
        || timestamp > U256::from(u64::MAX)
        || quote > block_number
        || block_number - quote > U256::from(p.maximum_quote_block_lag)
        || (p.chain_id == 1 && timestamp + U256::from(120) < now)
    {
        return Err(E::Identity);
    }
    let tag = format!("{block_number:#x}");
    let owner = &r.authority.owner;
    if !bytes(&rpc.code(owner, &tag).await?)?.is_empty() {
        return Err(E::Identity);
    }
    // Sequential reads stay within the shared transport's bounded admission. This
    // intentionally checks the entire finite approved token vocabulary, not just
    // addresses claimed by the provider route metadata.
    for contract in [
        &p.router,
        &p.permit2,
        &p.v2_factory,
        &p.v3_factory,
        &p.pool_manager,
        &p.wrapped_native,
    ] {
        pin(rpc, contract, &tag).await?;
    }
    for token in &p.tokens {
        pin(rpc, &token.contract, &tag).await?;
        let contract = hex_address(token.contract.address);
        match &token.code {
            TokenCode::Direct => {}
            TokenCode::Eip1967(pin) => {
                verify_implementation(
                    rpc,
                    &contract,
                    evm_prepare::AAVE_IMPLEMENTATION_SLOT,
                    pin,
                    &tag,
                )
                .await?
            }
            TokenCode::Usdc(pin) => {
                verify_implementation(
                    rpc,
                    &contract,
                    evm_prepare::USDC_IMPLEMENTATION_SLOT,
                    pin,
                    &tag,
                )
                .await?
            }
        }
        if abi_word(
            rpc.call(&contract, &encode_call("decimals()", &[]), &tag)
                .await?,
        )? != U256::from(token.decimals)
        {
            return Err(E::Identity);
        }
    }
    let signer = addr(owner)?;
    let token = addr(&r.authority.token_in)?;
    let permit_call = encode_call(
        "allowance(address,address,address)",
        &[word(signer), word(token), word(p.router.address)],
    );
    let allowance_call = encode_call(
        "allowance(address,address)",
        &[word(signer), word(p.permit2.address)],
    );
    let balance_call = encode_call("balanceOf(address)", &[word(signer)]);
    let observed_at_ms = now_ms();
    let (nonce, pending, permit, native) = tokio::try_join!(
        rpc.nonce(owner, &tag),
        rpc.nonce(owner, "pending"),
        rpc.call(&r.permit2, &permit_call, &tag),
        rpc.balance(owner, &tag)
    )?;
    let nonce = quantity(&nonce)?;
    if nonce != quantity(&pending)? || nonce >= U256::from(u64::MAX) {
        return Err(E::Pending);
    }
    let (permit_amount, permit_expiration, permit_nonce) = permit_allowance(permit)?;
    let (allowance, balance) = tokio::try_join!(
        rpc.call(&r.authority.token_in, &allowance_call, &tag),
        rpc.call(&r.authority.token_in, &balance_call, &tag)
    )?;
    let amount = decimal(&r.authority.maximum_input_raw)?;
    let input_balance = abi_word(balance)?;
    if input_balance < amount {
        return Err(E::Balance);
    }
    if let Some(permit) = &r.permit {
        if permit_nonce == (1u64 << 48) - 1 || permit.nonce != permit_nonce.to_string() {
            return Err(E::Pending);
        }
    } else if permit_amount < amount || permit_expiration < (r.expires_at_ms / 1000) as u64 {
        return Err(E::Pending);
    }
    let s = SwapChainObservation {
        block_number,
        block_hash: hash(&head["hash"])?,
        block_timestamp: timestamp.to::<u64>(),
        finalized_number,
        finalized_hash: hash(&finalized["hash"])?,
        finalized_timestamp: final_time.to::<u64>(),
        base_fee: quantity(&head["baseFeePerGas"])?,
        nonce,
        permit_nonce,
        permit_amount,
        permit_expiration,
        erc20_allowance: abi_word(allowance)?,
        input_balance,
        native_balance: quantity(&native)?,
        observed_at_ms,
        review_hash: r.integrity_hash().map_err(|_| E::Invalid)?,
    };
    canonical(rpc, &s).await?;
    if p.chain_id == 1 && (now_ms() / 1000) as u64 > s.block_timestamp.saturating_add(120) {
        return Err(E::Identity);
    }
    s.bind(r)?;
    policy(rpc, p, r)?;
    Ok(s)
}
fn read_balance(token: &str, owner: &str, from: &str) -> Result<Value> {
    Ok(
        json!({"from":from,"to":token,"data":encode_call("balanceOf(address)",&[word(addr(owner)?)]),"value":"0x0","gas":"0x186a0"}),
    )
}
fn output(result: &Value) -> Result<U256> {
    if result["status"] != "0x1" || result.get("error").is_some() {
        return Err(E::Simulation);
    }
    abi_word(result["returnData"].clone()).map_err(|_| E::Simulation)
}
/// Local simulation is mandatory even if a provider returned gas or simulation
/// success. This result contains no signed Ethereum transaction and cannot broadcast.
#[tracing::instrument(name = "provider.uniswap_prepare", skip_all)]
pub async fn prepare(
    rpc: &EvmReadRpc,
    p: &UniswapExecutionPolicy,
    r: &SwapReview,
    build: &VerifiedSwapBuild,
) -> Result<PreparedSwap> {
    let remaining = r.expires_at_ms.saturating_sub(now_ms());
    if remaining <= 0 {
        return Err(E::Invalid);
    }
    tokio::time::timeout(
        Duration::from_millis((remaining as u64).min(60_000)),
        prepare_inner(rpc, p, r, build),
    )
    .await
    .map_err(|_| E::Timeout)?
}
async fn prepare_inner(
    rpc: &EvmReadRpc,
    p: &UniswapExecutionPolicy,
    r: &SwapReview,
    build: &VerifiedSwapBuild,
) -> Result<PreparedSwap> {
    if build.review_hash() != r.integrity_hash().map_err(|_| E::Invalid)?
        || build.quote_id() != r.quote_id
    {
        return Err(E::Invalid);
    }
    let s = observe_inner(rpc, p, r, build.source_block()).await?;
    let amount = decimal(&r.authority.maximum_input_raw)?;
    let mut steps = Vec::new();
    if s.erc20_allowance < amount {
        if s.erc20_allowance != U256::ZERO {
            steps.push(EvmCall {
                purpose: CallPurpose::Approval,
                to: r.authority.token_in.clone(),
                value_raw: "0".into(),
                data: encode_call(
                    "approve(address,uint256)",
                    &[word(p.permit2.address), [0; 32]],
                ),
            });
        }
        steps.push(EvmCall {
            purpose: CallPurpose::Approval,
            to: r.authority.token_in.clone(),
            value_raw: "0".into(),
            data: encode_call(
                "approve(address,uint256)",
                &[word(p.permit2.address), amount.to_be_bytes()],
            ),
        });
    }
    let call = build.call();
    steps.push(EvmCall {
        purpose: CallPurpose::Action,
        to: call.to.clone(),
        value_raw: call.value_raw.clone(),
        data: call.data.to_string(),
    });
    if s.nonce + U256::from(steps.len()) > U256::from(u64::MAX) {
        return Err(E::Pending);
    }
    // Read exact before/after balances inside the same simulated block. This
    // catches net-debit/output or fee anomalies that success status alone misses.
    let owner = &r.authority.owner;
    let mut accounts = vec![
        (r.authority.token_in.clone(), owner.clone()),
        (r.authority.token_out.clone(), owner.clone()),
    ];
    accounts.extend(
        r.authority
            .fees
            .iter()
            .map(|f| (r.authority.token_out.clone(), f.recipient.clone())),
    );
    accounts.extend(
        r.authority
            .tokens
            .iter()
            .map(|t| (t.clone(), r.authority.router.clone())),
    );
    let reads = accounts
        .iter()
        .map(|(token, account)| read_balance(token, account, owner))
        .collect::<Result<Vec<_>>>()?;
    let mut calls = reads.clone();
    calls.extend(steps.iter().map(|c|json!({"from":owner,"to":c.to,"data":c.data,"value":"0x0","gas":format!("0x{:x}",p.maximum_gas_per_transaction)})));
    calls.extend(reads);
    // Also prove the resulting Permit2 nonce/allowance after the action, using a
    // read call rather than trusting events or inferred nonce increments.
    calls.push(json!({"from":owner,"to":r.permit2,"data":encode_call("allowance(address,address,address)",&[word(addr(owner)?),word(addr(&r.authority.token_in)?),word(p.router.address)]),"value":"0x0","gas":"0x186a0"}));
    let simulation = rpc
        .simulate(calls, &format!("{:#x}", s.block_number))
        .await?;
    let blocks = simulation
        .as_array()
        .filter(|b| b.len() == 1)
        .ok_or(E::Simulation)?;
    if hash(&blocks[0]["parentHash"])? != s.block_hash {
        return Err(E::Simulation);
    }
    let simulated_time = quantity(&blocks[0]["timestamp"])?;
    if simulated_time <= U256::from(s.block_timestamp)
        || simulated_time >= U256::from((r.expires_at_ms / 1000) as u64)
    {
        return Err(E::Simulation);
    }
    let results = blocks[0]["calls"]
        .as_array()
        .filter(|c| c.len() == accounts.len() * 2 + steps.len() + 1)
        .ok_or(E::Simulation)?;
    let after = accounts.len() + steps.len();
    let before_values = results[..accounts.len()]
        .iter()
        .map(output)
        .collect::<Result<Vec<_>>>()?;
    let after_values = results[after..after + accounts.len()]
        .iter()
        .map(output)
        .collect::<Result<Vec<_>>>()?;
    if before_values[0] != s.input_balance
        || after_values[0] > before_values[0]
        || before_values[0] - after_values[0] > amount
        || after_values[1] < before_values[1]
        || after_values[1] - before_values[1] < decimal(&r.authority.minimum_output_raw)?
    {
        return Err(E::Simulation);
    }
    let mut gross = after_values[1] - before_values[1];
    let mut actual_fees = Vec::new();
    for (index, fee) in r.authority.fees.iter().enumerate() {
        let index = index + 2;
        if after_values[index] < before_values[index] {
            return Err(E::Simulation);
        }
        let paid = after_values[index] - before_values[index];
        gross = gross.checked_add(paid).ok_or(E::Simulation)?;
        actual_fees.push((fee, paid));
    }
    for (fee, paid) in &actual_fees {
        // Division-first floor avoids overflow at uint256 output magnitudes.
        let bps = decimal(&fee.maximum_bps)?;
        let bound = (gross / U256::from(10000))
            .checked_mul(bps)
            .and_then(|n| n.checked_add((gross % U256::from(10000)) * bps / U256::from(10000)))
            .and_then(|n| n.checked_add(decimal(&fee.maximum_rounding_raw).ok()?))
            .ok_or(E::Simulation)?;
        if *paid > bound {
            return Err(E::Simulation);
        }
    }
    for index in 2 + r.authority.fees.len()..accounts.len() {
        if after_values[index] > before_values[index] {
            return Err(E::Simulation);
        }
    }
    let last = results.last().ok_or(E::Simulation)?;
    if last["status"] != "0x1" || last.get("error").is_some() {
        return Err(E::Simulation);
    }
    let (remaining, expiration, nonce) = permit_allowance(last["returnData"].clone())?;
    let expected_amount = if r.permit.is_some() {
        amount
    } else {
        s.permit_amount
    };
    let expected_expiration = if let Some(permit) = &r.permit {
        permit.expiration.parse::<u64>().map_err(|_| E::Invalid)?
    } else {
        s.permit_expiration
    };
    let expected_nonce = s
        .permit_nonce
        .checked_add(u64::from(r.permit.is_some()))
        .filter(|n| *n < (1u64 << 48))
        .ok_or(E::Pending)?;
    // Permit2 treats uint160 MAX as unlimited and does not decrement it. Existing
    // unlimited authority may be consumed, but this flow never creates it.
    let unlimited = U256::from(1).wrapping_shl(160) - U256::from(1);
    if nonce != expected_nonce
        || expiration != expected_expiration
        || remaining > expected_amount
        || (expected_amount == unlimited && remaining != unlimited)
        || (expected_amount != unlimited && expected_amount - remaining > amount)
    {
        return Err(E::Simulation);
    }
    let input_policy = p
        .tokens
        .iter()
        .find(|t| hex_address(t.contract.address) == r.authority.token_in)
        .ok_or(E::Identity)?;
    let mut gas_limits = Vec::new();
    let mut total_gas = U256::ZERO;
    for (step, result) in steps.iter().zip(&results[accounts.len()..after]) {
        if result["status"] != "0x1" || result.get("error").is_some() {
            return Err(E::Simulation);
        }
        if step.purpose == CallPurpose::Approval
            && !(input_policy.allow_empty_approval_return && result["returnData"] == "0x")
            && abi_word(result["returnData"].clone())? != U256::from(1)
        {
            return Err(E::Simulation);
        }
        let used = quantity(&result["gasUsed"])?;
        if used < U256::from(21000) {
            return Err(E::Simulation);
        }
        let gas = used
            .checked_mul(U256::from(120))
            .and_then(|n| n.checked_div(U256::from(100)))
            .and_then(|n| n.checked_add(U256::from(10000)))
            .filter(|n| *n <= U256::from(p.maximum_gas_per_transaction))
            .ok_or(E::Fees)?;
        total_gas = total_gas.checked_add(gas).ok_or(E::Fees)?;
        gas_limits.push(gas.to_string());
    }
    let priority = quantity(&rpc.priority_fee().await?)?;
    let max_fee = s
        .base_fee
        .checked_mul(U256::from(2))
        .and_then(|n| n.checked_add(priority))
        .filter(|n| *n <= U256::from(u128::MAX))
        .ok_or(E::Fees)?;
    let maximum_fee = total_gas.checked_mul(max_fee).ok_or(E::Fees)?;
    if maximum_fee > decimal(&r.maximum_network_fee_raw)?
        || maximum_fee > s.native_balance
        || max_fee == U256::ZERO
    {
        return Err(E::Fees);
    }
    canonical(rpc, &s).await?;
    if p.chain_id == 1 && (now_ms() / 1000) as u64 > s.block_timestamp.saturating_add(120) {
        return Err(E::Identity);
    }
    if quantity(&rpc.nonce(owner, "pending").await?)? != s.nonce {
        return Err(E::Pending);
    }
    policy(rpc, p, r)?;
    let observed = now_ms();
    let plan = EvmPreparation {
        schema_version: 1,
        provider: PreparationProvider::Uniswap,
        chain_id: r.authority.chain_id.clone(),
        signer: owner.clone(),
        intent_hash: r.intent_hash.clone(),
        registry_revision: r.registry_revision.clone(),
        fee_policy_revision: r.fee_policy_revision.clone(),
        quote_reference: Some(r.quote_id.clone()),
        expires_at_ms: r.expires_at_ms,
        maximum_network_fee_raw: maximum_fee.to_string(),
        maximum_spend: AssetAmount {
            asset_address: Some(r.authority.token_in.clone()),
            amount_raw: amount.to_string(),
            recipient: owner.clone(),
        },
        minimum_receive: Some(AssetAmount {
            asset_address: Some(r.authority.token_out.clone()),
            amount_raw: r.authority.minimum_output_raw.clone(),
            recipient: owner.clone(),
        }),
        // Point-in-time simulated fees, not a bound. The separate immutable review
        // remains the source of percentage/rounding authority for wallet consent.
        fees: actual_fees
            .into_iter()
            .map(|(fee, paid)| PlanFee {
                kind: FeeKind::App,
                amount: AssetAmount {
                    asset_address: Some(r.authority.token_out.clone()),
                    amount_raw: paid.to_string(),
                    recipient: fee.recipient.clone(),
                },
            })
            .collect(),
        simulation: SimulationRecord {
            block_number: s.block_number.to_string(),
            block_hash: format!("{:#x}", s.block_hash),
            calls_hash: calls_hash(&steps).map_err(|_| E::Invalid)?,
            observed_at_ms: observed,
        },
        steps,
    };
    let prepared = PreparedEvm {
        plan,
        first_nonce: s.nonce.to_string(),
        gas_limits,
        max_fee_per_gas: max_fee.to_string(),
        max_priority_fee_per_gas: priority.to_string(),
    };
    prepared.validate_signing_terms().map_err(|_| E::Invalid)?;
    Ok(PreparedSwap {
        prepared,
        review_hash: build.review_hash().into(),
        build_request_id: build.request_id().into(),
    })
}

#[cfg(test)]
pub(crate) mod tests;
