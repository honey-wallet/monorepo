use super::*;
use serde_json::json;
fn h(n: u8) -> String {
    format!("0x{}", format!("{n:02x}").repeat(32))
}
fn lookup(provider: BridgeProvider) -> BridgeStatusLookup {
    match provider {
        BridgeProvider::Relay => BridgeStatusLookup::relay("request-fixture", 1, 8453, &h(1)),
        BridgeProvider::Across => BridgeStatusLookup::across("7", 1, 8453, 1, &h(1)),
    }
    .unwrap()
}
fn fixture(provider: BridgeProvider, status: &str) -> Value {
    match provider {
        BridgeProvider::Relay => {
            json!({"status":status,"originChainId":1,"destinationChainId":8453,"inTxHashes":[h(1)],"txHashes":[h(2)],"updatedAt":100000})
        }
        BridgeProvider::Across => {
            json!({"status":status,"originChainId":1,"destinationChainId":8453,"depositId":"7","depositTxHash":h(1),"depositTxnRef":h(1),"fillTx":h(2),"fillTxnRef":h(2),"depositRefundTxHash":null,"depositRefundTxnRef":null,"pagination":{"currentIndex":0,"maxIndex":0}})
        }
    }
}
#[test]
fn reported_fill_and_refund_never_grant_settlement_authority() {
    for provider in [BridgeProvider::Relay, BridgeProvider::Across] {
        let l = lookup(provider);
        let mut v = fixture(
            provider,
            if provider == BridgeProvider::Relay {
                "success"
            } else {
                "filled"
            },
        );
        let r = normalize(&l, &v, 100001).unwrap();
        assert_eq!(r.reported_outcome, ReportedOutcome::FillReported);
        assert!(r.verification_required && r.source_transaction_seen);
        assert_eq!(r.candidates[0].chain_id, "8453");
        assert_eq!(r.candidates[0].role, CandidateRole::DestinationFill);
        if provider == BridgeProvider::Relay {
            v["status"] = json!("refund");
        } else {
            v["status"] = json!("refunded");
            v["fillTx"] = Value::Null;
            v["fillTxnRef"] = Value::Null;
            v["depositRefundTxnRef"] = json!(h(3));
        }
        let r = normalize(&l, &v, 100001).unwrap();
        assert!(r.verification_required);
        assert_eq!(r.reported_outcome, ReportedOutcome::RefundReported);
        assert_eq!(r.candidates[0].chain_id, "1");
        assert_eq!(r.poll_after_ms, 60000);
    }
}
#[test]
fn stale_missing_and_failed_reports_do_not_erase_or_finalize_chain_evidence() {
    let l = lookup(BridgeProvider::Relay);
    for status in ["waiting", "depositing", "pending", "submitted", "failure"] {
        let mut v = fixture(BridgeProvider::Relay, status);
        v["inTxHashes"] = json!([]);
        let r = normalize(&l, &v, 999999999).unwrap();
        assert!(!r.source_transaction_seen && r.verification_required && r.candidates.is_empty());
        assert_eq!(
            r.reported_outcome,
            if status == "failure" {
                ReportedOutcome::RecoveryRequired
            } else {
                ReportedOutcome::Pending
            }
        );
    }
    let waiting = normalize(&l, &json!({"status":"waiting"}), 100001).unwrap();
    assert_eq!(waiting.reported_outcome, ReportedOutcome::Pending);
    let mut across = fixture(BridgeProvider::Across, "expired");
    across["fillTx"] = Value::Null;
    across["fillTxnRef"] = Value::Null;
    let r = normalize(&lookup(BridgeProvider::Across), &across, 100001).unwrap();
    assert_eq!(r.reported_outcome, ReportedOutcome::RefundPending);
    assert!(r.candidates.is_empty());
}
#[test]
fn identity_aliases_ambiguity_and_unknown_statuses_fail_closed() {
    for provider in [BridgeProvider::Relay, BridgeProvider::Across] {
        let l = lookup(provider);
        let v = fixture(
            provider,
            if provider == BridgeProvider::Relay {
                "success"
            } else {
                "filled"
            },
        );
        for (field, value) in [
            ("originChainId", json!(8453)),
            ("destinationChainId", json!(10)),
            ("status", json!("new-provider-state")),
        ] {
            let mut bad = v.clone();
            bad[field] = value;
            assert!(normalize(&l, &bad, 100001).is_err());
        }
        let mut bad = v.clone();
        if provider == BridgeProvider::Relay {
            bad["inTxHashes"] = json!([h(9)]);
        } else {
            bad["depositTxnRef"] = json!(h(9));
        }
        assert!(normalize(&l, &bad, 100001).is_err());
        let mut bad = v.clone();
        if provider == BridgeProvider::Relay {
            bad["inTxHashes"] = json!([h(1), h(2)]);
        } else {
            bad["pagination"]["maxIndex"] = json!(1);
        }
        assert_eq!(
            normalize(&l, &bad, 100001).unwrap_err(),
            StatusError::Ambiguous
        );
    }
    let l = lookup(BridgeProvider::Across);
    let v = fixture(BridgeProvider::Across, "filled");
    for (field, value) in [
        ("depositId", json!("8")),
        ("fillTxnRef", json!(h(9))),
        ("fillTx", json!("https://attacker.invalid")),
    ] {
        let mut bad = v.clone();
        bad[field] = value;
        assert!(normalize(&l, &bad, 100001).is_err());
    }
    let mut bad = v.clone();
    bad["actionsSucceeded"] = json!(true);
    assert_eq!(
        normalize(&l, &bad, 100001).unwrap_err(),
        StatusError::UnsupportedRoute
    );
    let mut bad = v;
    bad["depositRefundTxnRef"] = json!(h(3));
    assert_eq!(
        normalize(&l, &bad, 100001).unwrap_err(),
        StatusError::Ambiguous
    );
}
#[test]
fn candidate_lists_are_bounded_unique_and_require_source_linkage() {
    let l = lookup(BridgeProvider::Relay);
    let v = fixture(BridgeProvider::Relay, "success");
    for value in [
        json!([]),
        json!([h(1), h(1)]),
        json!((1..=9).map(h).collect::<Vec<_>>()),
        json!(["0x00"]),
    ] {
        let mut bad = v.clone();
        bad["txHashes"] = value;
        assert!(normalize(&l, &bad, 100001).is_err());
    }
    let mut bad = v.clone();
    bad["inTxHashes"] = json!([]);
    assert!(normalize(&l, &bad, 100001).is_err());
    let mut bad = v;
    bad["updatedAt"] = json!(140001);
    assert!(normalize(&l, &bad, 100001).is_err());
    assert!(BridgeStatusLookup::relay("../?secret", 1, 8453, &h(1)).is_err());
    assert!(BridgeStatusLookup::across("07", 1, 8453, 1, &h(1)).is_err());
    assert!(BridgeStatusLookup::across("7", 1, 8453, 10, &h(1)).is_err());
    assert!(BridgeStatusLookup::relay("ok", 1, 1, &h(1)).is_err());
}

