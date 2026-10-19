//! Local-fork bridge; policy observations are fixtures, never production approval.
use alloy_primitives::U256;
use honey_server::{
    evm_envelope::{EvmEnvelopePolicy, verify_signed_bundle},
    providers::{
        evm_prepare::PreparedEvm,
        evm_rpc::EvmReadRpc,
        morpho_execution::{self, MorphoExecutionPolicy, MorphoPrepareRequest},
    },
};
use serde_json::{Value, json};
use std::io::Read;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut input = zeroize::Zeroizing::new(String::new());
    std::io::stdin()
        .take(128 * 1024)
        .read_to_string(&mut input)?;
    let v: Value = serde_json::from_str(&input)?;
    let rpc = EvmReadRpc::new("http://127.0.0.1:28545")?;
    anyhow::ensure!(rpc.chain_id().await? == "0x7a69", "local fork required");
    if v["command"] == "verify" {
        let prepared: PreparedEvm = serde_json::from_value(v["prepared"].clone())?;
        prepared.validate_signing_terms()?;
        let signed =
            zeroize::Zeroizing::new(serde_json::from_value::<Vec<String>>(v["signed"].clone())?);
        let verified = verify_signed_bundle(
            &prepared.plan,
            EvmEnvelopePolicy {
                first_nonce: prepared.first_nonce.parse()?,
                maximum_gas_per_transaction: 2_000_000,
            },
            &signed,
            prepared.plan.simulation.observed_at_ms,
        )?;
        println!(
            "{}",
            json!({"hashes":verified.transactions().iter().map(|t|format!("{:#x}",t.hash())).collect::<Vec<_>>()})
        );
        return Ok(());
    }
    let policy: MorphoExecutionPolicy = serde_json::from_value(v["policy"].clone())?;
    anyhow::ensure!(policy.chain_id == 31337, "local fork policy required");
    let request = MorphoPrepareRequest {
        action: serde_json::from_value(v["action"].clone())?,
        amount: U256::from_str_radix(
            v["amount"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("amount missing"))?,
            10,
        )?,
        minimum_shares: v["minimumShares"]
            .as_str()
            .map(|s| U256::from_str_radix(s, 10))
            .transpose()?,
        acknowledge_unprotected_output: v["acknowledgeUnprotectedOutput"] == true,
        signer: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".parse()?,
        intent_hash: "b".repeat(64),
        maximum_network_fee: U256::from(10_000_000_000_000_000u64),
        deadline: v["deadline"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("deadline missing"))?,
    };
    println!(
        "{}",
        serde_json::to_string(&morpho_execution::prepare(&rpc, &policy, request).await?)?
    );
    Ok(())
}
