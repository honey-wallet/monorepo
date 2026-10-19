use super::*;
use crate::providers::uniswap::execution_fixture;
use axum::{Json, Router, extract::State, routing::post};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
const HEAD: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FINAL: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
fn a(n: u8) -> Address {
    Address::from_word(U256::from(n).to_be_bytes::<32>().into())
}
fn word_hex(n: U256) -> String {
    format!("0x{n:064x}")
}
fn packed(amount: U256, expiration: u64, nonce: u64) -> String {
    format!("0x{amount:064x}{expiration:064x}{nonce:064x}")
}
#[derive(Clone)]
struct Mock {
    review: Arc<SwapReview>,
    fault: Arc<AtomicUsize>,
    allowance: Arc<AtomicUsize>,
    requests: Arc<AtomicUsize>,
    simulations: Arc<AtomicUsize>,
    pending_reads: Arc<AtomicUsize>,
    no_return: Arc<AtomicUsize>,
}
impl Mock {
    fn fault(&self) -> usize {
        self.fault.load(Ordering::SeqCst)
    }
}
async fn handler(State(f): State<Mock>, Json(v): Json<Value>) -> Json<Value> {
    f.requests.fetch_add(1, Ordering::SeqCst);
    let method = v["method"].as_str().unwrap();
    let p = &v["params"];
    let fault = f.fault();
    let now = (now_ms() / 1000) as u64;
    let r = &f.review;
    let owner = &r.authority.owner;
    let input = &r.authority.token_in;
    let output = &r.authority.token_out;
    let result = match method {
        "eth_chainId" => json!(if fault == 1 {
            "0x2".to_string()
        } else {
            format!("0x{:x}", r.authority.chain_id.parse::<u64>().unwrap())
        }),
        "eth_getBlockByNumber" => {
            let finalized = p[0] == "finalized" || p[0] == "0x8";
            let ts = if fault == 2 {
                1
            } else if finalized {
                now - 60
            } else {
                now
            };
            json!({"number":if finalized{if fault==10{"0x20"}else{"0x8"}}else{"0xa"},"hash":if finalized || fault==11&&p[0]=="0xa"{FINAL}else{HEAD},"timestamp":format!("0x{ts:x}"),"baseFeePerGas":"0x1"})
        }
        "eth_getCode" => json!(if p[0] == *owner {
            if fault == 3 { "0xef0100" } else { "0x" }
        } else if fault == 4 && p[0] == r.authority.router
            || fault == 5 && p[0] == hex_address(a(70))
        {
            "0x6001"
        } else {
            "0x6000"
        }),
        "eth_getStorageAt" => {
            assert_eq!(p[1], evm_prepare::USDC_IMPLEMENTATION_SLOT);
            assert_eq!(p[2], "0xa");
            json!(word_hex(U256::from_be_slice(a(70).as_slice())))
        }
        "eth_getTransactionCount" => {
            if p[1] == "pending" {
                let n = f.pending_reads.fetch_add(1, Ordering::SeqCst);
                json!(if fault == 6 || fault == 22 && n > 0 {
                    "0x8"
                } else {
                    "0x7"
                })
            } else {
                assert!(p[1] == "0xa" || p[1] == "latest");
                json!("0x7")
            }
        }
        "eth_getBalance" => json!(if fault == 18 {
            "0x0"
        } else {
            "0xde0b6b3a7640000"
        }),
        "eth_maxPriorityFeePerGas" => json!(if fault == 23 {
            "0xffffffffffffffffffffffffffffffff"
        } else {
            "0x1"
        }),
        "eth_call" => {
            assert_eq!(p[1], "0xa");
            let data = p[0]["data"].as_str().unwrap();
            if data.starts_with(&encode_call("decimals()", &[])[..10]) {
                json!(word_hex(U256::from(if fault == 24 { 7 } else { 6 })))
            } else if p[0]["to"] == r.permit2 {
                json!(packed(
                    U256::from(1000),
                    if fault == 8 {
                        now - 1
                    } else {
                        (r.expires_at_ms / 1000) as u64
                    },
                    if fault == 7 { 8 } else { 7 }
                ))
            } else if data.starts_with(&encode_call("allowance(address,address)", &[])[..10]) {
                json!(word_hex(U256::from(f.allowance.load(Ordering::SeqCst))))
            } else {
                assert_eq!(p[0]["to"], *input);
                json!(word_hex(U256::from(if fault == 9 { 999 } else { 10000 })))
            }
        }
        "eth_simulateV1" => {
            f.simulations.fetch_add(1, Ordering::SeqCst);
            assert_eq!(p[1], "0xa");
            assert_eq!(p[0]["validation"], false);
            let calls = p[0]["blockStateCalls"][0]["calls"].as_array().unwrap();
            let action = calls
                .iter()
                .position(|v| v["to"] == r.authority.router)
                .unwrap();
            let before = 2 + r.authority.fees.len() + r.authority.tokens.len();
            let mut results = Vec::new();
            for (i, c) in calls.iter().enumerate() {
                assert_eq!(c["from"], *owner);
                assert_eq!(c["value"], "0x0");
                let after = i > action;
                let read = c["data"]
                    .as_str()
                    .unwrap()
                    .starts_with(&encode_call("balanceOf(address)", &[])[..10]);
                let data = if read {
                    let recipient = format!("0x{}", &c["data"].as_str().unwrap()[34..74]);
                    let value = if recipient == *owner && c["to"] == *input {
                        if after {
                            if fault == 14 { 8999 } else { 9000 }
                        } else {
                            10000
                        }
                    } else if recipient == *owner && c["to"] == *output {
                        if after {
                            if fault == 13 { 1999 } else { 3000 }
                        } else {
                            100
                        }
                    } else if recipient == r.authority.router {
                        if after && fault == 16 { 1 } else { 0 }
                    } else if after {
                        if fault == 15 { 1000 } else { 20 }
                    } else {
                        0
                    };
                    word_hex(U256::from(value))
                } else if c["to"] == r.permit2 {
                    packed(
                        U256::from(if fault == 29 { 1001 } else { 0 }),
                        (r.expires_at_ms / 1000) as u64 - u64::from(fault == 30),
                        if fault == 17 {
                            99
                        } else {
                            7 + u64::from(r.permit.is_some())
                        },
                    )
                } else if i < action {
                    assert!(c["data"].as_str().unwrap().starts_with("0x095ea7b3"));
                    assert_eq!(&c["data"].as_str().unwrap()[34..74], &r.permit2[2..]);
                    if f.no_return.load(Ordering::SeqCst) > 0 {
                        "0x".into()
                    } else {
                        word_hex(U256::from(usize::from(fault != 20)))
                    }
                } else {
                    "0x".into()
                };
                let status = if fault == 12 && i == action {
                    "0x0"
                } else {
                    "0x1"
                };
                results.push(json!({"status":status,"returnData":data,"gasUsed":if fault==21{"0x1e8480"}else{"0xc350"}}));
            }
            assert!(action >= before && action <= before + 2);
            json!([{"parentHash":HEAD,"timestamp":format!("0x{:x}",if fault==19{(r.expires_at_ms/1000) as u64}else{now+1}),"calls":results}])
        }
        _ => panic!("unexpected RPC method {method}"),
    };
    Json(json!({"jsonrpc":"2.0","id":1,"result":result}))
}
fn contract(address: Address) -> ContractPin {
    ContractPin {
        address,
        code_hash: keccak256([0x60, 0]),
    }
}
fn policy(r: &SwapReview) -> UniswapExecutionPolicy {
    UniswapExecutionPolicy {
        chain_id: r.authority.chain_id.parse().unwrap(),
        router: contract(addr(&r.authority.router).unwrap()),
        permit2: contract(addr(&r.permit2).unwrap()),
        v2_factory: contract(a(50)),
        v3_factory: contract(a(51)),
        pool_manager: contract(a(52)),
        wrapped_native: contract(a(53)),
        tokens: r
            .authority
            .tokens
            .iter()
            .map(|a| SwapTokenPin {
                contract: contract(addr(a).unwrap()),
                decimals: 6,
                allow_empty_approval_return: false,
                code: if a == &r.authority.token_in {
                    TokenCode::Usdc(contract(self::a(70)))
                } else {
                    TokenCode::Direct
                },
            })
            .collect(),
        registry_revision: r.registry_revision.clone(),
        fee_policy_revision: r.fee_policy_revision.clone(),
        maximum_gas_per_transaction: 500_000,
        maximum_quote_block_lag: 64,
    }
}
async fn setup(
    route: Option<&str>,
) -> (
    EvmReadRpc,
    UniswapExecutionPolicy,
    Arc<SwapReview>,
    VerifiedSwapBuild,
    Mock,
    tokio::task::JoinHandle<()>,
) {
    let (r, build) = execution_fixture(now_ms() - 1, route);
    setup_from(r, build).await
}
async fn setup_from(
    r: SwapReview,
    build: VerifiedSwapBuild,
) -> (
    EvmReadRpc,
    UniswapExecutionPolicy,
    Arc<SwapReview>,
    VerifiedSwapBuild,
    Mock,
    tokio::task::JoinHandle<()>,
) {
    let p = policy(&r);
    let r = Arc::new(r);
    let f = Mock {
        review: r.clone(),
        fault: Arc::new(AtomicUsize::new(0)),
        allowance: Arc::new(AtomicUsize::new(1)),
        requests: Arc::new(AtomicUsize::new(0)),
        simulations: Arc::new(AtomicUsize::new(0)),
        pending_reads: Arc::new(AtomicUsize::new(0)),
        no_return: Arc::new(AtomicUsize::new(0)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/", post(handler))
        .with_state(f.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (EvmReadRpc::new(&endpoint).unwrap(), p, r, build, f, task)
}
#[tokio::test]
async fn finite_reset_approval_and_swap_are_simulated_together_with_exact_terms() {
    let (rpc, mut p, r, build, f, task) = setup(None).await;
    let observed = observe(&rpc, &p, &r, build.source_block()).await.unwrap();
    assert!(observed.requires_erc20_approval(&r).unwrap());
    assert_eq!(observed.permit_observation(&r).unwrap().nonce, 7);
    let prepared = prepare(&rpc, &p, &r, &build).await.unwrap();
    let plan = &prepared.prepared().plan;
    assert_eq!(plan.steps.len(), 3);
    assert_eq!(
        plan.steps[0].data,
        encode_call(
            "approve(address,uint256)",
            &[word(p.permit2.address), [0; 32]]
        )
    );
    assert_eq!(
        plan.steps[1].data,
        encode_call(
            "approve(address,uint256)",
            &[word(p.permit2.address), U256::from(1000).to_be_bytes()]
        )
    );
    assert_eq!(plan.steps[2].data, build.call().data.as_str());
    assert_eq!(plan.expires_at_ms, r.expires_at_ms);
    assert_eq!(prepared.prepared().first_nonce, "7");
    assert_eq!(prepared.prepared().gas_limits, vec!["70000"; 3]);
    assert_eq!(plan.maximum_network_fee_raw, "630000");
    assert_eq!(plan.minimum_receive.as_ref().unwrap().amount_raw, "1900");
    assert_eq!(prepared.review_hash(), build.review_hash());
    for (allowance, steps) in [(0, 2), (1000, 1), (2000, 1)] {
        f.allowance.store(allowance, Ordering::SeqCst);
        assert_eq!(
            prepare(&rpc, &p, &r, &build)
                .await
                .unwrap()
                .prepared()
                .plan
                .steps
                .len(),
            steps
        );
    }
    f.allowance.store(0, Ordering::SeqCst);
    f.no_return.store(1, Ordering::SeqCst);
    assert!(prepare(&rpc, &p, &r, &build).await.is_err());
    p.tokens[0].allow_empty_approval_return = true;
    assert!(prepare(&rpc, &p, &r, &build).await.is_ok());
    task.abort();
    let _ = task.await;
}
#[tokio::test]
async fn chain_code_proxy_allowance_nonce_and_reorg_failures_stop_before_simulation() {
    let (rpc, p, r, build, f, task) = setup(None).await;
    for fault in [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 24] {
        f.fault.store(fault, Ordering::SeqCst);
        assert!(prepare(&rpc, &p, &r, &build).await.is_err(), "{fault}");
    }
    assert_eq!(f.simulations.load(Ordering::SeqCst), 0);
    f.fault.store(0, Ordering::SeqCst);
    assert!(observe(&rpc, &p, &r, "11").await.is_err());
    let mut changed = r.as_ref().clone();
    changed.registry_revision = "changed".into();
    let before = f.requests.load(Ordering::SeqCst);
    assert!(prepare(&rpc, &p, &changed, &build).await.is_err());
    assert_eq!(f.requests.load(Ordering::SeqCst), before);
    task.abort();
    let _ = task.await;
}
#[tokio::test]
async fn successful_status_cannot_hide_bad_balances_allowances_gas_or_last_nonce() {
    let (rpc, p, r, build, f, task) = setup(None).await;
    for fault in [12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 29, 30] {
        f.fault.store(fault, Ordering::SeqCst);
        f.pending_reads.store(0, Ordering::SeqCst);
        assert!(prepare(&rpc, &p, &r, &build).await.is_err(), "{fault}");
    }
    task.abort();
    let _ = task.await;
}
#[tokio::test]
async fn existing_permit2_allowance_and_actual_output_fees_have_separate_checks() {
    for route in ["v3_direct", "v2_gross_fee_net"] {
        let (rpc, p, r, build, f, task) = setup(Some(route)).await;
        f.allowance.store(1000, Ordering::SeqCst);
        let result = prepare(&rpc, &p, &r, &build).await.unwrap();
        assert_eq!(result.prepared().plan.steps.len(), 1);
        assert_eq!(result.prepared().plan.fees.len(), r.authority.fees.len());
        f.fault.store(8, Ordering::SeqCst);
        assert!(prepare(&rpc, &p, &r, &build).await.is_err());
        if !r.authority.fees.is_empty() {
            f.fault.store(15, Ordering::SeqCst);
            assert!(prepare(&rpc, &p, &r, &build).await.is_err());
        }
        task.abort();
        let _ = task.await;
    }
}
#[test]
fn packed_allowance_rejects_overwide_words_and_missing_fields() {
    for v in [
        "0x".into(),
        packed(U256::from(1).wrapping_shl(160), 1, 1),
        packed(U256::from(1), 1u64 << 48, 1),
        packed(U256::from(1), 1, 1u64 << 48),
    ] {
        assert!(permit_allowance(json!(v)).is_err());
    }
    assert_eq!(
        permit_allowance(json!(packed(U256::from(1000), 10, 7))).unwrap(),
        (U256::from(1000), 10, 7)
    );
}

pub(crate) async fn service_rpc(
    r: SwapReview,
) -> (
    EvmReadRpc,
    UniswapExecutionPolicy,
    tokio::task::JoinHandle<()>,
) {
    let (_, build) = execution_fixture(now_ms() - 1, None);
    let (rpc, p, _, _, _, task) = setup_from(r, build).await;
    (rpc, p, task)
}

mod persistence;
