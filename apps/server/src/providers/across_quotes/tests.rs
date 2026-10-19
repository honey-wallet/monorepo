use super::*;
use serde_json::json;

const NOW: i64 = 1_700_000_000_000;
fn a(n: u8) -> String {
    format!("0x{n:040x}")
}
fn config() -> FileConfig {
    serde_json::from_value(json!({
        "apiKey":"private-fixture-token", "accountScope":"fixture", "intervalMs":1,
        "sourceChainId":"1", "integratorId":"0xabcd", "registryRevision":"fixture-v1",
        "routes":[{"id":"usdc-base", "destinationChainId":"8453", "sourceSpoke":a(5),
            "inputToken":{"assetId":"usdc-mainnet","address":a(3),"symbol":"USDC","decimals":6},
            "outputToken":{"assetId":"usdc-mainnet","address":a(4),"symbol":"USDC.e","decimals":6},
            "minimumInputRaw":"100000", "maximumInputRaw":"100000000",
            "maximumBridgeFeeBps":200, "maximumFillSeconds":3600,
            "maximumExclusivitySeconds":120}]
    }))
    .unwrap()
}
fn redis(url: &str) -> RedisStore {
    RedisStore::new(
        redis::Client::open(url).unwrap(),
        format!("across-quote-{}", uuid::Uuid::new_v4().simple()),
        Duration::from_secs(2),
    )
}
fn client() -> AcrossQuotes {
    // Constructor does not connect; pure normalization tests perform no network I/O.
    AcrossQuotes::new(
        config(),
        1,
        redis("redis://127.0.0.1:1"),
        Arc::new(Metrics::default()),
    )
    .unwrap()
}
fn request() -> AcrossQuoteRequest {
    AcrossQuoteRequest {
        route_id: "usdc-base".into(),
        amount_raw: "1000000".into(),
        minimum_output_raw: "980000".into(),
        recipient: a(2),
    }
}
fn input_token() -> Value {
    json!({"address":a(3),"symbol":"USDC","decimals":6,"chainId":1})
}
fn output_token() -> Value {
    json!({"address":a(4),"symbol":"USDC","decimals":6,"chainId":8453})
}
fn fixture(now: i64) -> Value {
    // Calldata originates from the independently generated viem fixture. Updating
    // the clock words keeps transport fixtures valid without using our decoder.
    let source: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/across-direct-evidence.json"
    ))
    .unwrap();
    let mut data = format!("{}1dc0deabcd73c0de", source["calldata"].as_str().unwrap());
    for (word, n) in [(8, now as u64 / 1000 - 100), (9, now as u64 / 1000 + 3600)] {
        data.replace_range(10 + word * 64..10 + (word + 1) * 64, &format!("{n:064x}"));
    }
    let fee = json!({"amount":"10000", "pct":"10000000000000000", "token":input_token()});
    json!({"crossSwapType":"bridgeableToBridgeable", "amountType":"exactInput",
        "checks":{"allowance":{"token":a(3),"spender":a(5),"actual":"0","expected":"1000000"},
                  "balance":{"token":a(3),"actual":"2000000","expected":"1000000"}},
        "approvalTxns":null,
        "steps":{"bridge":{"provider":"across","inputAmount":"1000000","outputAmount":"990000",
            "tokenIn":input_token(),"tokenOut":output_token(),"fees":fee}},
        "inputToken":input_token(),"outputToken":output_token(),"refundToken":input_token(),
        "fees":{"total":fee},"inputAmount":"1000000","maxInputAmount":"1000000",
        "expectedOutputAmount":"990000","minOutputAmount":"990000","expectedFillTime":10,
        "id":"fixture-quote", "swapTx":{"simulationSuccess":true,"chainId":1,"to":a(5),
            "data":data,"value":"0","gas":"150000","maxFeePerGas":"200","maxPriorityFeePerGas":"2"}})
}
fn change_word(v: &mut Value, word: usize, n: u64) {
    let data = v["swapTx"]["data"].as_str().unwrap();
    let mut data = data.to_owned();
    data.replace_range(10 + word * 64..10 + (word + 1) * 64, &format!("{n:064x}"));
    v["swapTx"]["data"] = json!(data);
}
fn approve(amount: U256) -> Value {
    json!({"chainId":1,"to":a(3),"data":format!("0x095ea7b3{:064x}{amount:064x}",5)})
}
fn rejected(client: &AcrossQuotes, v: &Value) -> bool {
    client.normalize(&a(1), &request(), v, NOW).is_err()
}

