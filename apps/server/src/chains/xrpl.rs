//! XRP Ledger: regular key rotation inside an ALLORNOTHING Batch (spec §8).

use super::prelude::*;

pub struct Xrpl;

impl ChainAdapter for Xrpl {
    async fn verify_session_signature(
        &self,
        _req: &VerifySessionSignature,
    ) -> Result<SessionVerdict, AppError> {
        // TODO(spec §8, §9): read the account object and verify against its
        // `MessageKey`. Never accept `SignIn` pseudo-transactions: those are
        // signed by the regular (owner) key.
        Err(AppError::NotImplemented("xrpl.verify_session_signature"))
    }

    async fn read_account(&self, _address: &str) -> Result<OnChainAccount, AppError> {
        // TODO(spec §8): `RegularKey` (the owner commitment), `MessageKey`,
        // and the `lsfDisableMaster` flag.
        Err(AppError::NotImplemented("xrpl.read_account"))
    }

    async fn post_commit(&self, _req: &CommitRequest) -> Result<CommitReceipt, AppError> {
        // No programmable layer; sequence-number ordering only (spec §10).
        Err(unsupported(Chain::Xrpl, "commit-delay-reveal"))
    }

    async fn submit(&self, _req: &SubmitRequest) -> Result<SubmissionReceipt, AppError> {
        // TODO: `submit` the Batch via the configured server. Without Batch:
        // two consecutive sequence numbers, and log the one-ledger gap as a
        // RotationWindow exposure event (spec §8). Later (spec §10): our own
        // validator-adjacent node.
        Err(AppError::NotImplemented("xrpl.submit"))
    }
}
