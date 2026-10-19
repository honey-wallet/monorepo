//! Curated Ethereum Vault V2 through VaultBundlesV1. No arbitrary vaults or permits.
use super::{evm_prepare::*, evm_rpc::EvmReadRpc};
use crate::preparation::{
    AssetAmount, CallPurpose, EvmCall, EvmPreparation, PreparationProvider, SimulationRecord,
    calls_hash,
};
use alloy_primitives::{Address, B256, U256, keccak256};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MorphoExecutionPolicy {
    pub chain_id: u64,
    pub vault: ContractPin,
    pub bundle: ContractPin,
    pub asset: ContractPin,
    pub asset_implementation: ContractPin,
    pub asset_decimals: u8,
    pub share_decimals: u8,
    #[serde(with = "address_serde")]
    pub owner: Address,
    #[serde(with = "address_serde")]
    pub curator: Address,
    pub adapters: Vec<ContractPin>,
    #[serde(with = "address_serde")]
    pub adapter_registry: Address,
    #[serde(with = "address_serde")]
    pub liquidity_adapter: Address,
    #[serde(with = "hash_serde")]
    pub liquidity_data_hash: B256,
    #[serde(with = "uint_serde")]
    pub performance_fee_wad: U256,
    #[serde(with = "uint_serde")]
    pub management_fee_per_second_wad: U256,
    #[serde(with = "address_serde")]
    pub performance_fee_recipient: Address,
    #[serde(with = "address_serde")]
    pub management_fee_recipient: Address,
    pub registry_revision: String,
    pub zero_fee_policy_revision: String,
    pub maximum_gas_per_transaction: u64,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MorphoAction {
    Deposit,
    Redeem,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MorphoQuote {
    pub action: MorphoAction,
    pub amount_raw: String,
    pub signer: String,
    pub chain_id: String,
    pub vault: String,
    pub asset: String,
    pub asset_balance_raw: String,
    pub share_balance_raw: String,
    pub preview_assets_raw: String,
    pub preview_shares_raw: String,
    pub registry_revision: String,
    pub fee_policy_revision: String,
    pub block_number: String,
    pub block_hash: String,
    pub observed_at_ms: i64,
    pub expires_at_ms: i64,
}
/// Read-only sizing aid. The execution worker independently checks the complete
/// registry/gates/liquidity and simulates the exact signed call sequence.
pub async fn quote(
    rpc: &EvmReadRpc,
    p: &MorphoExecutionPolicy,
    signer: Address,
    action: MorphoAction,
    amount: U256,
) -> Result<MorphoQuote> {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        if amount == U256::ZERO
            || amount == U256::MAX
            || signer == Address::ZERO
            || p.chain_id != 31337
            || !rpc.is_loopback()
        {
            return Err(EvmPreparationError::Invalid);
        }
        if quantity(&rpc.chain_id().await?)? != U256::from(p.chain_id) {
            return Err(EvmPreparationError::Identity);
        }
        let block = rpc.block("latest").await?;
        let number = quantity(&block["number"])?;
        if number > U256::from(u64::MAX) {
            return Err(EvmPreparationError::Invalid);
        }
        let hash = block["hash"]
            .as_str()
            .and_then(|s| s.parse::<B256>().ok())
            .ok_or(EvmPreparationError::Invalid)?;
        let tag = format!("{number:#x}");
        let vault = hex_address(p.vault.address);
        let asset = hex_address(p.asset.address);
        verify_code(rpc, &p.vault, &tag).await?;
        verify_code(rpc, &p.asset, &tag).await?;
        verify_implementation(
            rpc,
            &asset,
            USDC_IMPLEMENTATION_SLOT,
            &p.asset_implementation,
            &tag,
        )
        .await?;
        if read_address(rpc, &vault, "asset()", &[], &tag).await? != p.asset.address
            || read_word(rpc, &vault, "performanceFee()", &[], &tag).await? != p.performance_fee_wad
            || read_word(rpc, &vault, "managementFee()", &[], &tag).await?
                != p.management_fee_per_second_wad
        {
            return Err(EvmPreparationError::Identity);
        }
        let asset_balance =
            read_word(rpc, &asset, "balanceOf(address)", &[word(signer)], &tag).await?;
        let share_balance =
            read_word(rpc, &vault, "balanceOf(address)", &[word(signer)], &tag).await?;
        let preview = read_word(
            rpc,
            &vault,
            if action == MorphoAction::Deposit {
                "previewDeposit(uint256)"
            } else {
                "previewRedeem(uint256)"
            },
            &[amount.to_be_bytes()],
            &tag,
        )
        .await?;
        if preview == U256::ZERO {
            return Err(EvmPreparationError::Simulation);
        }
        if rpc.block(&tag).await?["hash"] != block["hash"] {
            return Err(EvmPreparationError::Identity);
        }
        let now = now_ms();
        Ok(MorphoQuote {
            action,
            amount_raw: amount.to_string(),
            signer: hex_address(signer),
            chain_id: p.chain_id.to_string(),
            vault,
            asset,
            asset_balance_raw: asset_balance.to_string(),
            share_balance_raw: share_balance.to_string(),
            preview_assets_raw: if action == MorphoAction::Deposit {
                amount
            } else {
                preview
            }
            .to_string(),
            preview_shares_raw: if action == MorphoAction::Deposit {
                preview
            } else {
                amount
            }
            .to_string(),
            registry_revision: p.registry_revision.clone(),
            fee_policy_revision: p.zero_fee_policy_revision.clone(),
            block_number: number.to_string(),
            block_hash: format!("{hash:#x}"),
            observed_at_ms: now,
            expires_at_ms: now + 30_000,
        })
    })
    .await
    .map_err(|_| EvmPreparationError::Timeout)?
}
pub struct MorphoPrepareRequest {
    pub action: MorphoAction,
    /// Deposit: asset units. Redeem: exact share units, never a MAX sentinel.
    pub amount: U256,
    /// Deposit only. Redeem has no on-chain minimum-output guard in this bundle.
    pub minimum_shares: Option<U256>,
    pub acknowledge_unprotected_output: bool,
    pub signer: Address,
    pub intent_hash: String,
    pub maximum_network_fee: U256,
    /// Fixed in immutable intent, reused in preflight; not silently extended.
    pub deadline: u64,
}
pub const DEPOSIT_SIGNATURE: &str =
    "vaultBundlesV1Deposit(address,uint256,uint256,(uint8,bytes),uint256,address,uint256)";
