//! Read-only verifier for two fixed localhost forks. Never broadcasts or accepts an RPC URL.
use alloy_primitives::B256;
use honey_server::providers::{
    across_evidence::{DirectDepositTerms, EvidencePolicy, TokenProxy, verify_delivery},
    evm_prepare::ContractPin,
    evm_rpc::EvmReadRpc,
};
use serde_json::Value;
use std::io::Read;
fn policy(v: &Value, chain: u64) -> anyhow::Result<EvidencePolicy> {
    Ok(EvidencePolicy {
        chain,
        spoke: serde_json::from_value::<ContractPin>(v["spoke"].clone())?,
        spoke_implementation: serde_json::from_value(v["spokeImplementation"].clone())?,
        token: serde_json::from_value(v["token"].clone())?,
        token_implementation: Some((
            TokenProxy::Usdc,
            serde_json::from_value(v["tokenImplementation"].clone())?,
        )),
        wrapped_native: v["wrappedNative"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing wrapped token"))?
            .parse()?,
    })
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut input = String::new();
    std::io::stdin().take(65537).read_to_string(&mut input)?;
    anyhow::ensure!(input.len() <= 65536, "input too large");
    let v: Value = serde_json::from_str(&input)?;
    let terms: DirectDepositTerms = serde_json::from_value(v["terms"].clone())?;
    anyhow::ensure!(
        terms.source_chain == 31337 && terms.destination_chain == 31338,
        "local chain pair required"
    );
    let source = EvmReadRpc::new("http://127.0.0.1:29545")?;
    let destination = EvmReadRpc::new("http://127.0.0.1:29546")?;
    let source_hash: B256 = v["sourceHash"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing source hash"))?
        .parse()?;
    let fill_hash: B256 = v["fillHash"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing fill hash"))?
        .parse()?;
    let proof = verify_delivery(
        &source,
        &policy(&v["sourcePolicy"], 31337)?,
        &destination,
        &policy(&v["destinationPolicy"], 31338)?,
        &terms,
        source_hash,
        fill_hash,
    )
    .await?;
    println!("{}", serde_json::to_string(&proof)?);
    Ok(())
}
