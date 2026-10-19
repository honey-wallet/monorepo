//! Pure validation bridge for the localhost-only acceptance driver. No RPC/signing.
use honey_server::providers::{
    permit2::PermitTerms,
    uniswap_economics::{RouterCall, SwapAuthority, validate_economics},
    uniswap_router,
};
use serde::Deserialize;
use std::io::Read;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    policy: SwapAuthority,
    call: RouterCall,
    terms: PermitTerms,
    now: u64,
}

fn main() -> anyhow::Result<()> {
    let mut input = Zeroizing::new(String::new());
    std::io::stdin()
        .take(160 * 1024)
        .read_to_string(&mut input)?;
    let v: Input = serde_json::from_str(&input)?;
    anyhow::ensure!(
        v.policy.chain_id == "31337" && v.terms.chain_id == "31337",
        "local-fork fixture only"
    );
    let proof = validate_economics(&v.policy, &v.call, v.now)?;
    let digest =
        uniswap_router::decode(&v.call.data)?.verify_embedded_permit(Some(&v.terms), v.now)?;
    println!(
        "{}",
        serde_json::json!({"proof":proof,"permitDigest":digest.map(|v|format!("{v:#x}"))})
    );
    Ok(())
}