pub const WITHDRAW_SIGNATURE: &str = "vaultBundlesV1Withdraw(address,uint256,uint256,(uint256,uint256,uint256,uint8,bytes32,bytes32),uint256,address,uint256)";

/// Floor division deliberately makes the price ceiling at least as strict as the
/// requested minimum. Inexact division may require one extra share, never one less.
pub fn deposit_price_limit(assets: U256, minimum_shares: U256) -> Result<U256> {
    if assets == U256::ZERO || minimum_shares == U256::ZERO {
        return Err(EvmPreparationError::Invalid);
    }
    let price = assets
        .checked_mul(U256::from(10).pow(U256::from(27)))
        .and_then(|n| n.checked_div(minimum_shares))
        .ok_or(EvmPreparationError::Invalid)?;
    if price == U256::ZERO {
        return Err(EvmPreparationError::Invalid);
    }
    Ok(price)
}
pub fn action_data(vault: Address, input: &MorphoPrepareRequest) -> Result<String> {
    let mut words = vec![word(vault)];
    match input.action {
        MorphoAction::Deposit => {
            let price = deposit_price_limit(
                input.amount,
                input.minimum_shares.ok_or(EvmPreparationError::Invalid)?,
            )?;
            // Seven top-level ABI words; dynamic TokenPermit(None, empty bytes)
            // follows, with its bytes offset relative to the tuple start.
            words.extend([
                input.amount.to_be_bytes(),
                price.to_be_bytes(),
                U256::from(224).to_be_bytes(),
                [0; 32],
                [0; 32],
                U256::from(input.deadline).to_be_bytes(),
                [0; 32],
                U256::from(64).to_be_bytes(),
                [0; 32],
            ]);
            Ok(encode_call(DEPOSIT_SIGNATURE, &words))
        }
        MorphoAction::Redeem => {
            // Static Permit is six zero words: no signature and no Permit2.
            words.extend([[0; 32], input.amount.to_be_bytes()]);
            words.extend([[0; 32]; 8]);
            words.push(U256::from(input.deadline).to_be_bytes());
            Ok(encode_call(WITHDRAW_SIGNATURE, &words))
        }
    }
}
async fn read_word(
    rpc: &EvmReadRpc,
    address: &str,
    signature: &str,
    args: &[[u8; 32]],
    block: &str,
) -> Result<U256> {
    abi_word(
        rpc.call(address, &encode_call(signature, args), block)
            .await?,
    )
}
async fn read_address(
    rpc: &EvmReadRpc,
    address: &str,
    signature: &str,
    args: &[[u8; 32]],
    block: &str,
) -> Result<Address> {
    abi_address(
        rpc.call(address, &encode_call(signature, args), block)
            .await?,
    )
}
async fn verify_code(rpc: &EvmReadRpc, pin: &ContractPin, block: &str) -> Result<()> {
    let code = bytes(&rpc.code(&hex_address(pin.address), block).await?)?;
    if code.is_empty() || keccak256(code) != pin.code_hash {
        return Err(EvmPreparationError::Identity);
    }
    Ok(())
}
#[tracing::instrument(name = "provider.morpho_prepare", skip_all)]
pub async fn prepare(
    rpc: &EvmReadRpc,
    p: &MorphoExecutionPolicy,
    i: MorphoPrepareRequest,
) -> Result<PreparedEvm> {
    tokio::time::timeout(std::time::Duration::from_secs(60), prepare_inner(rpc, p, i))
        .await
        .map_err(|_| EvmPreparationError::Timeout)?
}
async fn prepare_inner(
    rpc: &EvmReadRpc,
    p: &MorphoExecutionPolicy,
    i: MorphoPrepareRequest,
) -> Result<PreparedEvm> {
    let now = now_ms();
    let deposit = i.action == MorphoAction::Deposit;
    if !(p.chain_id == 1 || (p.chain_id == 31337 && rpc.is_loopback()))
        || i.signer == Address::ZERO
        || i.amount == U256::ZERO
        || i.amount == U256::MAX
        || i.maximum_network_fee == U256::ZERO
        || p.asset_decimals > 18
        || p.share_decimals > 36
        || p.adapters.len() > 8
        || !(21_000..=2_000_000).contains(&p.maximum_gas_per_transaction)
        || i.deadline <= (now / 1000) as u64
        || i.deadline > (now / 1000) as u64 + 900
        || (deposit
            && (i
                .minimum_shares
                .is_none_or(|v| v == U256::ZERO || v == U256::MAX)
                || i.acknowledge_unprotected_output))
        || (!deposit && (i.minimum_shares.is_some() || !i.acknowledge_unprotected_output))
        || p.performance_fee_wad > U256::from(500_000_000_000_000_000u64)
        || p.management_fee_per_second_wad
            > U256::from(50_000_000_000_000_000u64) / U256::from(31_536_000)
        || [&p.vault, &p.bundle, &p.asset, &p.asset_implementation]
            .into_iter()
            .chain(p.adapters.iter())
            .any(|pin| {
                pin.address == Address::ZERO
                    || pin.code_hash == B256::ZERO
                    || pin.code_hash == keccak256([])
            })
    {
        return Err(EvmPreparationError::Invalid);
    }
    if quantity(&rpc.chain_id().await?)? != U256::from(p.chain_id) {
        return Err(EvmPreparationError::Identity);
    }
    let block = rpc.block("latest").await?;
    let number = quantity(&block["number"])?;
    let timestamp = quantity(&block["timestamp"])?;
    if number > U256::from(u64::MAX)
        || timestamp > U256::from(u64::MAX)
        || timestamp >= U256::from(i.deadline)
        || (p.chain_id == 1
            && (timestamp > U256::from((now / 1000 + 15) as u64)
                || timestamp + U256::from(120) < U256::from((now / 1000) as u64)))
    {
        return Err(EvmPreparationError::Identity);
    }
    let tag = format!("{number:#x}");
    let hash = block["hash"]
        .as_str()
        .and_then(|v| v.parse::<B256>().ok())
        .ok_or(EvmPreparationError::Invalid)?;
    let base_fee = quantity(&block["baseFeePerGas"])?;
    let signer = hex_address(i.signer);
    let vault = hex_address(p.vault.address);
    let asset = hex_address(p.asset.address);
    let bundle = hex_address(p.bundle.address);
    if !bytes(&rpc.code(&signer, &tag).await?)?.is_empty() {
        return Err(EvmPreparationError::Identity);
    }
    for pin in [&p.vault, &p.bundle, &p.asset]
        .into_iter()
        .chain(p.adapters.iter())
    {
        verify_code(rpc, pin, &tag).await?;
    }
    verify_implementation(
        rpc,
        &asset,
        USDC_IMPLEMENTATION_SLOT,
        &p.asset_implementation,
        &tag,
    )
    .await?;
    for (signature, expected) in [
        ("asset()", p.asset.address),
        ("owner()", p.owner),
        ("curator()", p.curator),
        ("adapterRegistry()", p.adapter_registry),
        ("liquidityAdapter()", p.liquidity_adapter),
        ("performanceFeeRecipient()", p.performance_fee_recipient),
        ("managementFeeRecipient()", p.management_fee_recipient),
    ] {
        if read_address(rpc, &vault, signature, &[], &tag).await? != expected {
            return Err(EvmPreparationError::Identity);
        }
    }
    for signature in [
        "sendAssetsGate()",
        "receiveAssetsGate()",
        "sendSharesGate()",
        "receiveSharesGate()",
    ] {
        if read_address(rpc, &vault, signature, &[], &tag).await? != Address::ZERO {
            return Err(EvmPreparationError::Restricted);
        }
    }
    for (address, signature, expected) in [
        (&asset, "decimals()", U256::from(p.asset_decimals)),
        (&vault, "decimals()", U256::from(p.share_decimals)),
        (&vault, "performanceFee()", p.performance_fee_wad),
        (&vault, "managementFee()", p.management_fee_per_second_wad),
        (&vault, "adaptersLength()", U256::from(p.adapters.len())),
    ] {
        if read_word(rpc, address, signature, &[], &tag).await? != expected {
            return Err(EvmPreparationError::Identity);
        }
    }
    for (n, pin) in p.adapters.iter().enumerate() {
        if read_address(
            rpc,
            &vault,
            "adapters(uint256)",
            &[U256::from(n).to_be_bytes()],
            &tag,
        )
        .await?
            != pin.address
        {
            return Err(EvmPreparationError::Identity);
        }
    }
    // Hash the canonical ABI response to bind dynamic liquidityData without an
    // unbounded decoder. It is an explicit registry observation, not calldata.
    if keccak256(bytes(
        &rpc.call(&vault, &encode_call("liquidityData()", &[]), &tag)
            .await?,
    )?) != p.liquidity_data_hash
    {
        return Err(EvmPreparationError::Identity);
    }
    let nonce = quantity(&rpc.nonce(&signer, &tag).await?)?;
    if nonce != quantity(&rpc.nonce(&signer, "pending").await?)? || nonce >= U256::from(u64::MAX) {
        return Err(EvmPreparationError::Pending);
    }
    let spend_token = if deposit { &asset } else { &vault };
    let receive_token = if deposit { &vault } else { &asset };
    if read_word(
        rpc,
        spend_token,
        "balanceOf(address)",
        &[word(i.signer)],
        &tag,
    )
    .await?
        < i.amount
        || quantity(&rpc.balance(&signer, &tag).await?)? < i.maximum_network_fee
    {
        return Err(EvmPreparationError::Balance);
    }
    let preview = read_word(
        rpc,
        &vault,
        if deposit {
            "previewDeposit(uint256)"
        } else {
            "previewRedeem(uint256)"
        },
        &[i.amount.to_be_bytes()],
        &tag,
    )
    .await?;
    if preview == U256::ZERO || (deposit && preview < i.minimum_shares.unwrap()) {
        return Err(EvmPreparationError::Simulation);
    }
    let allowance = read_word(
        rpc,
        spend_token,
        "allowance(address,address)",
        &[word(i.signer), word(p.bundle.address)],
        &tag,
    )
    .await?;
    let mut steps = Vec::new();
    if allowance < i.amount {
        if allowance != U256::ZERO {
            steps.push(EvmCall {
                purpose: CallPurpose::Approval,
                to: spend_token.clone(),
                value_raw: "0".into(),
                data: encode_call(
                    "approve(address,uint256)",
                    &[word(p.bundle.address), [0; 32]],
                ),
            });
        }
        steps.push(EvmCall {
            purpose: CallPurpose::Approval,
            to: spend_token.clone(),
            value_raw: "0".into(),
            data: encode_call(
                "approve(address,uint256)",
                &[word(p.bundle.address), i.amount.to_be_bytes()],
            ),
        });
    }
    steps.push(EvmCall {
        purpose: CallPurpose::Action,
        to: bundle,
        value_raw: "0".into(),
        data: action_data(p.vault.address, &i)?,
    });
    if nonce + U256::from(steps.len()) > U256::from(u64::MAX) {
        return Err(EvmPreparationError::Pending);
    }
    // Verify both exact debit and positive credit, not merely success status. These
    // reads share the sequential simulation with approvals and the final action.
    let balance_call = |token: &String| json!({"from":signer,"to":token,"data":encode_call("balanceOf(address)",&[word(i.signer)]),"value":"0x0","gas":"0x186a0"});
    let mut calls = vec![balance_call(spend_token), balance_call(receive_token)];
    calls.extend(steps.iter().map(|s|json!({"from":signer,"to":s.to,"data":s.data,"value":"0x0","gas":format!("0x{:x}",p.maximum_gas_per_transaction)})));
    calls.extend([balance_call(spend_token), balance_call(receive_token)]);
    let simulation = rpc.simulate(calls, &tag).await?;
    let blocks = simulation
        .as_array()
        .filter(|v| v.len() == 1)
        .ok_or(EvmPreparationError::Simulation)?;
    if blocks[0]["parentHash"].as_str() != Some(&format!("{hash:#x}")) {
        return Err(EvmPreparationError::Simulation);
    }
    let results = blocks[0]["calls"]
        .as_array()
        .filter(|v| v.len() == steps.len() + 4)
        .ok_or(EvmPreparationError::Simulation)?;
    if results
        .iter()
        .any(|v| v["status"] != "0x1" || v.get("error").is_some())
    {
        return Err(EvmPreparationError::Simulation);
    }
    let before_spend = abi_word(results[0]["returnData"].clone())?;
    let before_receive = abi_word(results[1]["returnData"].clone())?;
    let after_spend = abi_word(results[results.len() - 2]["returnData"].clone())?;
    let after_receive = abi_word(results[results.len() - 1]["returnData"].clone())?;
    if before_spend.checked_sub(after_spend) != Some(i.amount) {
        return Err(EvmPreparationError::Simulation);
    }
    let received = after_receive
        .checked_sub(before_receive)
        .filter(|v| *v > U256::ZERO)
        .ok_or(EvmPreparationError::Simulation)?;
    if deposit && received < i.minimum_shares.unwrap() {
        return Err(EvmPreparationError::Simulation);
    }
    let mut gas_limits = Vec::new();
    let mut total_gas = U256::ZERO;
    for (step, result) in steps.iter().zip(&results[2..results.len() - 2]) {
        if step.purpose == CallPurpose::Approval
            && abi_word(result["returnData"].clone())? != U256::from(1)
        {
            return Err(EvmPreparationError::Simulation);
        }
        if step.purpose == CallPurpose::Action && !bytes(&result["returnData"])?.is_empty() {
            return Err(EvmPreparationError::Simulation);
        }
        let used = quantity(&result["gasUsed"])?;
        if used < U256::from(21000) {
            return Err(EvmPreparationError::Simulation);
        }
        let gas = used
            .checked_mul(U256::from(120))
            .and_then(|n| n.checked_div(U256::from(100)))
            .and_then(|n| n.checked_add(U256::from(10000)))
            .filter(|n| *n <= U256::from(p.maximum_gas_per_transaction))
            .ok_or(EvmPreparationError::Fees)?;
        total_gas = total_gas
            .checked_add(gas)
            .ok_or(EvmPreparationError::Fees)?;
        gas_limits.push(gas.to_string());
    }
    let priority = quantity(&rpc.priority_fee().await?)?;
    let max_fee = base_fee
        .checked_mul(U256::from(2))
        .and_then(|n| n.checked_add(priority))
        .filter(|n| *n <= U256::from(u128::MAX))
        .ok_or(EvmPreparationError::Fees)?;
    let maximum_fee = total_gas
        .checked_mul(max_fee)
        .filter(|n| *n <= i.maximum_network_fee)
        .ok_or(EvmPreparationError::Fees)?;
    if rpc.block(&tag).await?["hash"] != block["hash"] {
        return Err(EvmPreparationError::Identity);
    }
    let observed_at = now_ms();
    if observed_at >= i.deadline as i64 * 1000 {
        return Err(EvmPreparationError::Timeout);
    }
    let plan = EvmPreparation {
        schema_version: 1,
        provider: PreparationProvider::MorphoVaultV2,
        chain_id: p.chain_id.to_string(),
        signer: signer.clone(),
        intent_hash: i.intent_hash,
        registry_revision: p.registry_revision.clone(),
        fee_policy_revision: p.zero_fee_policy_revision.clone(),
        quote_reference: None,
        expires_at_ms: (observed_at + 120_000).min(i.deadline as i64 * 1000),
        maximum_network_fee_raw: maximum_fee.to_string(),
        maximum_spend: AssetAmount {
            asset_address: Some(spend_token.clone()),
            amount_raw: i.amount.to_string(),
            recipient: signer.clone(),
        },
        minimum_receive: if deposit {
            Some(AssetAmount {
                asset_address: Some(vault),
                amount_raw: i.minimum_shares.unwrap().to_string(),
                recipient: signer,
            })
        } else {
            None
        },
        fees: vec![],
        simulation: SimulationRecord {
            block_number: number.to_string(),
            block_hash: format!("{hash:#x}"),
            calls_hash: calls_hash(&steps).map_err(|_| EvmPreparationError::Invalid)?,
            observed_at_ms: observed_at,
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
    prepared
        .validate_signing_terms()
        .map_err(|_| EvmPreparationError::Invalid)?;
    Ok(prepared)
}