#[test]
fn direct_quote_binds_economics_and_returns_no_signing_authority() {
    let c = client();
    let mut v = fixture(NOW);
    let q = c.normalize(&a(1), &request(), &v, NOW).unwrap();
    assert_eq!(q.quote().bridge_fee_raw, "10000");
    assert_eq!(q.quote().integrator_fee_raw, "0");
    assert_eq!(q.quote().minimum_output_raw, "990000");
    assert_eq!(q.quote().refund_recipient, a(1));
    assert_eq!(q.quote().refund_chain_id, "1");
    assert_eq!(q.quote().source_gas_estimate_raw, "150000");
    assert_eq!(q.quote().expires_at_ms, NOW + 30000);
    assert_eq!(q.quote().provider_expires_at_ms, None);
    assert!(!q.quote().execution_available && !q.quote().approval_gas_included);
    assert_eq!(q.terms().swap_api_integrator_id.as_deref(), Some("0xabcd"));
    assert!(q.calldata().ends_with("1dc0deabcd73c0de"));
    let public = serde_json::to_value(q.quote()).unwrap().to_string();
    for private in [
        "private-fixture-token",
        "approvalTxns",
        "swapTx",
        "calldata",
    ] {
        assert!(!public.contains(private));
    }
    // The SDK marks maxInputAmount optional. An omitted redundant bound is safe
    // only because exact-input calldata and all other amounts are still checked.
    v.as_object_mut().unwrap().remove("maxInputAmount");
    c.normalize(&a(1), &request(), &v, NOW).unwrap();
    for key in ["totalMax", "maxTotal"] {
        v["fees"][key] = v["fees"]["total"].clone();
    }
    c.normalize(&a(1), &request(), &v, NOW).unwrap();
}

#[test]
fn response_cannot_change_identity_targets_economics_or_route_kind() {
    let c = client();
    let v = fixture(NOW);
    for (path, value) in [
        ("/crossSwapType", json!("anyToAny")),
        ("/amountType", json!("exactOutput")),
        ("/steps/originSwap", json!({})),
        ("/steps/destinationSwap", json!({})),
        ("/steps/bridge/provider", json!("cctp")),
        ("/swapTx/eip712", json!({})),
        ("/swapTx/chainId", json!(8453)),
        ("/swapTx/to", json!(a(9))),
        ("/swapTx/value", json!("1")),
        ("/swapTx/simulationSuccess", json!(false)),
        ("/inputAmount", json!("1000001")),
        ("/maxInputAmount", json!("1000001")),
        ("/expectedOutputAmount", json!("989999")),
        ("/minOutputAmount", json!("980000")),
        ("/steps/bridge/inputAmount", json!("1000001")),
        ("/steps/bridge/outputAmount", json!("989999")),
        ("/inputToken/address", json!(a(9))),
        ("/inputToken/decimals", json!(18)),
        ("/outputToken/chainId", json!(1)),
        ("/refundToken/address", json!(a(4))),
        ("/refundToken/chainId", json!(8453)),
        ("/steps/bridge/tokenIn/address", json!(a(9))),
        ("/steps/bridge/tokenOut/address", json!(a(9))),
        ("/fees/total/amount", json!("9999")),
        ("/fees/total/token/address", json!(a(9))),
        ("/steps/bridge/fees/amount", json!("0")),
        ("/steps/bridge/fees/pct", json!("1000000000000000001")),
        ("/checks/allowance/spender", json!(a(9))),
        ("/checks/balance/expected", json!("999999")),
        ("/checks/allowance/actual", json!("-1")),
        ("/checks/balance/token", json!(a(9))),
        ("/swapTx/gas", json!("0")),
        ("/swapTx/gas", json!("2000001")),
        ("/swapTx/maxPriorityFeePerGas", json!("201")),
        ("/id", json!("../secret?")),
        ("/expectedFillTime", json!(0)),
        ("/expectedFillTime", json!(3601)),
    ] {
        let mut bad = v.clone();
        // Some optional paths are deliberately absent in the baseline fixture.
        let (parent, key) = path.rsplit_once('/').unwrap();
        bad.pointer_mut(parent).unwrap()[key] = value;
        assert!(rejected(&c, &bad), "accepted {path}");
    }
    for word in [0, 1, 2, 3, 4, 5, 6, 11, 12] {
        let mut bad = v.clone();
        change_word(&mut bad, word, 99);
        assert!(rejected(&c, &bad), "accepted calldata word {word}");
    }
    for suffix in [
        "1dc0debeef73c0de",
        "1dc0deabcd73c0df",
        "1dc0deabcd73c0de00",
        "",
    ] {
        let mut bad = v.clone();
        let data = bad["swapTx"]["data"].as_str().unwrap();
        bad["swapTx"]["data"] = json!(format!("{}{suffix}", &data[..842]));
        assert!(rejected(&c, &bad));
    }
    let mut strict = request();
    strict.minimum_output_raw = "990001".into();
    assert!(c.normalize(&a(1), &strict, &v, NOW).is_err());
    assert!(c.normalize(&a(9), &request(), &v, NOW).is_err());
    let mut fee_limit = client();
    fee_limit.configuration.routes[0].maximum_bridge_fee_bps = 99;
    assert!(rejected(&fee_limit, &v));
}

