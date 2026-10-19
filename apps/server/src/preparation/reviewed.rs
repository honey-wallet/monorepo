//! Bind a stored swap preparation to the immutable review and admitted signature.
use crate::{
    error::AppError,
    providers::{
        evm_prepare::{PreparedEvm, encode_call},
        uniswap_economics::{RouterCall, validate_economics},
        uniswap_router::{self, Command},
    },
    swap_review::{SwapBuildContext, SwapReview},
};
use alloy_primitives::{Address, U256};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::{CallPurpose, FeeKind, PreparationProvider, label};

/// Full authenticated evidence for a future wallet-facing service. Deliberately
/// neither Debug nor Serialize: it contains transferable Permit2 calldata.
pub struct SwapSigningEvidence {
    pub prepared: PreparedEvm,
    pub review: SwapReview,
    pub build_request_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReviewedRecord {
    pub schema_version: u8,
    pub review_hash: String,
    pub build_request_id: String,
    pub prepared: PreparedEvm,
}
// Untagged legacy decoding preserves the existing encrypted storage format. A
// legacy record is rejected whenever the operation has a persisted swap review.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum StoredPreparation {
    Reviewed(ReviewedRecord),
    Legacy(PreparedEvm),
}
impl StoredPreparation {
    pub fn prepared(&self) -> &PreparedEvm {
        match self {
            Self::Reviewed(v) => &v.prepared,
            Self::Legacy(v) => v,
        }
    }
    pub fn into_prepared(self) -> PreparedEvm {
        match self {
            Self::Reviewed(v) => v.prepared,
            Self::Legacy(v) => v,
        }
    }
    pub fn bind(&self, context: Option<&SwapBuildContext>) -> Result<(), AppError> {
        match (self, context) {
            (Self::Legacy(_), None) => Ok(()),
            (Self::Reviewed(record), Some(context)) => {
                if record.schema_version != 2
                    || record.review_hash != context.review.integrity_hash()?
                    || !label(&record.build_request_id)
                {
                    return Err(AppError::Busy);
                }
                validate(&record.prepared, context)
            }
            _ => Err(AppError::Busy),
        }
    }
}
fn uint(value: &str) -> Result<U256, AppError> {
    U256::from_str_radix(value, 10).map_err(|_| AppError::Busy)
}
/// Re-check the semantic relationship on both write and recovery. Use review time
/// for historical cryptographic validation; callers separately enforce live expiry.
fn validate(p: &PreparedEvm, context: &SwapBuildContext) -> Result<(), AppError> {
    p.validate_signing_terms().map_err(|_| AppError::Busy)?;
    let r = &context.review;
    let plan = &p.plan;
    let receive = plan.minimum_receive.as_ref().ok_or(AppError::Busy)?;
    if plan.provider != PreparationProvider::Uniswap
        || plan.intent_hash != r.intent_hash
        || plan.chain_id != r.authority.chain_id
        || plan.signer != r.authority.owner
        || plan.registry_revision != r.registry_revision
        || plan.fee_policy_revision != r.fee_policy_revision
        || plan.quote_reference.as_ref() != Some(&r.quote_id)
        || plan.expires_at_ms != r.expires_at_ms
        || plan.simulation.observed_at_ms < r.reviewed_at_ms
        || uint(&plan.maximum_network_fee_raw)? > uint(&r.maximum_network_fee_raw)?
        || plan.maximum_spend.asset_address.as_ref() != Some(&r.authority.token_in)
        || plan.maximum_spend.amount_raw != r.authority.maximum_input_raw
        || plan.maximum_spend.recipient != r.authority.owner
        || receive.asset_address.as_ref() != Some(&r.authority.token_out)
        || receive.amount_raw != r.authority.minimum_output_raw
        || receive.recipient != r.authority.owner
        || plan.fees.len() != r.authority.fees.len()
        || !(1..=3).contains(&plan.steps.len())
    {
        return Err(AppError::Busy);
    }
    for (paid, authority) in plan.fees.iter().zip(&r.authority.fees) {
        if !matches!(paid.kind, FeeKind::App)
            || paid.amount.asset_address.as_ref() != Some(&r.authority.token_out)
            || paid.amount.recipient != authority.recipient
        {
            return Err(AppError::Busy);
        }
    }
    let spender: Address = r.permit2.parse().map_err(|_| AppError::Busy)?;
    let mut word = [0; 32];
    word[12..].copy_from_slice(spender.as_slice());
    let exact = encode_call(
        "approve(address,uint256)",
        &[word, uint(&r.authority.maximum_input_raw)?.to_be_bytes()],
    );
    let reset = encode_call("approve(address,uint256)", &[word, [0; 32]]);
    let approvals = &plan.steps[..plan.steps.len() - 1];
    for (i, call) in approvals.iter().enumerate() {
        if call.purpose != CallPurpose::Approval
            || call.to != r.authority.token_in
            || call.value_raw != "0"
            || call.data
                != if approvals.len() == 2 && i == 0 {
                    &reset
                } else {
                    &exact
                }
                .as_str()
        {
            return Err(AppError::Busy);
        }
    }
    let action = plan.steps.last().ok_or(AppError::Busy)?;
    if action.purpose != CallPurpose::Action {
        return Err(AppError::Busy);
    }
    let now = u64::try_from(r.reviewed_at_ms / 1000).map_err(|_| AppError::Busy)?;
    let call = RouterCall {
        chain_id: plan.chain_id.clone(),
        from: plan.signer.clone(),
        to: action.to.clone(),
        value_raw: action.value_raw.clone(),
        data: Zeroizing::new(action.data.clone()),
    };
    validate_economics(&r.authority, &call, now).map_err(|_| AppError::Busy)?;
    let decoded = uniswap_router::decode(&call.data).map_err(|_| AppError::Busy)?;
    decoded
        .verify_embedded_permit(r.permit.as_ref(), now)
        .map_err(|_| AppError::Busy)?;
    match (&context.signature, decoded.commands.first()) {
        (Some(expected), Some(Command::PermitSingle { signature, .. }))
            if expected.as_str() == signature.as_str() => {}
        (None, _) if r.permit.is_none() => {}
        _ => return Err(AppError::Busy),
    }
    Ok(())
}
