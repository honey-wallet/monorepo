use alloy_primitives::{Address, B256, U256, keccak256};
use axum::{Json, Router, extract::State, routing::post};
use honey_server::providers::{
    evm_prepare::{ContractPin, encode_call},
    evm_rpc::EvmReadRpc,
    morpho_execution::*,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
const HASH: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn addr(n: u8) -> Address {
    Address::repeat_byte(n)
}
fn word(n: U256) -> String {
    format!("0x{n:064x}")
}
fn address_word(a: Address) -> String {
    format!("0x{}{}", "00".repeat(12), hex::encode(a))
}
fn pin(n: u8) -> ContractPin {
    ContractPin {
        address: addr(n),
        code_hash: keccak256([0x60, 0]),
    }
}
fn liquidity() -> String {
    format!("0x{:064x}{:064x}", 32, 0)
}
fn policy() -> MorphoExecutionPolicy {
    MorphoExecutionPolicy {
        chain_id: 31337,
        vault: pin(2),
        bundle: pin(4),
        asset: pin(3),
        asset_implementation: pin(5),
        asset_decimals: 6,
        share_decimals: 18,
        owner: addr(7),
        curator: addr(8),
        adapters: vec![pin(6)],
        adapter_registry: addr(9),
        liquidity_adapter: addr(6),
        liquidity_data_hash: keccak256(hex::decode(&liquidity()[2..]).unwrap()),
        performance_fee_wad: U256::ZERO,
        management_fee_per_second_wad: U256::ZERO,
        performance_fee_recipient: addr(7),
        management_fee_recipient: addr(7),
        registry_revision: "fixture-v1".into(),
        zero_fee_policy_revision: "zero-referral-fee".into(),
        maximum_gas_per_transaction: 1_000_000,
    }
}
fn input(action: MorphoAction) -> MorphoPrepareRequest {
    MorphoPrepareRequest {
        action,
        amount: U256::from(1_000_000),
        minimum_shares: (action == MorphoAction::Deposit).then_some(U256::from(999_000)),
        acknowledge_unprotected_output: action == MorphoAction::Redeem,
        signer: addr(1),
        intent_hash: "b".repeat(64),
        maximum_network_fee: U256::from(10_000_000),
        deadline: time::OffsetDateTime::now_utc().unix_timestamp() as u64 + 600,
    }
}
#[derive(Clone, Default)]
struct Fixture {
    fault: Arc<AtomicUsize>,
    calls: Arc<AtomicUsize>,
}
async fn serve(State(f): State<Fixture>, Json(v): Json<Value>) -> Json<Value> {
    f.calls.fetch_add(1, Ordering::Relaxed);
    let fault = f.fault.load(Ordering::Relaxed);
    let p = &v["params"];
    let r = match v["method"].as_str().unwrap() {
        "eth_chainId" => json!(if fault == 20 { "0x1" } else { "0x7a69" }),
        "eth_getBlockByNumber" => {
            json!({"number":"0x64","hash":if fault==19 && p[0]!="latest" {"0xbb"}else{HASH},"timestamp":format!("0x{:x}",time::OffsetDateTime::now_utc().unix_timestamp()),"baseFeePerGas":"0x1"})
        }
        "eth_getCode" => json!(if p[0] == format!("{:#x}", addr(1)) {
            if fault == 2 { "0xef0100" } else { "0x" }
        } else if fault == 3 && p[0] == format!("{:#x}", addr(5)) {
            "0x6001"
        } else {
            "0x6000"
        }),
        "eth_getStorageAt" => {
            assert_eq!(p[2], "0x64");
            json!(address_word(if fault == 5 { addr(10) } else { addr(5) }))
        }
        "eth_getTransactionCount" => json!(if fault == 6 && p[1] == "pending" {
            "0x1"
        } else {
            "0x0"
        }),
        "eth_getBalance" => json!(if fault == 7 {
            "0x0"
        } else {
            "0xde0b6b3a7640000"
        }),
        "eth_maxPriorityFeePerGas" => json!(if fault == 18 {
            "0xffffffffffffffffffffffffffffffffffff"
        } else {
            "0x1"
        }),
        "eth_call" => {
            assert_eq!(p[1], "0x64");
            let data = p[0]["data"].as_str().unwrap();
            let matches = |s: &str| data.starts_with(&encode_call(s, &[]));
            if matches("asset()") {
                json!(address_word(if fault == 8 { addr(10) } else { addr(3) }))
            } else if matches("owner()")
                || matches("performanceFeeRecipient()")
                || matches("managementFeeRecipient()")
            {
                json!(address_word(addr(7)))
            } else if matches("curator()") {
                json!(address_word(addr(8)))
            } else if matches("adapterRegistry()") {
                json!(address_word(addr(9)))
            } else if matches("liquidityAdapter()") || matches("adapters(uint256)") {
                json!(address_word(if fault == 9 { addr(10) } else { addr(6) }))
            } else if [
                "sendAssetsGate()",
                "receiveAssetsGate()",
                "sendSharesGate()",
                "receiveSharesGate()",
            ]
            .iter()
            .any(|s| matches(s))
            {
                json!(address_word(if fault == 1 {
                    addr(10)
                } else {
                    Address::ZERO
                }))
            } else if matches("decimals()") {
                json!(word(U256::from(if fault == 10 {
                    5
                } else if p[0]["to"] == format!("{:#x}", addr(3)) {
                    6
                } else {
                    18
                })))
            } else if matches("performanceFee()") || matches("managementFee()") {
                json!(word(U256::from(if fault == 4 { 1 } else { 0 })))
            } else if matches("adaptersLength()") {
                json!(word(U256::from(if fault == 11 { 2 } else { 1 })))
            } else if matches("liquidityData()") {
                json!(if fault == 12 {
                    "0x".into()
                } else {
                    liquidity()
                })
            } else if matches("balanceOf(address)") {
                json!(word(U256::from(if fault == 13 { 0 } else { 10_000_000 })))
            } else if matches("previewDeposit(uint256)") || matches("previewRedeem(uint256)") {
                json!(word(U256::from(if fault == 14 { 0 } else { 1_000_000 })))
            } else if matches("allowance(address,address)") {
                json!(word(U256::from(match fault {
                    21 => 1,
                    22 => 1_000_000,
                    _ => 0,
                })))
            } else {
                panic!("unexpected read; max* must not be used")
            }
        }
        "eth_simulateV1" => {
            let calls = p[0]["blockStateCalls"][0]["calls"].as_array().unwrap();
            let results:Vec<_>=calls.iter().enumerate().map(|(n,c)| {
                let data=c["data"].as_str().unwrap();let ret=if n==0 {word(U256::from(10_000_000))}else if n==1 {word(U256::ZERO)}else if n==calls.len()-2 {word(U256::from(if fault==23 {8_999_999}else{9_000_000}))}else if n==calls.len()-1 {word(U256::from(if fault==24 {1}else{1_000_000}))}else if data.starts_with("0x095ea7b3") {word(U256::from(if fault==16 {0}else{1}))}else{"0x".into()};
                json!({"status":if fault==15 {"0x0"}else{"0x1"},"returnData":ret,"gasUsed":if fault==17 {"0x1e8480"}else{"0x186a0"}})
            }).collect();
            json!([{"parentHash":HASH,"calls":results}])
        }
        _ => panic!("unexpected RPC"),
    };
    Json(json!({"jsonrpc":"2.0","id":1,"result":r}))
}
async fn fixture() -> (EvmReadRpc, Fixture, tokio::task::JoinHandle<()>) {
    let f = Fixture::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc = EvmReadRpc::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let app = Router::new().route("/", post(serve)).with_state(f.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (rpc, f, task)
}
#[tokio::test]
async fn deposits_have_exact_spend_and_share_guard_while_redemptions_do_not_claim_minimum_output() {
    let (rpc, f, task) = fixture().await;
    for (fault, count) in [(0, 2), (21, 3), (22, 1)] {
        f.fault.store(fault, Ordering::Relaxed);
        let prepared = prepare(&rpc, &policy(), input(MorphoAction::Deposit))
            .await
            .unwrap();
        assert_eq!(prepared.plan.steps.len(), count);
        assert_eq!(prepared.plan.maximum_spend.amount_raw, "1000000");
        assert_eq!(prepared.plan.minimum_receive.unwrap().amount_raw, "999000");
        assert!(prepared.plan.fees.is_empty());
    }
    f.fault.store(0, Ordering::Relaxed);
    let redeemed = prepare(&rpc, &policy(), input(MorphoAction::Redeem))
        .await
        .unwrap();
    assert!(redeemed.plan.minimum_receive.is_none());
    assert_eq!(
        redeemed.plan.maximum_spend.asset_address,
        Some(format!("{:#x}", addr(2)))
    );
    task.abort();
}
#[tokio::test]
async fn identity_gates_fees_liquidity_and_simulated_economics_fail_closed() {
    let (rpc, f, task) = fixture().await;
    for fault in (1..=20).chain([23, 24]) {
        f.fault.store(fault, Ordering::Relaxed);
        assert!(
            prepare(&rpc, &policy(), input(MorphoAction::Deposit))
                .await
                .is_err(),
            "fault {fault}"
        );
    }
    task.abort();
}
#[tokio::test]
async fn impossible_or_unacknowledged_requests_do_not_reach_rpc() {
    let (rpc, f, task) = fixture().await;
    for action in [MorphoAction::Deposit, MorphoAction::Redeem] {
        let mut i = input(action);
        i.amount = U256::MAX;
        assert!(prepare(&rpc, &policy(), i).await.is_err());
        let mut i = input(action);
        i.minimum_shares = None;
        i.acknowledge_unprotected_output = false;
        assert!(prepare(&rpc, &policy(), i).await.is_err());
        let mut i = input(action);
        i.deadline = 1;
        assert!(prepare(&rpc, &policy(), i).await.is_err());
    }
    let mut p = policy();
    p.vault.code_hash = B256::ZERO;
    assert!(
        prepare(&rpc, &p, input(MorphoAction::Deposit))
            .await
            .is_err()
    );
    assert_eq!(f.calls.load(Ordering::Relaxed), 0);
    task.abort();
}
#[test]
fn price_limit_rounding_never_weakens_the_requested_minimum() {
    for assets in [1u64, 10, 1_000_000] {
        for minimum in [1u64, 3, 999, 1_000_000_000] {
            let numerator = U256::from(assets) * U256::from(10).pow(U256::from(27));
            let limit = deposit_price_limit(U256::from(assets), U256::from(minimum)).unwrap();
            assert!(numerator.div_ceil(limit) >= U256::from(minimum));
        }
    }
    assert!(deposit_price_limit(U256::MAX, U256::from(1)).is_err());
    assert!(deposit_price_limit(U256::from(1), U256::ZERO).is_err());
}
