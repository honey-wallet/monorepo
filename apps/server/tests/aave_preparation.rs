use alloy_primitives::{Address, U256, keccak256};
use axum::{Json, Router, extract::State, routing::post};
use honey_server::providers::{aave_execution::*, evm_rpc::EvmReadRpc};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const HASH: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn addr(n: u8) -> Address {
    Address::repeat_byte(n)
}
fn word(v: U256) -> String {
    format!("0x{v:064x}")
}
fn address_word(n: u8) -> String {
    format!("0x{}{}", "00".repeat(12), format!("{n:02x}").repeat(20))
}
#[derive(Clone)]
struct Fixture {
    fault: Arc<AtomicUsize>,
    calls: Arc<AtomicUsize>,
    implementation_fault: Arc<AtomicUsize>,
    simulations: Arc<AtomicUsize>,
}
async fn serve(State(f): State<Fixture>, Json(v): Json<Value>) -> Json<Value> {
    f.calls.fetch_add(1, Ordering::Relaxed);
    let fault = f.fault.load(Ordering::Relaxed);
    let implementation_fault = f.implementation_fault.load(Ordering::Relaxed);
    let method = v["method"].as_str().unwrap();
    if fault == 15 {
        return Json(
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"private upstream detail"}}),
        );
    }
    let p = &v["params"];
    let r = match method {
        "eth_chainId" => json!(if fault == 1 {
            "0x2"
        } else if fault >= 18 {
            "0x1"
        } else {
            "0x7a69"
        }),
        "eth_getBlockByNumber" => {
            let now = time::OffsetDateTime::now_utc().unix_timestamp() as u64;
            let timestamp = match fault {
                18 => "0x1".into(),
                19 => format!("0x{:x}", now + 60),
                20 => format!("0x{:x}", U256::MAX),
                _ => format!("0x{now:x}"),
            };
            json!({"number":"0x64","timestamp":timestamp,"hash":if fault==2&&p[0]!="latest" {"0xbb"}else{HASH},"baseFeePerGas":"0x1"})
        }
        "eth_getCode" => json!(if p[0] == format!("{:#x}", addr(1)) {
            if fault == 3 { "0xef0100" } else { "0x" }
        } else if p[0] == format!("{:#x}", addr(5)) && implementation_fault == 7 {
            "0x6001"
        } else if p[0] == format!("{:#x}", addr(6)) && implementation_fault == 8 {
            "0x"
        } else {
            "0x6000"
        }),
        "eth_getStorageAt" => {
            assert_eq!(p[2], "0x64");
            let n = if p[0] == format!("{:#x}", addr(2)) {
                5
            } else if p[0] == format!("{:#x}", addr(3)) {
                6
            } else {
                7
            };
            assert_eq!(
                p[1],
                if n == 6 {
                    USDC_IMPLEMENTATION_SLOT
                } else {
                    AAVE_IMPLEMENTATION_SLOT
                }
            );
            json!(match implementation_fault {
                1..=3 if n == implementation_fault as u8 + 4 => address_word(9),
                4 => format!("0x01{}", "00".repeat(31)),
                5 => "0x01".into(),
                6 => word(U256::ZERO),
                _ => address_word(n),
            })
        }
        "eth_getBalance" => json!(if fault == 4 {
            "0x0"
        } else {
            "0xde0b6b3a7640000"
        }),
        "eth_getTransactionCount" => json!(if fault == 5 && p[1] == "pending" {
            "0x1"
        } else {
            "0x0"
        }),
        "eth_maxPriorityFeePerGas" => json!("0x1"),
        "eth_call" => {
            let data = p[0]["data"].as_str().unwrap();
            let selector = &data[..10];
            let matches = |s: &str| selector == &encode_call(s, &[])[..10];
            if matches("getReserveAToken(address)") {
                json!(address_word(if fault == 6 { 5 } else { 4 }))
            } else if matches("UNDERLYING_ASSET_ADDRESS()") {
                json!(address_word(3))
            } else if matches("POOL()") {
                json!(address_word(2))
            } else if matches("decimals()") {
                json!(word(U256::from(6)))
            } else if matches("getConfiguration(address)") {
                let mut config = (U256::from(6) << 48) | (U256::from(1) << 56);
                if fault == 7 {
                    config |= U256::from(1) << 60;
                }
                if fault == 8 {
                    config |= U256::from(1) << 57;
                }
                json!(word(config))
            } else if matches("balanceOf(address)") {
                json!(word(U256::from(if fault == 9 { 0 } else { 10000000 })))
            } else if matches("allowance(address,address)") {
                json!(word(U256::from(match fault {
                    10 => 1,
                    11 => 1000000,
                    _ => 0,
                })))
            } else {
                panic!("unexpected call")
            }
        }
        "eth_simulateV1" => {
            f.simulations.fetch_add(1, Ordering::Relaxed);
            let calls = p[0]["blockStateCalls"][0]["calls"].as_array().unwrap();
            let results:Vec<_>=calls.iter().enumerate().map(|(index,c)| {
                let data=c["data"].as_str().unwrap();
                let result=if data.starts_with("0x70a08231") {word(U256::from(if index == 0 {10000000} else if fault == 16 {8999997} else {8999999}))}else if data.starts_with("0x095ea7b3") {word(U256::from(1))}else if data.starts_with("0x69328dec") {word(U256::from(1000000))}else{"0x".into()};
                json!({"status":if fault==12 {"0x0"}else{"0x1"},"returnData":result,"gasUsed":if fault==13 {"0x1e8480"}else{"0x186a0"}})
            }).collect();
            json!([{"parentHash":if fault==14 {"0xbb"}else{HASH},"calls":results}])
        }
        _ => panic!("unexpected method"),
    };
    Json(json!({"jsonrpc":"2.0","id":1,"result":r}))
}
fn policy() -> AaveExecutionPolicy {
    AaveExecutionPolicy {
        chain_id: 31337,
        pool: addr(2),
        asset: addr(3),
        a_token: addr(4),
        decimals: 6,
        pool_code_hash: keccak256([0x60, 0]),
        asset_code_hash: keccak256([0x60, 0]),
        a_token_code_hash: keccak256([0x60, 0]),
        pool_implementation: ImplementationPin {
            address: addr(5),
            code_hash: keccak256([0x60, 0]),
        },
        asset_implementation: ImplementationPin {
            address: addr(6),
            code_hash: keccak256([0x60, 0]),
        },
        a_token_implementation: ImplementationPin {
            address: addr(7),
            code_hash: keccak256([0x60, 0]),
        },
        registry_revision: "test".into(),
        zero_fee_policy_revision: "test-zero".into(),
        maximum_gas_per_transaction: 500000,
        maximum_atoken_rounding_raw: U256::from(2),
    }
}
fn input(action: AaveAction) -> AavePrepareRequest {
    AavePrepareRequest {
        action,
        signer: addr(1),
        amount: U256::from(1000000),
        intent_hash: "a".repeat(64),
        maximum_network_fee: U256::from(100000000),
    }
}
async fn fixture() -> (EvmReadRpc, Fixture, tokio::task::JoinHandle<()>) {
    let f = Fixture {
        fault: Arc::new(AtomicUsize::new(0)),
        calls: Arc::new(AtomicUsize::new(0)),
        implementation_fault: Arc::new(AtomicUsize::new(0)),
        simulations: Arc::new(AtomicUsize::new(0)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc = EvmReadRpc::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let app = Router::new().route("/", post(serve)).with_state(f.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (rpc, f, task)
}
#[tokio::test]
async fn unchanged_proxy_bytecode_cannot_hide_implementation_changes() {
    let (rpc, f, task) = fixture().await;
    for fault in 1..=8 {
        f.implementation_fault.store(fault, Ordering::Relaxed);
        assert!(
            prepare(&rpc, &policy(), input(AaveAction::Supply))
                .await
                .is_err(),
            "implementation fault {fault}"
        );
        assert_eq!(f.simulations.load(Ordering::Relaxed), 0);
    }
    f.implementation_fault.store(0, Ordering::Relaxed);
    assert!(
        prepare(&rpc, &policy(), input(AaveAction::Supply))
            .await
            .is_ok()
    );
    // A second preparation is the presend path: a later upgrade must stop it too.
    let simulations = f.simulations.load(Ordering::Relaxed);
    f.implementation_fault.store(1, Ordering::Relaxed);
    assert!(
        prepare(&rpc, &policy(), input(AaveAction::Supply))
            .await
            .is_err()
    );
    assert_eq!(f.simulations.load(Ordering::Relaxed), simulations);
    let before = f.calls.load(Ordering::Relaxed);
    let mut policy = policy();
    policy.pool_implementation.address = Address::ZERO;
    assert!(
        prepare(&rpc, &policy, input(AaveAction::Supply))
            .await
            .is_err()
    );
    assert_eq!(before, f.calls.load(Ordering::Relaxed));
    task.abort();
}
#[tokio::test]
async fn ordered_approvals_withdrawal_and_exact_fee_bounds() {
    let (rpc, f, task) = fixture().await;
    for (fault, steps) in [(0, 2), (10, 3), (11, 1)] {
        f.fault.store(fault, Ordering::Relaxed);
        let p = prepare(&rpc, &policy(), input(AaveAction::Supply))
            .await
            .unwrap();
        assert_eq!(p.plan.steps.len(), steps);
        assert!(p.plan.minimum_receive.is_none());
        assert_eq!(
            p.plan.maximum_network_fee_raw,
            (steps * 130000 * 3).to_string()
        );
        assert_eq!(p.plan.maximum_spend.amount_raw, "1000000");
        assert!(p.plan.fees.is_empty());
        if fault == 10 {
            assert!(p.plan.steps[0].data.ends_with(&"0".repeat(64)));
        }
    }
    // Frozen reserves still permit withdrawals; paused reserves do not.
    f.fault.store(8, Ordering::Relaxed);
    let p = prepare(&rpc, &policy(), input(AaveAction::Withdraw))
        .await
        .unwrap();
    assert_eq!(p.plan.steps.len(), 1);
    assert_eq!(p.plan.minimum_receive.unwrap().amount_raw, "1000000");
    assert_eq!(p.plan.maximum_spend.amount_raw, "1000002");
    f.fault.store(16, Ordering::Relaxed);
    assert!(matches!(
        prepare(&rpc, &policy(), input(AaveAction::Withdraw)).await,
        Err(AavePreparationError::Simulation)
    ));
    task.abort();
}
#[tokio::test]
async fn provider_identity_state_and_simulation_failures_stop_preparation() {
    let (rpc, f, task) = fixture().await;
    for fault in [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15] {
        f.fault.store(fault, Ordering::Relaxed);
        assert!(
            prepare(&rpc, &policy(), input(AaveAction::Supply))
                .await
                .is_err(),
            "fault {fault}"
        );
    }
    f.fault.store(0, Ordering::Relaxed);
    let mut i = input(AaveAction::Supply);
    i.maximum_network_fee = U256::from(1);
    assert!(matches!(
        prepare(&rpc, &policy(), i).await,
        Err(AavePreparationError::Fees)
    ));
    let before = f.calls.load(Ordering::Relaxed);
    let mut p = policy();
    p.chain_id = 42161;
    assert!(matches!(
        prepare(&rpc, &p, input(AaveAction::Supply)).await,
        Err(AavePreparationError::Invalid)
    ));
    assert_eq!(before, f.calls.load(Ordering::Relaxed));
    task.abort();
}
#[test]
fn rpc_urls_are_server_configuration_not_arbitrary_http_targets() {
    for bad in [
        "http://example.com",
        "https://user:password@example.com",
        "https://example.com/#fragment",
        "file:///tmp/rpc",
    ] {
        assert!(EvmReadRpc::new(bad).is_err());
    }
    assert!(EvmReadRpc::new("https://example.com/api-key").is_err());
    assert!(
        EvmReadRpc::new("http://127.0.0.1:28545")
            .unwrap()
            .is_loopback()
    );
}

#[tokio::test]
async fn production_source_block_must_be_fresh_and_timestamp_bounded() {
    let (rpc, f, task) = fixture().await;
    let mut p = policy();
    p.chain_id = 1;
    for fault in [18, 19, 20] {
        f.fault.store(fault, Ordering::Relaxed);
        assert!(matches!(
            prepare(&rpc, &p, input(AaveAction::Supply)).await,
            Err(AavePreparationError::Identity)
        ));
    }
    f.fault.store(21, Ordering::Relaxed);
    assert!(prepare(&rpc, &p, input(AaveAction::Supply)).await.is_ok());
    task.abort();
}

#[tokio::test]
async fn signing_terms_reject_nonce_overflow_fee_drift_and_missing_steps() {
    let (rpc, _, task) = fixture().await;
    let original = prepare(&rpc, &policy(), input(AaveAction::Supply))
        .await
        .unwrap();
    original.validate_signing_terms().unwrap();
    let mutations: &[fn(&mut PreparedAave)] = &[
        |p| p.first_nonce = U256::MAX.to_string(),
        |p| p.first_nonce = u64::MAX.to_string(),
        |p| p.first_nonce = "01".into(),
        |p| p.gas_limits.pop().map(|_| ()).unwrap(),
        |p| p.gas_limits[0] = "20999".into(),
        |p| p.gas_limits[0] = "2000001".into(),
        |p| p.max_fee_per_gas = "4".into(),
        |p| p.max_priority_fee_per_gas = "4".into(),
        |p| p.plan.maximum_network_fee_raw = "1".into(),
    ];
    for mutate in mutations {
        let mut p = original.clone();
        mutate(&mut p);
        assert!(p.validate_signing_terms().is_err());
    }
    task.abort();
}