#[test]
fn fee_aliases_app_fees_and_approval_hints_fail_closed() {
    let c = client();
    let v = fixture(NOW);
    for alias in ["totalMax", "maxTotal"] {
        let mut bad = v.clone();
        bad["fees"][alias] = bad["fees"]["total"].clone();
        bad["fees"][alias]["amount"] = json!("10001");
        assert!(rejected(&c, &bad));
    }
    let mut app = v.clone();
    app["fees"]["total"]["details"] =
        json!({"app":{"amount":"0","pct":"0","token":output_token()}});
    c.normalize(&a(1), &request(), &app, NOW).unwrap();
    app["fees"]["total"]["details"]["app"]["amount"] = json!("1");
    assert_eq!(
        c.normalize(&a(1), &request(), &app, NOW).err(),
        Some(QuoteError::Unsupported)
    );
    for approvals in [
        json!([]),
        json!([approve(U256::MAX)]),
        json!([approve(U256::ZERO), approve(U256::from(1000000))]),
    ] {
        let mut hints = v.clone();
        hints["approvalTxns"] = approvals;
        c.normalize(&a(1), &request(), &hints, NOW).unwrap();
    }
    for (field, value) in [
        ("chainId", json!(8453)),
        ("to", json!(a(9))),
        ("value", json!("1")),
        ("data", json!("0x095ea7b3")),
        (
            "data",
            json!(format!("0x095ea7b3{:064x}{:064x}", 9, 1000000)),
        ),
    ] {
        let mut bad = v.clone();
        let mut approval = approve(U256::from(1000000));
        approval[field] = value;
        bad["approvalTxns"] = json!([approval]);
        assert!(rejected(&c, &bad), "accepted approval {field}");
    }
    let mut bad = v.clone();
    bad["approvalTxns"] = json!([approve(U256::from(99))]);
    assert!(rejected(&c, &bad));
    bad["approvalTxns"] = json!([approve(U256::ZERO), approve(U256::ZERO), approve(U256::MAX)]);
    assert!(rejected(&c, &bad));
}

#[test]
fn quote_ttl_never_extends_provider_freshness_or_exclusivity_window() {
    let c = client();
    let v = fixture(NOW);
    let sec = NOW as u64 / 1000;
    for (word, n) in [
        (8, sec + 16),
        (8, sec - 301),
        (9, sec + 30),
        (9, sec + 3601),
        (10, 121),
        (10, sec + 121),
    ] {
        let mut bad = v.clone();
        change_word(&mut bad, word, n);
        assert!(rejected(&c, &bad), "accepted clock word {word}: {n}");
    }
    let mut short = v.clone();
    change_word(&mut short, 8, sec - 290);
    assert_eq!(
        c.normalize(&a(1), &request(), &short, NOW)
            .unwrap()
            .quote()
            .expires_at_ms,
        NOW + 10000
    );
    short = v.clone();
    short["quoteExpiryTimestamp"] = json!(sec + 5);
    let provider_expiry = c.normalize(&a(1), &request(), &short, NOW).unwrap();
    assert_eq!(
        provider_expiry.quote().provider_expires_at_ms,
        Some(NOW + 5000)
    );
    assert_eq!(provider_expiry.quote().expires_at_ms, NOW + 5000);
    short["quoteExpiryTimestamp"] = json!(sec);
    assert!(rejected(&c, &short));
    short = v.clone();
    change_word(&mut short, 9, sec + 70);
    assert_eq!(
        c.normalize(&a(1), &request(), &short, NOW)
            .unwrap()
            .quote()
            .expires_at_ms,
        NOW + 10000
    );
    change_word(&mut short, 10, 71);
    assert!(rejected(&c, &short));
    short = v.clone();
    change_word(&mut short, 10, sec + 100);
    c.normalize(&a(1), &request(), &short, NOW).unwrap();
}

