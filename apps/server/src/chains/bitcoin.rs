//! Bitcoin: no account; spending a P2WPKH output is the rotation (spec §6).

use super::prelude::*;

pub struct Bitcoin;

impl ChainAdapter for Bitcoin {
    async fn verify_session_signature(
        &self,
        _req: &VerifySessionSignature,
    ) -> Result<SessionVerdict, AppError> {
        // TODO(spec §6, §9): BIP-322 verification against the wallet's
        // unfunded identity address. Convention only: there is no account
        // state linking that address to the funds.
        Err(AppError::NotImplemented("bitcoin.verify_session_signature"))
    }

    async fn read_account(&self, _address: &str) -> Result<OnChainAccount, AppError> {
        // TODO(spec §6): no owner or vault state exists. Use this for hygiene
        // checks instead: flag reused addresses and Taproot key-path outputs.
        Err(AppError::NotImplemented("bitcoin.read_account"))
    }

    async fn post_commit(&self, _req: &CommitRequest) -> Result<CommitReceipt, AppError> {
        // Commit-delay-reveal needs a soft fork (spec §10).
        Err(unsupported(Chain::Bitcoin, "commit-delay-reveal"))
    }

    async fn submit(&self, _req: &SubmitRequest) -> Result<SubmissionReceipt, AppError> {
        // TODO: broadcast via the configured node or Esplora API.
        // Later (spec §10): direct miner submission service.
        Err(AppError::NotImplemented("bitcoin.submit"))
    }
}
