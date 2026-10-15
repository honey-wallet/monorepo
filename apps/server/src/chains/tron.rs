//! Tron: native account permissions, or the EVM wallet contract on TVM (spec §7).

use super::prelude::*;

pub struct Tron;

impl ChainAdapter for Tron {
    async fn verify_session_signature(
        &self,
        _req: &VerifySessionSignature,
    ) -> Result<SessionVerdict, AppError> {
        // TODO(spec §7, §9): `getaccount`, confirm the recovered signer is in
        // an active permission whose `operations` bitmap is all zeros. For
        // the TVM contract route, call `isValidSignature` like EVM.
        Err(AppError::NotImplemented("tron.verify_session_signature"))
    }

    async fn read_account(&self, _address: &str) -> Result<OnChainAccount, AppError> {
        // TODO(spec §7): owner permission address (the commitment) and the
        // zero-ops session permission; contract state for the TVM route.
        Err(AppError::NotImplemented("tron.read_account"))
    }

    async fn post_commit(&self, _req: &CommitRequest) -> Result<CommitReceipt, AppError> {
        // TODO(spec §10): TVM contract route only; native permissions have no
        // programmable check, so return `unsupported` for native accounts.
        Err(AppError::NotImplemented("tron.post_commit"))
    }

    async fn submit(&self, _req: &SubmitRequest) -> Result<SubmissionReceipt, AppError> {
        // TODO: `broadcasttransaction` via the configured node. Native
        // rotation = `TransferContract` then `AccountPermissionUpdateContract`,
        // back to back, in that order; log the gap as a RotationWindow
        // exposure event (spec §7). Later (spec §10): our own node near the
        // super representatives.
        Err(AppError::NotImplemented("tron.submit"))
    }
}
