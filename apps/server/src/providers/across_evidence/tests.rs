use super::*;
use axum::{Json, Router, extract::State, routing::post};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/across-direct-evidence.json"
    ))
    .unwrap()
}
fn terms() -> DirectDepositTerms {
    serde_json::from_value(fixture()["terms"].clone()).unwrap()
}
fn a(n: u8) -> Address {
    Address::from_slice(&[vec![0; 19], vec![n]].concat())
}
fn word(n: u64) -> String {
    format!("{n:064x}")
}
fn change_word(v: &mut Value, n: usize, value: &str) {
    let mut data = v.as_str().unwrap().to_owned();
    data.replace_range(2 + n * 64..2 + (n + 1) * 64, value);
    *v = json!(data);
}
fn policy(source: bool) -> EvidencePolicy {
    let pin = |n| ContractPin {
        address: a(n),
        code_hash: keccak256([0x60, 0x00]),
    };
    EvidencePolicy {
        chain: if source { 1 } else { 8453 },
        spoke: pin(5),
        spoke_implementation: pin(70),
        token: pin(if source { 3 } else { 4 }),
        token_implementation: Some((TokenProxy::Usdc, pin(71))),
        wrapped_native: a(9),
    }
}
#[test]
fn independent_viem_calls_require_exact_consent_and_canonical_empty_message() {
    let f = fixture();
    let t = terms();
    let calldata = f["calldata"].as_str().unwrap();
    t.validate_calldata(calldata, U256::ZERO).unwrap();
    let legacy = format!(
        "0x{}{}",
        hex::encode(&keccak256(DEPOSIT_V3)[..4]),
        &calldata[10..]
    );
    t.validate_calldata(&legacy, U256::ZERO).unwrap();
    assert!(t.validate_calldata(calldata, U256::from(1)).is_err());
    for i in 0..13 {
        let mut changed = calldata.to_string();
        changed.replace_range(10 + i * 64..10 + (i + 1) * 64, &word(99));
        assert!(
            t.validate_calldata(&changed, U256::ZERO).is_err(),
            "word {i}"
        );
    }
    for changed in [
        format!("{calldata}00"),
        calldata[..calldata.len() - 2].into(),
        format!("0xdeadbeef{}", &calldata[10..]),
    ] {
        assert!(t.validate_calldata(&changed, U256::ZERO).is_err());
    }
    let mut bad = t.clone();
    bad.input_amount = U256::ZERO;
    assert!(bad.validate().is_err());
    bad = t.clone();
    bad.destination_chain = t.source_chain;
    assert!(bad.validate().is_err());
    bad = t.clone();
    bad.exclusive_relayer = Address::ZERO;
    assert!(bad.validate().is_err());
}
#[test]
fn swap_api_attribution_is_exact_and_bound_to_immutable_terms() {
    let f = fixture();
    let plain = f["calldata"].as_str().unwrap();
    let mut tagged = terms();
    tagged.swap_api_integrator_id = Some("0xabcd".into());
    let calldata = format!("{plain}1dc0deabcd73c0de");
    tagged.validate_calldata(&calldata, U256::ZERO).unwrap();
    assert_eq!(
        DirectDepositTerms::decode_calldata(1, Some("0xabcd".into()), &calldata, U256::ZERO)
            .unwrap(),
        tagged
    );
    assert_eq!(
        DirectDepositTerms::decode_calldata(1, None, plain, U256::ZERO).unwrap(),
        terms()
    );
    assert!(
        serde_json::to_value(terms())
            .unwrap()
            .get("swapApiIntegratorId")
            .is_none()
    );
    assert_eq!(
        serde_json::from_value::<DirectDepositTerms>(serde_json::to_value(&tagged).unwrap())
            .unwrap(),
        tagged
    );
    assert!(terms().validate_calldata(&calldata, U256::ZERO).is_err());
    assert!(tagged.validate_calldata(plain, U256::ZERO).is_err());
    assert!(
        DirectDepositTerms::decode_calldata(1, Some("0xabce".into()), &calldata, U256::ZERO)
            .is_err()
    );
    assert!(DirectDepositTerms::decode_calldata(1, None, &calldata, U256::ZERO).is_err());
    for suffix in [
        "1dc0deabcd",
        "73c0de1dc0deabcd",
        "1dc0deabcd73c0de00",
        "001dc0deabcd73c0de",
        "1dc0deabcd73c0",
        "1dc0deabcd73c0de1dc0deabcd73c0de",
    ] {
        assert!(
            tagged
                .validate_calldata(&format!("{plain}{suffix}"), U256::ZERO)
                .is_err(),
            "suffix {suffix}"
        );
    }
    // Each byte of the delimiter, ID and swap marker is consent, not arbitrary metadata.
    for i in 420..428 {
        let mut bytes = hex::decode(&calldata[2..]).unwrap();
        bytes[i] ^= 1;
        assert!(
            tagged
                .validate_calldata(&format!("0x{}", hex::encode(bytes)), U256::ZERO)
                .is_err(),
            "byte {i}"
        );
    }
    for id in [
        "", "abcd", "0xabc", "0xabcde", "0xABCD", "0xabcg", "0Xabcd", "0xéab",
    ] {
        let mut bad = tagged.clone();
        bad.swap_api_integrator_id = Some(id.into());
        assert!(bad.validate().is_err(), "id {id}");
    }
    let legacy = format!(
        "0x{}{}",
        hex::encode(&keccak256(DEPOSIT_V3)[..4]),
        &calldata[10..]
    );
    tagged.validate_calldata(&legacy, U256::ZERO).unwrap();
    for value in [U256::from(1), U256::MAX] {
        assert!(
            DirectDepositTerms::decode_calldata(1, Some("0xabcd".into()), &calldata, value)
                .is_err()
        );
    }
}
#[test]
fn candidate_decoder_rejects_truncated_and_noncanonical_abi() {
    let f = fixture();
    let plain = f["calldata"].as_str().unwrap();
    for length in [0, 1, 3, 4, 32, 388, 419] {
        assert!(
            DirectDepositTerms::decode_calldata(1, None, &plain[..2 + length * 2], U256::ZERO)
                .is_err()
        );
    }
    for (index, replacement) in [
        (0, format!("1{}", "0".repeat(63))),
        (1, format!("1{}", "0".repeat(63))),
        (2, format!("1{}", "0".repeat(63))),
        (3, format!("1{}", "0".repeat(63))),
        (6, "f".repeat(64)),
        (7, format!("1{}", "0".repeat(63))),
        (8, word(u64::from(u32::MAX) + 1)),
        (9, word(u64::from(u32::MAX) + 1)),
        (10, word(u64::from(u32::MAX) + 1)),
        (11, word(416)),
        (12, word(1)),
    ] {
        let mut changed = plain.to_string();
        changed.replace_range(10 + index * 64..10 + (index + 1) * 64, &replacement);
        assert!(
            DirectDepositTerms::decode_calldata(1, None, &changed, U256::ZERO).is_err(),
            "word {index}"
        );
    }
    assert!(
        DirectDepositTerms::decode_calldata(
            1,
            None,
            &format!("0xdeadbeef{}", &plain[10..]),
            U256::ZERO
        )
        .is_err()
    );
}
#[test]
fn bounded_abi_decoders_reject_padding_overflow_and_unsafe_json_amounts() {
    assert!(hex_bytes("0x0", 32).is_err());
    assert!(hex_bytes(&format!("0x{}", "00".repeat(33)), 32).is_err());
    let mut bytes = vec![0; 32];
    bytes[0] = 1;
    let abi = Words::new(&bytes, 1).unwrap();
    assert!(abi.address(0).is_err());
    assert!(abi.small(0).is_err());
    assert!(abi.uint(1).is_err());
    for input in [json!(1000000), json!("01"), json!("-1"), json!("1e6")] {
        let mut t = fixture()["terms"].clone();
        t["inputAmount"] = input;
        assert!(serde_json::from_value::<DirectDepositTerms>(t).is_err());
    }
}
struct Mock {
    source: bool,
    fixture: Value,
    fault: Mutex<&'static str>,
    block_reads: AtomicUsize,
    requests: AtomicUsize,
}
impl Mock {
    fn set(&self, s: &'static str) {
        *self.fault.lock().unwrap() = s;
        self.block_reads.store(0, Ordering::SeqCst);
    }
}
async fn handler(State(m): State<Arc<Mock>>, Json(request): Json<Value>) -> Json<Value> {
    m.requests.fetch_add(1, Ordering::SeqCst);
    let fault = *m.fault.lock().unwrap();
    let f = &m.fixture;
    let p = &request["params"];
    let tx = f[if m.source {
        "sourceReceipt"
    } else {
        "fillReceipt"
    }]["transactionHash"]
        .clone();
    let result = match request["method"].as_str().unwrap() {
        "eth_chainId" => {
            let chain = if fault == "chain" {
                2
            } else {
                f["terms"][if m.source {
                    "sourceChain"
                } else {
                    "destinationChain"
                }]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
            };
            json!(format!("0x{chain:x}"))
        }
        "eth_getBlockByNumber" => {
            let final_block = p[0] == "finalized" || p[0] == "0x14";
            let reads = if !final_block {
                m.block_reads.fetch_add(1, Ordering::SeqCst)
            } else {
                0
            };
            let reorg = fault == "reorg" && reads > 0 || fault == "source_after_fill" && reads > 2;
            json!({"number":if final_block{if fault=="unfinalized"{"0x9"}else{"0x14"}}else{"0xa"},
              "hash":if final_block||reorg{format!("0x{}","bb".repeat(32))}else{format!("0x{}","aa".repeat(32))},
              "timestamp":format!("0x{:x}",if fault=="late_fill"{1700003601u32}else{1700000000u32}),
              "transactions":[if fault=="block_tx"{json!(format!("0x{}","33".repeat(32)))}else{tx}]})
        }
        "eth_getCode" => json!(if fault == "code" { "0x6001" } else { "0x6000" }),
        "eth_getStorageAt" => json!(format!(
            "0x{}",
            word(if fault == "implementation" {
                99
            } else if p[0] == format!("{:#x}", a(5)) {
                70
            } else {
                71
            })
        )),
        "eth_call" => json!(format!(
            "0x{}",
            word(if fault == "wrapped" { 4 } else { 9 })
        )),
        "eth_getTransactionByHash" => {
            let mut t = f["sourceTransaction"].clone();
            if fault == "calldata" {
                t["input"] = json!("0xdeadbeef");
            }
            if fault == "native" {
                t["value"] = json!("0x1");
            }
            t
        }
        "eth_getTransactionReceipt" => {
            let mut r = f[if m.source {
                "sourceReceipt"
            } else {
                "fillReceipt"
            }]
            .clone();
            let ei = if m.source { 1 } else { 0 };
            let ti = if m.source { 0 } else { 1 };
            match fault {
                "missing" => r = Value::Null,
                "failed" => r["status"] = json!("0x0"),
                "wrong_from" => r["from"] = json!(format!("{:#x}", a(99))),
                "wrong_to" => r["to"] = json!(format!("{:#x}", a(99))),
                "removed" => r["logs"][ei]["removed"] = json!(true),
                "log_hash" => {
                    r["logs"][ei]["transactionHash"] = json!(format!("0x{}", "33".repeat(32)))
                }
                "duplicate" => {
                    let mut log = r["logs"][ei].clone();
                    log["logIndex"] = json!("0x4");
                    r["logs"].as_array_mut().unwrap().push(log);
                }
                "transfer_amount" => change_word(&mut r["logs"][ti]["data"], 0, &word(1)),
                "transfer_recipient" => {
                    r["logs"][ti]["topics"][2] = json!(format!("0x{}", word(99)))
                }
                "event_recipient" => change_word(
                    &mut r["logs"][ei]["data"],
                    if m.source { 7 } else { 9 },
                    &word(99),
                ),
                "event_token" => change_word(&mut r["logs"][ei]["data"], 1, &word(99)),
                "event_amount" => change_word(&mut r["logs"][ei]["data"], 3, &word(1)),
                "event_chain" => r["logs"][ei]["topics"][1] = json!(format!("0x{}", word(99))),
                "exclusivity" => change_word(&mut r["logs"][ei]["data"], 6, &word(60)),
                "updated_recipient" => change_word(&mut r["logs"][ei]["data"], 11, &word(99)),
                "updated_amount" => change_word(&mut r["logs"][ei]["data"], 13, &word(1)),
                "message" => change_word(&mut r["logs"][ei]["data"], 10, &word(1)),
                "updated_message" => change_word(&mut r["logs"][ei]["data"], 12, &word(1)),
                "fill_type" => change_word(&mut r["logs"][ei]["data"], 14, &word(3)),
                "slow_fill" => change_word(&mut r["logs"][ei]["data"], 14, &word(2)),
                "deposit_id" => r["logs"][ei]["topics"][2] = json!(format!("0x{}", word(8))),
                "outgoing" => {
                    let mut log = r["logs"][ti].clone();
                    log["logIndex"] = json!("0x4");
                    log["topics"][1] = log["topics"][2].clone();
                    log["topics"][2] = json!(format!("0x{}", word(99)));
                    r["logs"].as_array_mut().unwrap().push(log);
                }
                _ => {}
            }
            r
        }
        other => panic!("unexpected RPC {other}"),
    };
    Json(json!({"jsonrpc":"2.0","id":1,"result":result}))
}
async fn start(source: bool) -> (EvmReadRpc, Arc<Mock>, tokio::task::JoinHandle<()>) {
    start_fixture(source, fixture()).await
}
async fn start_fixture(
    source: bool,
    fixture: Value,
) -> (EvmReadRpc, Arc<Mock>, tokio::task::JoinHandle<()>) {
    let state = Arc::new(Mock {
        source,
        fixture,
        fault: Mutex::new(""),
        block_reads: AtomicUsize::new(0),
        requests: AtomicUsize::new(0),
    });
    let app = Router::new()
        .route("/", post(handler))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rpc = EvmReadRpc::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (rpc, state, task)
}
#[tokio::test]
#[ignore = "requires loopback RPC fixture listeners"]
async fn finalized_source_and_fill_bind_all_terms_and_standard_token_payment() {
    let (sr, s, st) = start(true).await;
    let (dr, d, dt) = start(false).await;
    let f = fixture();
    let sh = hash(&f["sourceReceipt"]["transactionHash"]).unwrap();
    let dh = hash(&f["fillReceipt"]["transactionHash"]).unwrap();
    let result = verify_delivery(&sr, &policy(true), &dr, &policy(false), &terms(), sh, dh)
        .await
        .unwrap();
    assert_eq!(result.deposit().deposit_id(), "7");
    assert_eq!(result.deposit.exclusivity_deadline, 1700000060);
    assert_eq!(result.destination().log_index, 2);
    assert_eq!(result.destination().finalized_number, 20);
    assert_eq!(result.fill_type, 0);
    s.set("");
    d.set("slow_fill");
    assert_eq!(
        verify_delivery(&sr, &policy(true), &dr, &policy(false), &terms(), sh, dh)
            .await
            .unwrap()
            .fill_type,
        2
    );
    s.set("source_after_fill");
    d.set("");
    let before_destination = d.requests.load(Ordering::SeqCst);
    assert!(matches!(
        verify_delivery(&sr, &policy(true), &dr, &policy(false), &terms(), sh, dh).await,
        Err(EvidenceError::Reorg)
    ));
    assert!(d.requests.load(Ordering::SeqCst) > before_destination);
    st.abort();
    dt.abort();
}
#[tokio::test]
#[ignore = "requires loopback RPC fixture listeners"]
async fn malformed_identity_reorg_changed_fill_and_missing_transfer_never_prove_delivery() {
    let (sr, s, st) = start(true).await;
    let (dr, d, dt) = start(false).await;
    let f = fixture();
    let sh = hash(&f["sourceReceipt"]["transactionHash"]).unwrap();
    let dh = hash(&f["fillReceipt"]["transactionHash"]).unwrap();
    for fault in [
        "chain",
        "missing",
        "failed",
        "unfinalized",
        "wrong_from",
        "wrong_to",
        "removed",
        "log_hash",
        "duplicate",
        "transfer_amount",
        "transfer_recipient",
        "event_recipient",
        "event_token",
        "event_amount",
        "event_chain",
        "exclusivity",
        "message",
        "outgoing",
        "calldata",
        "native",
        "code",
        "implementation",
        "wrapped",
        "block_tx",
        "reorg",
    ] {
        s.set(fault);
        d.set("");
        assert!(
            verify_delivery(&sr, &policy(true), &dr, &policy(false), &terms(), sh, dh)
                .await
                .is_err(),
            "source fault {fault}"
        );
    }
    for fault in [
        "chain",
        "missing",
        "failed",
        "unfinalized",
        "wrong_to",
        "removed",
        "log_hash",
        "duplicate",
        "transfer_amount",
        "transfer_recipient",
        "event_recipient",
        "event_token",
        "event_amount",
        "event_chain",
        "exclusivity",
        "message",
        "outgoing",
        "updated_recipient",
        "updated_amount",
        "updated_message",
        "fill_type",
        "deposit_id",
        "code",
        "implementation",
        "wrapped",
        "block_tx",
        "reorg",
        "late_fill",
    ] {
        s.set("");
        d.set(fault);
        assert!(
            verify_delivery(&sr, &policy(true), &dr, &policy(false), &terms(), sh, dh)
                .await
                .is_err(),
            "destination fault {fault}"
        );
    }
    st.abort();
    dt.abort();
}