#[test]
fn registry_and_request_validation_precede_provider_access() {
    let c = client();
    for amount in ["0", "0100000", "1e6", "99999", "100000001"] {
        let mut r = request();
        r.amount_raw = amount.into();
        assert!(c.route(&r, &a(1)).is_err());
    }
    let mut r = request();
    r.route_id = "unknown".into();
    assert_eq!(c.route(&r, &a(1)).err(), Some(QuoteError::Unsupported));
    for recipient in [a(0), "https://private.invalid".into()] {
        let mut r = request();
        r.recipient = recipient;
        assert!(c.route(&r, &a(1)).is_err());
    }
    assert!(validate_config(&mut config(), 8453).is_err());
    for mutation in 0..9 {
        let mut conf = config();
        match mutation {
            0 => conf.routes.push(conf.routes[0].clone()),
            1 => conf.routes[0].output_token.decimals = 18,
            2 => conf.routes[0].output_token.asset_id = "different-token".into(),
            3 => conf.routes[0].source_spoke = a(0),
            4 => conf.routes[0].maximum_bridge_fee_bps = 1001,
            5 => conf.routes[0].maximum_exclusivity_seconds = 3601,
            6 => conf.routes[0].minimum_input_raw = "0".into(),
            7 => conf.integrator_id = "0xabcd00".into(),
            _ => conf.routes[0].destination_chain_id = "1".into(),
        }
        assert!(
            validate_config(&mut conf, 1).is_err(),
            "accepted configuration {mutation}"
        );
    }
}

