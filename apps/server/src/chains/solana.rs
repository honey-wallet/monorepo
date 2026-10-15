//! Solana: custom program, wallet is a PDA storing `sha256(owner_pubkey)` (spec §5).

use super::prelude::*;

pub struct Solana;

impl ChainAdapter for Solana {
    async fn verify_session_signature(
        &self,
        _req: &VerifySessionSignature,
    ) -> Result<SessionVerdict, AppError> {
        // TODO(spec §5, §9): read `session_pubkey` + `session_expiry` from the
        // wallet PDA via RPC and verify ed25519 against it, or
        // `simulateTransaction` a `verify_session_signature` instruction and
        // read the result from logs.
        Err(AppError::NotImplemented("solana.verify_session_signature"))
    }

    async fn read_account(&self, _address: &str) -> Result<OnChainAccount, AppError> {
        // TODO(spec §5, §11): deserialize the PDA: `owner_commitment`,
        // `session_pubkey`, `session_expiry`, `merkle_root`, `next_leaf_index`.
        Err(AppError::NotImplemented("solana.read_account"))
    }

    async fn post_commit(&self, _req: &CommitRequest) -> Result<CommitReceipt, AppError> {
        // TODO(spec §5): `commit(hash)` instruction signed only by the dust fee
        // payer; `execute` requires the commit to be at least `d` slots old.
        Err(AppError::NotImplemented("solana.post_commit"))
    }

    async fn submit(&self, _req: &SubmitRequest) -> Result<SubmissionReceipt, AppError> {
        // TODO: `sendTransaction` via the configured RPC.
        // Later (spec §5, §10): direct-to-leader or Jito bundle.
        Err(AppError::NotImplemented("solana.submit"))
    }
}
