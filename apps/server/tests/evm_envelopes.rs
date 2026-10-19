use honey_server::{
    evm_envelope::{EnvelopeError as E, EvmEnvelopePolicy, verify_signed_bundle},
    preparation::{CallPurpose, EvmPreparation, calls_hash},
};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    now_ms: i64,
    plan: EvmPreparation,
    preparation_hash: String,
    signed: Vec<String>,
    transaction_hashes: Vec<String>,
    maximum_execution_fee: String,
    variants: BTreeMap<String, String>,
}
fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/evm-envelopes-viem.json")).unwrap()
}
fn policy() -> EvmEnvelopePolicy {
    EvmEnvelopePolicy {
        first_nonce: 7,
        maximum_gas_per_transaction: 500000,
    }
}

#[test]
fn actual_keyring_bytes_recover_signer_and_match_hashes_calls_and_aggregate_fee() {
    let f = fixture();
    let bundle = verify_signed_bundle(&f.plan, policy(), &f.signed, f.now_ms).unwrap();
    assert_eq!(bundle.preparation_hash(), f.preparation_hash);
    assert_eq!(bundle.chain_id(), 31337);
    assert_eq!(format!("{:#x}", bundle.signer()), f.plan.signer);
    assert_eq!(
        bundle.maximum_execution_fee().to_string(),
        f.maximum_execution_fee
    );
    assert_eq!(bundle.transactions().len(), 2);
    for (i, tx) in bundle.transactions().iter().enumerate() {
        assert_eq!(format!("{:#x}", tx.hash()), f.transaction_hashes[i]);
        assert_eq!(
            format!("0x{}", hex::encode(tx.expose_signed_bytes())),
            f.signed[i]
        );
        assert_eq!(tx.nonce(), 7 + i as u64);
        assert_eq!(tx.gas_limit(), if i == 0 { 100000 } else { 120000 });
    }
    assert_eq!(
        bundle.transactions()[0].maximum_execution_fee().to_string(),
        "200000000000000"
    );
}
#[test]
fn independent_wallet_mismatch_vectors_are_rejected() {
    let f = fixture();
    for (name, expected) in [
        ("wrong_chain", E::Chain),
        ("wrong_nonce", E::Nonce),
        ("wrong_signer", E::Signer),
        ("wrong_to", E::Call),
        ("wrong_data", E::Call),
        ("wrong_value", E::Call),
        ("contract_creation", E::Call),
        ("access_list", E::AccessList),
        ("low_gas", E::Gas),
        ("high_gas", E::Gas),
        ("bundle_fee_exceeded", E::Fees),
        ("priority_above_max", E::Fees),
        ("high_s", E::Signature),
        ("zero_r", E::Signature),
        ("invalid_parity", E::Encoding),
        ("noncanonical_nonce", E::Encoding),
        ("trailing_byte", E::Encoding),
        ("unsigned", E::Encoding),
        ("p2p_wrapper", E::UnsupportedType),
    ] {
        let mut signed = f.signed.clone();
        signed[0] = f.variants[name].clone();
        assert_eq!(
            verify_signed_bundle(&f.plan, policy(), &signed, f.now_ms).err(),
            Some(expected),
            "{name}"
        );
    }
}
#[test]
fn exact_uint_values_expiry_policy_and_full_ordered_coverage_are_enforced() {
    let f = fixture();
    assert_eq!(
        verify_signed_bundle(&f.plan, policy(), &f.signed, f.plan.expires_at_ms).err(),
        Some(E::Expired)
    );
    assert_eq!(
        verify_signed_bundle(
            &f.plan,
            policy(),
            &f.signed,
            f.plan.simulation.observed_at_ms - 1
        )
        .err(),
        Some(E::Expired)
    );
    assert_eq!(
        verify_signed_bundle(&f.plan, policy(), &f.signed[..1], f.now_ms).err(),
        Some(E::StepCount)
    );
    let reversed = vec![f.signed[1].clone(), f.signed[0].clone()];
    assert_eq!(
        verify_signed_bundle(&f.plan, policy(), &reversed, f.now_ms).err(),
        Some(E::Nonce)
    );
    let duplicate = vec![f.signed[0].clone(), f.signed[0].clone()];
    assert_eq!(
        verify_signed_bundle(&f.plan, policy(), &duplicate, f.now_ms).err(),
        Some(E::Nonce)
    );
    assert_eq!(
        verify_signed_bundle(
            &f.plan,
            EvmEnvelopePolicy {
                first_nonce: u64::MAX,
                ..policy()
            },
            &f.signed,
            f.now_ms
        )
        .err(),
        Some(E::InvalidPolicy)
    );
    assert_eq!(
        verify_signed_bundle(
            &f.plan,
            EvmEnvelopePolicy {
                maximum_gas_per_transaction: 0,
                ..policy()
            },
            &f.signed,
            f.now_ms
        )
        .err(),
        Some(E::InvalidPolicy)
    );
    let mut changed = f.plan.clone();
    changed.steps[0].to = changed.signer.clone();
    assert_eq!(
        verify_signed_bundle(&changed, policy(), &f.signed, f.now_ms).err(),
        Some(E::InvalidPlan)
    );
    let mut wide = f.plan.clone();
    wide.steps.truncate(1);
    wide.steps[0].purpose = CallPurpose::Action;
    wide.steps[0].value_raw = "9007199254740993".into();
    wide.simulation.calls_hash = calls_hash(&wide.steps).unwrap();
    verify_signed_bundle(
        &wide,
        policy(),
        &[f.variants["wide_value"].clone()],
        f.now_ms,
    )
    .unwrap();
    wide.steps[0].value_raw = "9007199254740992".into();
    wide.simulation.calls_hash = calls_hash(&wide.steps).unwrap();
    assert_eq!(
        verify_signed_bundle(
            &wide,
            policy(),
            &[f.variants["wide_value"].clone()],
            f.now_ms
        )
        .err(),
        Some(E::Call)
    );
    let mut budget = f.plan.clone();
    budget.maximum_network_fee_raw = f.maximum_execution_fee.clone();
    verify_signed_bundle(&budget, policy(), &f.signed, f.now_ms).unwrap();
    budget.maximum_network_fee_raw = "439999999999999".into();
    assert_eq!(
        verify_signed_bundle(&budget, policy(), &f.signed, f.now_ms).err(),
        Some(E::Fees)
    );
}
#[test]
fn malformed_or_unsupported_envelopes_are_bounded_and_never_partially_accepted() {
    let f = fixture();
    for bad in [
        "",
        "0x",
        "0x0",
        "0xgg",
        "0x02c0",
        "0x01c0",
        "0x03c0",
        "0x04c0",
        "0x00c0",
        "0xc0",
        "0x02ffffffffffffffffffffffffffffffff",
    ] {
        let signed = vec![bad.to_owned(), f.signed[1].clone()];
        assert!(
            verify_signed_bundle(&f.plan, policy(), &signed, f.now_ms).is_err(),
            "{bad}"
        );
    }
    let signed = vec![format!("0x02{}", "00".repeat(8192)), f.signed[1].clone()];
    assert_eq!(
        verify_signed_bundle(&f.plan, policy(), &signed, f.now_ms).err(),
        Some(E::Encoding)
    );
    // Every proper byte prefix must fail exact-envelope decoding.
    for length in (4..f.signed[0].len()).step_by(2) {
        let signed = vec![f.signed[0][..length].to_owned(), f.signed[1].clone()];
        assert!(verify_signed_bundle(&f.plan, policy(), &signed, f.now_ms).is_err());
    }
}