#[tokio::test]
#[ignore = "requires disposable TEST_REDIS_URL and localhost listener"]
async fn transport_binds_auth_query_bounds_and_shares_status_account_cooldown() {
    use crate::providers::bridge_status::{BridgeStatusClient, BridgeStatusLookup, StatusError};
    use axum::{
        Router,
        body::{Body, Bytes},
        extract::{Query, State},
        http::{HeaderMap, Response},
        routing::get,
    };
    use std::{
        collections::HashMap,
        sync::{
            Mutex,
            atomic::{AtomicU16, AtomicUsize, Ordering},
        },
    };
    #[derive(Clone)]
    struct Fixture {
        code: Arc<AtomicU16>,
        body: Arc<Mutex<String>>,
        calls: Arc<AtomicUsize>,
    }
    async fn handler(
        State(f): State<Fixture>,
        Query(q): Query<HashMap<String, String>>,
        h: HeaderMap,
    ) -> Response<Body> {
        f.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(h["authorization"], "Bearer private-fixture-token");
        assert_eq!(h["cache-control"], "no-cache");
        assert!(!h.contains_key("x-api-key"));
        let expected: HashMap<String, String> = [
            ("tradeType", "exactInput".into()),
            ("amount", "1000000".into()),
            ("inputToken", a(3)),
            ("outputToken", a(4)),
            ("originChainId", "1".into()),
            ("destinationChainId", "8453".into()),
            ("depositor", a(1)),
            ("recipient", a(2)),
            ("refundAddress", a(1)),
            ("refundOnOrigin", "true".into()),
            ("integratorId", "0xabcd".into()),
            ("strictTradeType", "true".into()),
            ("skipOriginTxEstimation", "false".into()),
            ("slippage", "0".into()),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v))
        .collect();
        assert_eq!(q, expected);
        // Streaming means no Content-Length hint: exercise the actual byte cap.
        let body = f.body.lock().unwrap().clone();
        let chunks: Vec<std::result::Result<Bytes, std::io::Error>> = body
            .as_bytes()
            .chunks(4096)
            .map(|c| Ok(Bytes::copy_from_slice(c)))
            .collect();
        Response::builder()
            .status(f.code.load(Ordering::SeqCst))
            .header("location", "http://127.0.0.1:1/private-redirect")
            .header("retry-after", "60")
            .body(Body::from_stream(futures_util::stream::iter(chunks)))
            .unwrap()
    }
    let f = Fixture {
        code: Arc::new(AtomicU16::new(200)),
        body: Arc::new(Mutex::new(fixture(now_ms()).to_string())),
        calls: Arc::new(AtomicUsize::new(0)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/api/swap/approval", get(handler))
        .with_state(f.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let redis = redis(&std::env::var("TEST_REDIS_URL").unwrap());
    let metrics = Arc::new(Metrics::default());
    let make = || {
        let mut c = AcrossQuotes::new(config(), 1, redis.clone(), metrics.clone()).unwrap();
        c.origin = Some(format!("{origin}/api/swap/approval"));
        c
    };
    let c = make();
    let second = make();
    let held = c.permits.acquire_many(4).await.unwrap();
    assert_eq!(
        c.quote(&a(1), &request()).await.err(),
        Some(QuoteError::Busy)
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    drop(held);
    let mut invalid = request();
    invalid.amount_raw = "0".into();
    assert_eq!(
        c.quote(&a(1), &invalid).await.err(),
        Some(QuoteError::Invalid)
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        c.quote(&a(1), &request())
            .await
            .unwrap()
            .quote()
            .bridge_fee_raw,
        "10000"
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    f.code.store(302, Ordering::SeqCst);
    assert_eq!(
        c.quote(&a(1), &request()).await.err(),
        Some(QuoteError::Unavailable)
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), 2); // no redirect or retry
    f.code.store(200, Ordering::SeqCst);
    *f.body.lock().unwrap() = "x".repeat(MAX_BODY + 1);
    assert_eq!(
        c.quote(&a(1), &request()).await.err(),
        Some(QuoteError::InvalidResponse)
    );
    *f.body.lock().unwrap() = "private-malformed-provider-body".into();
    assert_eq!(
        c.quote(&a(1), &request()).await.err(),
        Some(QuoteError::InvalidResponse)
    );
    f.code.store(429, Ordering::SeqCst);
    assert_eq!(
        c.quote(&a(1), &request()).await.err(),
        Some(QuoteError::Unavailable)
    );
    let calls = f.calls.load(Ordering::SeqCst);
    assert_eq!(
        second.quote(&a(1), &request()).await.err(),
        Some(QuoteError::Busy)
    );
    let status = BridgeStatusClient::across(
        Zeroizing::new("private-fixture-token".into()),
        "0xabcd".into(),
        RpcBudgetConfig {
            scope: "fixture".into(),
            interval_ms: 1,
            simulation_cost: 1,
        },
        redis.clone(),
        metrics.clone(),
    )
    .unwrap()
    .with_test_origin(origin.clone());
    let lookup =
        BridgeStatusLookup::across("7", 1, 8453, 1, &format!("0x{}", "11".repeat(32))).unwrap();
    assert_eq!(
        status.read(&lookup).await.err(),
        Some(StatusError::CoolingDown)
    );
    assert_eq!(f.calls.load(Ordering::SeqCst), calls);
    // Different policy for the same account cannot silently create a new bucket.
    let mut wrong = config();
    wrong.interval_ms = 2;
    let mut mismatch = AcrossQuotes::new(wrong, 1, redis.clone(), metrics.clone()).unwrap();
    mismatch.origin = Some(format!("{origin}/api/swap/approval"));
    assert_eq!(
        mismatch.quote(&a(1), &request()).await.err(),
        Some(QuoteError::Busy)
    );
    let encoded = metrics.encode().unwrap();
    assert!(encoded.contains("operation=\"quote\""));
    for private in ["private-", "fixture-quote", "usdc-base", "abcd", &a(1)] {
        assert!(!encoded.contains(private));
    }
    task.abort();
    let _: i32 = redis
        .query(
            redis::cmd("DEL")
                .arg(redis.key("rpc-budget-across-fixture", "policy"))
                .arg(redis.key("rpc-budget-across-fixture", "next"))
                .arg(redis.key("rpc-budget-across-fixture", "cooldown")),
        )
        .await
        .unwrap();
}
