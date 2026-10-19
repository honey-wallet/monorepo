//! First concrete Aave V3 execution preparation: Ethereum USDC-style ERC20 supply
//! and finite self-withdrawal. Server-side registry input is mandatory; no broadcast.
use super::evm_rpc::EvmReadRpc;
use crate::preparation::{
    AssetAmount, CallPurpose, EvmCall, EvmPreparation, PreparationProvider, SimulationRecord,
    calls_hash,
};
use alloy_primitives::{Address, B256, U256, keccak256};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub use super::evm_prepare::{
    AAVE_IMPLEMENTATION_SLOT, ContractPin as ImplementationPin,
    EvmPreparationError as AavePreparationError, PreparedEvm as PreparedAave,
    USDC_IMPLEMENTATION_SLOT, encode_call,
};
use super::evm_prepare::{
    Result, abi_address, abi_word, bytes, hex_address, now_ms, quantity, verify_implementation,
    word,
};

/// Operator-approved policy, never derived from a public catalog or request body.
/// Both proxy and implementation pins are mandatory. Governance may still upgrade
/// after the last observation; these checks are not transaction inclusion guards.
pub struct AaveExecutionPolicy {
    pub chain_id: u64,
    pub pool: Address,
    pub asset: Address,
    pub a_token: Address,
    pub decimals: u8,
    pub pool_code_hash: B256,
    pub asset_code_hash: B256,
    pub a_token_code_hash: B256,
    pub pool_implementation: ImplementationPin,
    pub asset_implementation: ImplementationPin,
    pub a_token_implementation: ImplementationPin,
    pub registry_revision: String,
    pub zero_fee_policy_revision: String,
    pub maximum_gas_per_transaction: u64,
    /// Explicit reserve-specific tolerance, in raw aToken units. Simulation must
    /// prove the balance decrease fits; this is not an on-chain min/max parameter.
    pub maximum_atoken_rounding_raw: U256,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AaveAction {
    Supply,
    Withdraw,
}
pub struct AavePrepareRequest {
    pub action: AaveAction,
    pub signer: Address,
    pub amount: U256,
    pub intent_hash: String,
    pub maximum_network_fee: U256,
}
#[tracing::instrument(name = "provider.aave_prepare", skip_all)]
pub async fn prepare(
    rpc: &EvmReadRpc,
    policy: &AaveExecutionPolicy,
    input: AavePrepareRequest,
) -> Result<PreparedAave> {
    // Bounded end-to-end workload, including RPC admission waits. A slow provider
    // cannot retain a task indefinitely. No retry/fallback is hidden here.
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        prepare_inner(rpc, policy, input),
    )
    .await
    .map_err(|_| AavePreparationError::Timeout)?
}
async fn prepare_inner(
    rpc: &EvmReadRpc,
    p: &AaveExecutionPolicy,
    i: AavePrepareRequest,
) -> Result<PreparedAave> {
    if !(p.chain_id == 1 || (p.chain_id == 31337 && rpc.is_loopback()))
        || p.decimals > 18
        || p.maximum_gas_per_transaction < 21000
        || p.maximum_gas_per_transaction > 2_000_000
        || i.amount == U256::ZERO
        || i.amount == U256::MAX
        || i.signer == Address::ZERO
        || i.maximum_network_fee == U256::ZERO
        || [p.pool, p.asset, p.a_token].contains(&Address::ZERO)
        || [
            &p.pool_implementation,
            &p.asset_implementation,
            &p.a_token_implementation,
        ]
        .iter()
        .any(|pin| {
            pin.address == Address::ZERO
                || pin.code_hash == B256::ZERO
                || pin.code_hash == keccak256([])
        })
    {
        return Err(AavePreparationError::Invalid);
    }
    if quantity(&rpc.chain_id().await?)? != U256::from(p.chain_id) {
        return Err(AavePreparationError::Identity);
    }
    let block = rpc.block("latest").await?;
    let number = quantity(&block["number"])?;
    if number > U256::from(u64::MAX) {
        return Err(AavePreparationError::Invalid);
    }
    // Historical snapshots are intentional only on the explicit local fork.
    // A successful RPC response from a stalled production node is not fresh state.
    if p.chain_id == 1 {
        let timestamp = quantity(&block["timestamp"])?;
        let now = U256::from((now_ms() / 1000) as u64);
        if timestamp > U256::from(u64::MAX)
            || timestamp > now + U256::from(15)
            || timestamp + U256::from(120) < now
        {
            return Err(AavePreparationError::Identity);
        }
    }
    let block_tag = format!("{number:#x}");
    let block_hash = block["hash"]
        .as_str()
        .ok_or(AavePreparationError::Invalid)?
        .parse::<B256>()
        .map_err(|_| AavePreparationError::Invalid)?;
    let base_fee = quantity(&block["baseFeePerGas"])?;
    let signer = hex_address(i.signer);
    let pool = hex_address(p.pool);
    let asset = hex_address(p.asset);
    let atoken = hex_address(p.a_token);
    // Every contract/state read below uses one pinned source block. Recheck its
    // canonical hash after simulation to detect a reorg during preparation.
    let codes = futures_util::future::try_join4(
        rpc.code(&signer, &block_tag),
        rpc.code(&pool, &block_tag),
        rpc.code(&asset, &block_tag),
        rpc.code(&atoken, &block_tag),
    )
    .await?;
    if !bytes(&codes.0)?.is_empty()
        || keccak256(bytes(&codes.1)?) != p.pool_code_hash
        || keccak256(bytes(&codes.2)?) != p.asset_code_hash
        || keccak256(bytes(&codes.3)?) != p.a_token_code_hash
    {
        return Err(AavePreparationError::Identity);
    }
    futures_util::future::try_join3(
        verify_implementation(
            rpc,
            &pool,
            AAVE_IMPLEMENTATION_SLOT,
            &p.pool_implementation,
            &block_tag,
        ),
        verify_implementation(
            rpc,
            &asset,
            USDC_IMPLEMENTATION_SLOT,
            &p.asset_implementation,
            &block_tag,
        ),
        verify_implementation(
            rpc,
            &atoken,
            AAVE_IMPLEMENTATION_SLOT,
            &p.a_token_implementation,
            &block_tag,
        ),
    )
    .await?;
    let asset_word = word(p.asset);
    let signer_word = word(i.signer);
    let pool_word = word(p.pool);
    let reserve = abi_address(
        rpc.call(
            &pool,
            &encode_call("getReserveAToken(address)", &[asset_word]),
            &block_tag,
        )
        .await?,
    )?;
    let underlying = abi_address(
        rpc.call(
            &atoken,
            &encode_call("UNDERLYING_ASSET_ADDRESS()", &[]),
            &block_tag,
        )
        .await?,
    )?;
    let owning_pool = abi_address(
        rpc.call(&atoken, &encode_call("POOL()", &[]), &block_tag)
            .await?,
    )?;
    let decimals = abi_word(
        rpc.call(&asset, &encode_call("decimals()", &[]), &block_tag)
            .await?,
    )?;
    let a_decimals = abi_word(
        rpc.call(&atoken, &encode_call("decimals()", &[]), &block_tag)
            .await?,
    )?;
    let config = abi_word(
        rpc.call(
            &pool,
            &encode_call("getConfiguration(address)", &[asset_word]),
            &block_tag,
        )
        .await?,
    )?;
    if reserve != p.a_token
        || underlying != p.asset
        || owning_pool != p.pool
        || decimals != U256::from(p.decimals)
        || a_decimals != decimals
        || ((config >> 48) & U256::from(255)) != decimals
    {
        return Err(AavePreparationError::Identity);
    }
    if !config.bit(56)
        || config.bit(60)
        || (matches!(i.action, AaveAction::Supply) && config.bit(57))
    {
        return Err(AavePreparationError::Restricted);
    }
    let nonce = quantity(&rpc.nonce(&signer, &block_tag).await?)?;
    if nonce != quantity(&rpc.nonce(&signer, "pending").await?)? || nonce >= U256::from(u64::MAX) {
        return Err(AavePreparationError::Pending);
    }
    let balance = abi_word(
        rpc.call(
            if matches!(i.action, AaveAction::Supply) {
                &asset
            } else {
                &atoken
            },
            &encode_call("balanceOf(address)", &[signer_word]),
            &block_tag,
        )
        .await?,
    )?;
    if balance < i.amount
        || quantity(&rpc.balance(&signer, &block_tag).await?)? < i.maximum_network_fee
    {
        return Err(AavePreparationError::Balance);
    }
    let mut steps = Vec::new();
    if matches!(i.action, AaveAction::Supply) {
        let allowance = abi_word(
            rpc.call(
                &asset,
                &encode_call("allowance(address,address)", &[signer_word, pool_word]),
                &block_tag,
            )
            .await?,
        )?;
        if allowance < i.amount {
            // Exact approval, reset first if nonzero; no unlimited/Permit2 approval.
            if allowance != U256::ZERO {
                steps.push(EvmCall {
                    purpose: CallPurpose::Approval,
                    to: asset.clone(),
                    value_raw: "0".into(),
                    data: encode_call("approve(address,uint256)", &[pool_word, [0; 32]]),
                });
            }
            steps.push(EvmCall {
                purpose: CallPurpose::Approval,
                to: asset.clone(),
                value_raw: "0".into(),
                data: encode_call(
                    "approve(address,uint256)",
                    &[pool_word, i.amount.to_be_bytes()],
                ),
            });
        }
    }
    let data = match i.action {
        AaveAction::Supply => encode_call(
            "supply(address,uint256,address,uint16)",
            &[asset_word, i.amount.to_be_bytes(), signer_word, [0; 32]],
        ),
        AaveAction::Withdraw => encode_call(
            "withdraw(address,uint256,address)",
            &[asset_word, i.amount.to_be_bytes(), signer_word],
        ),
    };
    steps.push(EvmCall {
        purpose: CallPurpose::Action,
        to: pool,
        value_raw: "0".into(),
        data,
    });
    if nonce + U256::from(steps.len()) > U256::from(u64::MAX) {
        return Err(AavePreparationError::Pending);
    }
    let withdrawal = matches!(i.action, AaveAction::Withdraw);
    let maximum_spend = if withdrawal {
        i.amount
            .checked_add(p.maximum_atoken_rounding_raw)
            .ok_or(AavePreparationError::Invalid)?
    } else {
        i.amount
    };
    let mut calls: Vec<Value>=steps.iter().map(|s|json!({"from":signer,"to":s.to,"data":s.data,"value":"0x0","gas":format!("0x{:x}",p.maximum_gas_per_transaction)})).collect();
    if withdrawal {
        let read = json!({"from":signer,"to":atoken,"data":encode_call("balanceOf(address)", &[signer_word]),"value":"0x0","gas":"0x186a0"});
        calls.insert(0, read.clone());
        calls.push(read);
    }
    let simulation = rpc.simulate(calls, &block_tag).await?;
    let blocks = simulation
        .as_array()
        .filter(|b| b.len() == 1)
        .ok_or(AavePreparationError::Simulation)?;
    if blocks[0]["parentHash"].as_str() != Some(&format!("{block_hash:#x}")) {
        return Err(AavePreparationError::Simulation);
    }
    let results = blocks[0]["calls"]
        .as_array()
        .filter(|c| c.len() == steps.len() + if withdrawal { 2 } else { 0 })
        .ok_or(AavePreparationError::Simulation)?;
    let results = if withdrawal {
        let before = &results[0];
        let after = &results[results.len() - 1];
        if before["status"] != "0x1"
            || after["status"] != "0x1"
            || before.get("error").is_some()
            || after.get("error").is_some()
        {
            return Err(AavePreparationError::Simulation);
        }
        let before = abi_word(before["returnData"].clone())?;
        let after = abi_word(after["returnData"].clone())?;
        if before.saturating_sub(after) > maximum_spend {
            return Err(AavePreparationError::Simulation);
        }
        &results[1..results.len() - 1]
    } else {
        results.as_slice()
    };
    let mut gas_limits = Vec::new();
    let mut total_gas = U256::ZERO;
    for (step, result) in steps.iter().zip(results) {
        if result["status"] != "0x1" || result.get("error").is_some() {
            return Err(AavePreparationError::Simulation);
        }
        if step.purpose == CallPurpose::Approval
            && abi_word(result["returnData"].clone())? != U256::from(1)
        {
            return Err(AavePreparationError::Simulation);
        }
        let used = quantity(&result["gasUsed"])?;
        if used < U256::from(21000) {
            return Err(AavePreparationError::Simulation);
        }
        let gas = used
            .checked_mul(U256::from(120))
            .and_then(|v| v.checked_div(U256::from(100)))
            .and_then(|v| v.checked_add(U256::from(10000)))
            .ok_or(AavePreparationError::Fees)?;
        if gas > U256::from(p.maximum_gas_per_transaction) {
            return Err(AavePreparationError::Fees);
        }
        total_gas = total_gas
            .checked_add(gas)
            .ok_or(AavePreparationError::Fees)?;
        gas_limits.push(gas.to_string());
    }
    if matches!(i.action, AaveAction::Withdraw)
        && abi_word(results.last().ok_or(AavePreparationError::Simulation)?["returnData"].clone())?
            != i.amount
    {
        return Err(AavePreparationError::Simulation);
    }
    let priority = quantity(&rpc.priority_fee().await?)?;
    let max_fee = base_fee
        .checked_mul(U256::from(2))
        .and_then(|v| v.checked_add(priority))
        .ok_or(AavePreparationError::Fees)?;
    if max_fee > U256::from(u128::MAX) || priority > U256::from(u128::MAX) {
        return Err(AavePreparationError::Fees);
    }
    let maximum_fee = total_gas
        .checked_mul(max_fee)
        .ok_or(AavePreparationError::Fees)?;
    if maximum_fee > i.maximum_network_fee {
        return Err(AavePreparationError::Fees);
    }
    if rpc.block(&block_tag).await?["hash"] != block["hash"] {
        return Err(AavePreparationError::Identity);
    }
    let now = now_ms();
    let plan = EvmPreparation {
        schema_version: 1,
        provider: PreparationProvider::AaveV3,
        chain_id: p.chain_id.to_string(),
        signer: signer.clone(),
        intent_hash: i.intent_hash,
        registry_revision: p.registry_revision.clone(),
        fee_policy_revision: p.zero_fee_policy_revision.clone(),
        quote_reference: None,
        expires_at_ms: now + 120000,
        maximum_network_fee_raw: maximum_fee.to_string(),
        maximum_spend: AssetAmount {
            asset_address: Some(match i.action {
                AaveAction::Supply => asset.clone(),
                AaveAction::Withdraw => atoken.clone(),
            }),
            amount_raw: maximum_spend.to_string(),
            recipient: signer.clone(),
        },
        // aToken scaled accounting rounds; an exact mint minimum is not enforced
        // by Pool.supply. Do not represent a nominal deposit as a guaranteed mint.
        minimum_receive: matches!(i.action, AaveAction::Withdraw).then_some(AssetAmount {
            asset_address: Some(asset),
            amount_raw: i.amount.to_string(),
            recipient: signer,
        }),
        fees: vec![],
        simulation: SimulationRecord {
            block_number: number.to_string(),
            block_hash: format!("{block_hash:#x}"),
            calls_hash: calls_hash(&steps).map_err(|_| AavePreparationError::Invalid)?,
            observed_at_ms: now,
        },
        steps,
    };
    plan.validate().map_err(|_| AavePreparationError::Invalid)?;
    Ok(PreparedAave {
        plan,
        first_nonce: nonce.to_string(),
        gas_limits,
        max_fee_per_gas: max_fee.to_string(),
        max_priority_fee_per_gas: priority.to_string(),
    })
}
