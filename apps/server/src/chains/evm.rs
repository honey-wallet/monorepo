//! EVM: ERC-4337 smart account with ERC-7579 modules (spec §4).

use super::prelude::*;

pub struct Evm;

impl ChainAdapter for Evm {
    async fn verify_session_signature(
        &self,
        _req: &VerifySessionSignature,
    ) -> Result<SessionVerdict, AppError> {
        // TODO(spec §9): ERC-7739-wrap the hash, then `eth_call`
        // `isValidSignature(hash, sig)` on the account (ERC-1271); unwrap
        // ERC-6492 for undeployed accounts. Valid iff it returns 0x1626ba7e.
        Err(AppError::NotImplemented("evm.verify_session_signature"))
    }

    async fn read_account(&self, _address: &str) -> Result<OnChainAccount, AppError> {
        // TODO(spec §4): read owner from the ownership validator, session key
        // + expiry from SessionSigValidator, and Tier B root/index from the
        // hash-based validator module if installed.
        Err(AppError::NotImplemented("evm.read_account"))
    }

    async fn post_commit(&self, _req: &CommitRequest) -> Result<CommitReceipt, AppError> {
        // TODO(spec §4): relayer posts `keccak256(pubkey ‖ userOpHash ‖ salt)`
        // to the account; the UserOp is accepted only after `d` blocks.
        Err(AppError::NotImplemented("evm.post_commit"))
    }

    async fn submit(&self, _req: &SubmitRequest) -> Result<SubmissionReceipt, AppError> {
        // TODO: `eth_sendUserOperation` to the bundler from config.
        // Later (spec §4, §10): private bundler endpoint or Flashbots Protect.
        Err(AppError::NotImplemented("evm.submit"))
    }
}