pub(super) async fn source_proof() -> VerifiedAcrossDeposit {
    let (rpc, _, task) = start(true).await;
    let hash = hash(&fixture()["sourceReceipt"]["transactionHash"]).unwrap();
    let proof = verify_deposit(&rpc, &policy(true), &terms(), hash)
        .await
        .unwrap();
    task.abort();
    proof
}
pub(super) async fn delivery_proof() -> VerifiedAcrossFill {
    let (source, _, source_task) = start(true).await;
    let (destination, _, destination_task) = start(false).await;
    let f = fixture();
    let proof = verify_delivery(
        &source,
        &policy(true),
        &destination,
        &policy(false),
        &terms(),
        hash(&f["sourceReceipt"]["transactionHash"]).unwrap(),
        hash(&f["fillReceipt"]["transactionHash"]).unwrap(),
    )
    .await
    .unwrap();
    source_task.abort();
    destination_task.abort();
    proof
}

// Local-chain variant still obtains unforgeable proofs through the full RPC
// verifier; only fixture chain IDs and the exact integrator suffix differ.
pub(crate) async fn local_delivery_proof() -> VerifiedAcrossFill {
    let mut f = fixture();
    f["terms"]["sourceChain"] = json!("31337");
    f["terms"]["destinationChain"] = json!("31338");
    f["terms"]["swapApiIntegratorId"] = json!("0xabcd");
    let mut calldata = f["calldata"].as_str().unwrap().to_owned();
    calldata.replace_range(10 + 6 * 64..10 + 7 * 64, &word(31338));
    calldata.push_str("1dc0deabcd73c0de");
    f["sourceTransaction"]["input"] = json!(calldata);
    f["sourceTransaction"]["chainId"] = json!("0x7a69");
    f["sourceReceipt"]["logs"][1]["topics"][1] = json!(format!("0x{}", word(31338)));
    f["fillReceipt"]["logs"][0]["topics"][1] = json!(format!("0x{}", word(31337)));
    let mut sp = policy(true);
    sp.chain = 31337;
    let mut dp = policy(false);
    dp.chain = 31338;
    let (sr, _, st) = start_fixture(true, f.clone()).await;
    let (dr, _, dt) = start_fixture(false, f.clone()).await;
    let proof = verify_delivery(
        &sr,
        &sp,
        &dr,
        &dp,
        &serde_json::from_value(f["terms"].clone()).unwrap(),
        hash(&f["sourceReceipt"]["transactionHash"]).unwrap(),
        hash(&f["fillReceipt"]["transactionHash"]).unwrap(),
    )
    .await
    .unwrap();
    st.abort();
    dt.abort();
    proof
}