#[tokio::test]
#[ignore = "requires disposable TEST_REDIS_URL and localhost listeners"]
async fn fixed_status_transport_auth_binding_bounds_and_shared_cooldown() {
    use axum::{
        Router,
        body::Body,
        extract::{RawQuery, State},
        http::{HeaderMap, Response},
        routing::get,
    };
    use std::sync::{
        Mutex,
        atomic::{AtomicU16, AtomicUsize, Ordering},
    };
    #[derive(Clone)]
    struct Fixture {
        provider: BridgeProvider,
        status: Arc<AtomicU16>,
        body: Arc<Mutex<String>>,
        calls: Arc<AtomicUsize>,
    }
    async fn handler(
        State(f): State<Fixture>,
        RawQuery(query): RawQuery,
        headers: HeaderMap,
    ) -> Response<Body> {
        f.calls.fetch_add(1, Ordering::SeqCst);
        if f.provider == BridgeProvider::Relay {
            assert_eq!(headers["x-api-key"], "private-fixture-token");
            assert!(!headers.contains_key("authorization"));
            assert_eq!(query.as_deref(), Some("requestId=request-fixture"));
        } else {
            assert_eq!(headers["authorization"], "Bearer private-fixture-token");
            assert!(!headers.contains_key("x-api-key"));
            assert_eq!(
                query.as_deref(),
                Some("originChainId=1&depositId=7&integratorId=0xabcd")
            );
        }
        Response::builder()
            .status(f.status.load(Ordering::SeqCst))
            .header("location", "http://127.0.0.1:1/private-redirect")
            .header("retry-after", "1")
            .body(Body::from(f.body.lock().unwrap().clone()))
            .unwrap()
    }
    for provider in [BridgeProvider::Relay, BridgeProvider::Across] {
        let fixture = Fixture {
            provider,
            status: Arc::new(AtomicU16::new(200)),
            body: Arc::new(Mutex::new(
                fixture(
                    provider,
                    if provider == BridgeProvider::Relay {
                        "success"
                    } else {
                        "filled"
                    },
                )
                .to_string(),
            )),
            calls: Arc::new(AtomicUsize::new(0)),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let path = lookup(provider).path();
        let app = Router::new()
            .route(path, get(handler))
            .with_state(fixture.clone());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let redis = RedisStore::new(
            redis::Client::open(std::env::var("TEST_REDIS_URL").unwrap()).unwrap(),
            format!("bridge-status-{}", uuid::Uuid::new_v4().simple()),
            Duration::from_secs(2),
        );
        let metrics = Arc::new(Metrics::default());
        let make = || {
            let config = RpcBudgetConfig {
                scope: "fixture".into(),
                interval_ms: 1,
                simulation_cost: 1,
            };
            let key = Zeroizing::new("private-fixture-token".to_owned());
            let mut c = match provider {
                BridgeProvider::Relay => {
                    BridgeStatusClient::relay(key, config, redis.clone(), metrics.clone())
                }
                BridgeProvider::Across => BridgeStatusClient::across(
                    key,
                    "0xabcd".into(),
                    config,
                    redis.clone(),
                    metrics.clone(),
                ),
            }
            .unwrap();
            c.origin = Some(origin.clone());
            c
        };
        let client = make();
        let second = make();
        let l = lookup(provider);
        assert_eq!(
            client.read(&l).await.unwrap().reported_outcome,
            ReportedOutcome::FillReported
        );
        let bad = lookup(if provider == BridgeProvider::Relay {
            BridgeProvider::Across
        } else {
            BridgeProvider::Relay
        });
        assert_eq!(client.read(&bad).await.unwrap_err(), StatusError::Invalid);
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
        fixture.status.store(302, Ordering::SeqCst);
        assert_eq!(client.read(&l).await.unwrap_err(), StatusError::Rejected);
        fixture.status.store(404, Ordering::SeqCst);
        let absent = client.read(&l).await.unwrap();
        assert_eq!(absent.reported_outcome, ReportedOutcome::NotIndexed);
        assert!(absent.verification_required);
        fixture.status.store(200, Ordering::SeqCst);
        *fixture.body.lock().unwrap() = "x".repeat(MAX_BODY + 1);
        assert_eq!(
            client.read(&l).await.unwrap_err(),
            StatusError::InvalidResponse
        );
        *fixture.body.lock().unwrap() = "private-unparseable-provider-body".into();
        assert_eq!(
            client.read(&l).await.unwrap_err(),
            StatusError::InvalidResponse
        );
        fixture.status.store(429, Ordering::SeqCst);
        assert_eq!(client.read(&l).await.unwrap_err(), StatusError::CoolingDown);
        let count = fixture.calls.load(Ordering::SeqCst);
        assert_eq!(second.read(&l).await.unwrap_err(), StatusError::CoolingDown);
        assert_eq!(fixture.calls.load(Ordering::SeqCst), count);
        let encoded = metrics.encode().unwrap();
        for text in ["private-", "request-fixture", &h(1), "abcd"] {
            assert!(!encoded.contains(text));
        }
        assert!(encoded.contains("operation=\"bridge_status\""));
        task.abort();
        let domain = format!("rpc-budget-{}-fixture", provider.name());
        let _: i32 = redis
            .query(
                redis::cmd("DEL")
                    .arg(redis.key(&domain, "policy"))
                    .arg(redis.key(&domain, "next"))
                    .arg(redis.key(&domain, "cooldown")),
            )
            .await
            .unwrap();
    }
}
