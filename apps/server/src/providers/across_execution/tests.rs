use super::*;
use axum::{Json, Router, extract::State, routing::post};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
const HEAD: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
fn a(n: u8) -> Address {
    Address::from_word(U256::from(n).to_be_bytes::<32>().into())
}
fn pin(n: u8) -> ContractPin {
    ContractPin {
        address: a(n),
        code_hash: keccak256([0x60, 0]),
    }
}
fn review() -> AcrossPreparationRequest {
    // The source fixture is produced by viem, not this preparation encoder.
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/across-direct-evidence.json"
    ))
    .unwrap();
    let mut terms: DirectDepositTerms = serde_json::from_value(fixture["terms"].clone()).unwrap();
    let now = now_ms();
    let seconds = (now / 1000) as u32;
    terms.quote_timestamp = seconds - 100;
    terms.fill_deadline = seconds + 3600;
    terms.swap_api_integrator_id = Some("0xabcd".into());
    let mut data = fixture["calldata"].as_str().unwrap().to_owned();
    for (word, n) in [(8, terms.quote_timestamp), (9, terms.fill_deadline)] {
        data.replace_range(10 + word * 64..10 + (word + 1) * 64, &format!("{n:064x}"));
    }
    data.push_str("1dc0deabcd73c0de");
    AcrossPreparationRequest {
        terms,
        source_spoke: hex_address(a(5)),
        calldata: data,
        quote_id: "fixture-quote".into(),
        registry_revision: "fixture-v1".into(),
        intent_hash: "ab".repeat(32),
        quoted_at_ms: now,
        quote_expires_at_ms: now + 30000,
        provider_expires_at_ms: None,
        execution_deadline_ms: now + 900_000,
        maximum_network_fee_raw: "10000000".into(),
    }
}
fn set_word(r: &mut AcrossPreparationRequest, index: usize, value: u32) {
    let start = 10 + index * 64;
    r.calldata
        .replace_range(start..start + 64, &format!("{value:064x}"));
}
fn policy() -> AcrossExecutionPolicy {
    AcrossExecutionPolicy {
        source: EvidencePolicy {
            chain: 1,
            spoke: pin(5),
            spoke_implementation: pin(70),
            token: pin(3),
            token_implementation: Some((TokenProxy::Usdc, pin(71))),
            wrapped_native: a(9),
        },
        registry_revision: "fixture-v1".into(),
        decimals: 6,
        allow_empty_approval_return: false,
        maximum_gas_per_transaction: 500000,
    }
}
fn word_hex(n: U256) -> String {
    format!("0x{n:064x}")
}
#[derive(Clone)]
struct Mock {
    review: Arc<AcrossPreparationRequest>,
    fault: Arc<AtomicUsize>,
    allowance: Arc<AtomicUsize>,
    pending: Arc<AtomicUsize>,
    simulations: Arc<AtomicUsize>,
}
async fn handler(State(f): State<Mock>, Json(v): Json<Value>) -> Json<Value> {
    let method = v["method"].as_str().unwrap();
    let p = &v["params"];
    let fault = f.fault.load(Ordering::SeqCst);
    let r = &f.review;
    let owner = hex_address(r.terms.depositor);
    let token = hex_address(r.terms.input_token);
    let now = (now_ms() / 1000) as u64;
    let amount = r.terms.input_amount;
    let allowance = if f.allowance.load(Ordering::SeqCst) == usize::MAX {
        U256::MAX
    } else {
        U256::from(f.allowance.load(Ordering::SeqCst))
    };
    let balance = U256::from(2000000);
    let pool_balance = U256::from(5000000);
    let result = match method {
        "eth_chainId" => json!(if fault == 1 { "0x2" } else { "0x1" }),
        "eth_getBlockByNumber" => {
            json!({"number":"0xa","hash":if fault==22&&p[0]=="0xa"{OTHER}else{HEAD},
            "timestamp":format!("0x{:x}",if fault==2 {now-121}else{now}),"baseFeePerGas":"0x1"})
        }
        "eth_getCode" => json!(if p[0] == owner {
            if fault == 3 { "0xef0100" } else { "0x" }
        } else if fault == 4 && p[0] == r.source_spoke || fault == 5 && p[0] == hex_address(a(70)) {
            "0x6001"
        } else {
            "0x6000"
        }),
        "eth_getStorageAt" => {
            assert_eq!(p[2], "0xa");
            let implementation = if p[0] == r.source_spoke {
                assert_eq!(p[1], evm_prepare::AAVE_IMPLEMENTATION_SLOT);
                70
            } else {
                assert_eq!(p[0], token);
                assert_eq!(p[1], evm_prepare::USDC_IMPLEMENTATION_SLOT);
                71
            };
            json!(word_hex(U256::from(if fault == 6 {
                99
            } else {
                implementation
            })))
        }
        "eth_getTransactionCount" => {
            if p[1] == "pending" {
                let index = f.pending.fetch_add(1, Ordering::SeqCst);
                json!(if fault == 10 || fault == 23 && index > 0 {
                    "0x8"
                } else {
                    "0x7"
                })
            } else {
                assert_eq!(p[1], "0xa");
                json!("0x7")
            }
        }
        "eth_getBalance" => json!(if fault == 20 {
            "0x0"
        } else {
            "0xde0b6b3a7640000"
        }),
        "eth_maxPriorityFeePerGas" => json!(if fault == 21 {
            "0xffffffffffffffffffffffffffffffff"
        } else {
            "0x1"
        }),
        "eth_call" => {
            assert_eq!(p[1], "0xa");
            let data = p[0]["data"].as_str().unwrap();
            if p[0]["to"] == r.source_spoke {
                assert_eq!(data, encode_call("wrappedNativeToken()", &[]));
                json!(word_hex(U256::from(if fault == 7 { 8 } else { 9 })))
            } else {
                assert_eq!(p[0]["to"], token);
                let value = if data == encode_call("decimals()", &[]) {
                    U256::from(if fault == 8 { 18 } else { 6 })
                } else if data.starts_with("0xdd62ed3e") {
                    allowance
                } else if data == encode_call("balanceOf(address)", &[word(r.terms.depositor)]) {
                    if fault == 9 {
                        amount - U256::from(1)
                    } else {
                        balance
                    }
                } else {
                    assert_eq!(data, encode_call("balanceOf(address)", &[word(a(5))]));
                    pool_balance
                };
                json!(word_hex(value))
            }
        }
        "eth_simulateV1" => {
            f.simulations.fetch_add(1, Ordering::SeqCst);
            assert_eq!(p[1], "0xa");
            assert_eq!(p[0]["validation"], false);
            let calls = p[0]["blockStateCalls"][0]["calls"].as_array().unwrap();
            let action = calls
                .iter()
                .position(|c| c["to"] == r.source_spoke)
                .unwrap();
            assert!((3..=5).contains(&action));
            assert_eq!(calls[action]["data"], r.calldata);
            let mut results = Vec::new();
            for (i, c) in calls.iter().enumerate() {
                assert_eq!(c["from"], owner);
                assert_eq!(c["value"], "0x0");
                let data = c["data"].as_str().unwrap();
                let after = i > action;
                let returned = if data.starts_with("0x70a08231") {
                    let who = format!("0x{}", &data[34..74]);
                    let n = if who == owner {
                        if after {
                            balance - amount + U256::from(usize::from(fault == 12))
                        } else {
                            balance + U256::from(usize::from(fault == 24))
                        }
                    } else {
                        assert_eq!(who, r.source_spoke);
                        if after {
                            pool_balance + amount - U256::from(usize::from(fault == 13))
                        } else {
                            pool_balance
                        }
                    };
                    word_hex(n)
                } else if data.starts_with("0xdd62ed3e") {
                    let remaining = if allowance < amount {
                        U256::ZERO
                    } else if allowance == U256::MAX {
                        U256::MAX
                    } else {
                        allowance - amount
                    };
                    word_hex(if after {
                        if fault == 14 {
                            U256::from(99)
                        } else {
                            remaining
                        }
                    } else {
                        allowance
                    })
                } else if i < action {
                    assert!(data.starts_with("0x095ea7b3"));
                    assert_eq!(&data[34..74], &r.source_spoke[2..]);
                    let approved = U256::from_str_radix(&data[74..], 16).unwrap();
                    assert_eq!(
                        approved,
                        if action == 5 && i == 3 {
                            U256::ZERO
                        } else {
                            amount
                        }
                    );
                    if fault == 16 {
                        "0x".into()
                    } else {
                        word_hex(U256::from(usize::from(fault != 15)))
                    }
                } else {
                    "0x".into()
                };
                let mut result = json!({"status":if fault==11&&i==action {"0x0"}else{"0x1"},"returnData":returned,"gasUsed":if fault==19 {"0x7a120"}else{"0xc350"}});
                if fault == 25 && i == action {
                    result["error"] = json!({"message":"private provider revert"});
                }
                results.push(result);
            }
            if fault == 26 {
                results.push(json!({}));
            }
            json!([{"parentHash":if fault==17 {OTHER}else{HEAD},"timestamp":format!("0x{:x}",if fault==18 {(r.execution_deadline_ms/1000) as u64}else{now+1}),"calls":results}])
        }
        _ => panic!("unexpected RPC method {method}"),
    };
    Json(json!({"jsonrpc":"2.0","id":v["id"],"result":result}))
}
async fn server() -> (EvmReadRpc, Mock, tokio::task::JoinHandle<()>) {
    let f = Mock {
        review: Arc::new(review()),
        fault: Arc::new(AtomicUsize::new(0)),
        allowance: Arc::new(AtomicUsize::new(0)),
        pending: Arc::new(AtomicUsize::new(0)),
        simulations: Arc::new(AtomicUsize::new(0)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc = EvmReadRpc::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let app = Router::new()
        .route("/", post(handler))
        .with_state(f.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (rpc, f, task)
}
#[test]
fn serialized_review_is_structural_consent_not_unchecked_authority() {
    let r = review();
    r.validate().unwrap();
    let copy: AcrossPreparationRequest =
        serde_json::from_value(serde_json::to_value(&r).unwrap()).unwrap();
    assert_eq!(r.integrity_hash().unwrap(), copy.integrity_hash().unwrap());
    for mutation in 0..9 {
        let mut bad = r.clone();
        match mutation {
            0 => bad.source_spoke = hex_address(a(0)),
            1 => bad.intent_hash = "AB".repeat(32),
            2 => bad.maximum_network_fee_raw = "01".into(),
            3 => bad.quote_expires_at_ms += 1,
            4 => bad.terms.recipient = a(9),
            5 => bad.calldata.push_str("00"),
            6 => bad.terms.swap_api_integrator_id = None,
            7 => bad.quoted_at_ms = -1,
            _ => bad.registry_revision = "../secret".into(),
        }
        assert!(bad.validate().is_err(), "accepted mutation {mutation}");
    }
    let mut value = serde_json::to_value(&r).unwrap();
    value["unexpected"] = json!(true);
    assert!(serde_json::from_value::<AcrossPreparationRequest>(value).is_err());
    let rpc = EvmReadRpc::new("http://127.0.0.1:8545").unwrap();
    let mut p = policy();
    p.source.chain = 31337;
    assert!(super::policy(&rpc, &p, &r, true).is_err());
}
#[test]
fn review_rejects_changed_terms_and_expired_absolute_exclusivity() {
    let original = review();
    let mut absolute = original.clone();
    let expiry_seconds = ((absolute.execution_deadline_ms + 999) / 1000) as u32;
    absolute.terms.exclusivity_parameter = expiry_seconds + 60;
    let parameter = absolute.terms.exclusivity_parameter;
    set_word(&mut absolute, 10, parameter);
    absolute.validate().unwrap();

    let mut expired = absolute.clone();
    expired.terms.exclusivity_parameter = expiry_seconds - 1;
    let parameter = expired.terms.exclusivity_parameter;
    set_word(&mut expired, 10, parameter);
    assert!(expired.validate().is_err());

    let mut too_late = absolute;
    too_late.terms.exclusivity_parameter = too_late.terms.fill_deadline + 1;
    let parameter = too_late.terms.exclusivity_parameter;
    set_word(&mut too_late, 10, parameter);
    assert!(too_late.validate().is_err());

    let mut changed_amount = original;
    changed_amount.terms.input_amount -= U256::from(1);
    assert!(changed_amount.validate().is_err());
}
#[tokio::test]
#[ignore = "requires localhost listener"]
async fn finite_approvals_exact_source_payment_and_existing_authority_are_simulated() {
    let (rpc, f, task) = server().await;
    let p = policy();
    for (allowance, count) in [(0, 2), (1, 3), (1000000, 1), (2000000, 1), (usize::MAX, 1)] {
        f.allowance.store(allowance, Ordering::SeqCst);
        let result = prepare(&rpc, &p, &f.review).await.unwrap();
        result.validate_signing_terms().unwrap();
        assert_eq!(result.plan.steps.len(), count);
        assert!(result.plan.minimum_receive.is_none());
        assert!(result.plan.fees.is_empty());
        assert_eq!(result.plan.maximum_spend.recipient, f.review.source_spoke);
        assert_eq!(result.plan.maximum_spend.amount_raw, "1000000");
        assert_eq!(result.plan.steps.last().unwrap().data, f.review.calldata);
        assert_eq!(result.first_nonce, "7");
        assert_eq!(result.max_fee_per_gas, "3");
        assert_eq!(
            result.plan.maximum_network_fee_raw,
            (count * 70000 * 3).to_string()
        );
        assert_eq!(result.plan.fee_policy_revision, FEE_POLICY_REVISION);
        assert!(result.plan.expires_at_ms > f.review.quote_expires_at_ms);
        assert!(result.plan.expires_at_ms <= result.plan.simulation.observed_at_ms + 300000);
    }
    f.allowance.store(0, Ordering::SeqCst);
    f.fault.store(16, Ordering::SeqCst);
    assert!(matches!(
        prepare(&rpc, &p, &f.review).await,
        Err(E::Simulation)
    ));
    let mut legacy = p;
    legacy.allow_empty_approval_return = true;
    prepare(&rpc, &legacy, &f.review).await.unwrap();
    task.abort();
}
#[tokio::test]
#[ignore = "requires localhost listener"]
async fn revalidation_survives_quote_cache_expiry_but_keeps_persisted_plan_deadline() {
    let (rpc, f, task) = server().await;
    let p = policy();
    let mut request = f.review.as_ref().clone();
    let now = now_ms();
    request.quoted_at_ms = now - 31_000;
    request.quote_expires_at_ms = request.quoted_at_ms + 30_000;
    let expiry = now + 120_000;
    let before = f.simulations.load(Ordering::SeqCst);
    assert!(prepare(&rpc, &p, &request).await.is_err());
    assert_eq!(f.simulations.load(Ordering::SeqCst), before);
    let prepared = revalidate(&rpc, &p, &request, expiry).await.unwrap();
    assert!(prepared.plan.expires_at_ms <= expiry);
    assert!(prepared.plan.expires_at_ms > now);
    assert!(revalidate(&rpc, &p, &request, now - 1).await.is_err());
    assert!(
        revalidate(&rpc, &p, &request, request.execution_deadline_ms + 1)
            .await
            .is_err()
    );
    task.abort();
}
#[tokio::test]
#[ignore = "requires localhost listener"]
async fn pins_nonce_simulated_deltas_gas_and_reorgs_all_fail_closed() {
    let (rpc, f, task) = server().await;
    let p = policy();
    f.allowance.store(1, Ordering::SeqCst);
    for fault in 1..=26 {
        f.fault.store(fault, Ordering::SeqCst);
        f.pending.store(0, Ordering::SeqCst);
        assert!(
            prepare(&rpc, &p, &f.review).await.is_err(),
            "accepted fault {fault}"
        );
    }
    f.fault.store(0, Ordering::SeqCst);
    let mut low = f.review.as_ref().clone();
    low.maximum_network_fee_raw = "1".into();
    assert!(matches!(prepare(&rpc, &p, &low).await, Err(E::Fees)));
    let mut expired = f.review.as_ref().clone();
    expired.quote_expires_at_ms = now_ms() - 1;
    let before = f.simulations.load(Ordering::SeqCst);
    assert!(prepare(&rpc, &p, &expired).await.is_err());
    assert_eq!(f.simulations.load(Ordering::SeqCst), before);
    task.abort();
}
