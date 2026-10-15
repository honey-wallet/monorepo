//! Per-chain behaviour behind one interface.
//!
//! Every chain answers the same four questions differently (spec §4–§8):
//! where the session key is anchored, how the account's public state is read,
//! whether commit-delay-reveal exists, and how signed payloads are submitted.

pub mod bitcoin;
pub mod evm;
pub mod solana;
pub mod tron;
pub mod xrpl;

/// What every adapter module needs: the trait, its argument and return types,
/// and the `unsupported` error for capabilities a chain lacks.
mod prelude {
    pub(super) use super::{Chain, ChainAdapter, OnChainAccount, unsupported};
    pub(super) use crate::{
        error::AppError,
        relayer::{CommitReceipt, CommitRequest, SubmissionReceipt, SubmitRequest},
        session_signatures::{SessionVerdict, VerifySessionSignature},
    };
}

use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    relayer::{CommitReceipt, CommitRequest, SubmissionReceipt, SubmissionRoute, SubmitRequest},
    session_signatures::{SessionVerdict, VerifySessionSignature},
    wallet::{SessionAnchor, VaultState},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Chain {
    Evm,
    Solana,
    Bitcoin,
    Tron,
    Xrpl,
}

impl Chain {
    pub const ALL: [Chain; 5] = [
        Chain::Evm,
        Chain::Solana,
        Chain::Bitcoin,
        Chain::Tron,
        Chain::Xrpl,
    ];
}

/// How far a chain supports a feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Yes,
    No,
    /// Only through a deployed contract (Tron TVM).
    ContractRouteOnly,
    /// Built into how the chain works (Bitcoin: spending is rotation).
    Inherent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionAnchorKind {
    Erc7579Validator,
    PdaField,
    ZeroOpsPermission,
    MessageKey,
    IdentityAddress,
}

/// One column of the spec's cross-chain comparison (§14), plus §10's
/// private-submission routes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainCapabilities {
    pub chain: Chain,
    pub identifier_is_pubkey_hash: bool,
    pub atomic_rotation: Support,
    pub custom_contract_for_tier_a: Support,
    pub commit_delay_reveal: Support,
    pub session_anchor: SessionAnchorKind,
    pub third_party_session_verification: bool,
    pub tier_b: Support,
    /// Typical broadcast-to-confirmation exposure window.
    pub confirmation_window_ms: u64,
    /// Private routes to adopt later (spec §10); today everything uses `PublicRpc`.
    pub private_submission: &'static [SubmissionRoute],
    pub notes: &'static str,
}

/// Static capability table from spec §14. Revisit when a migration trigger
/// fires (see `monitoring`).
pub fn capabilities() -> Vec<ChainCapabilities> {
    use Support::*;
    vec![
        ChainCapabilities {
            chain: Chain::Evm,
            identifier_is_pubkey_hash: true,
            atomic_rotation: Yes,
            custom_contract_for_tier_a: No,
            commit_delay_reveal: Yes,
            session_anchor: SessionAnchorKind::Erc7579Validator,
            third_party_session_verification: true,
            tier_b: Yes,
            confirmation_window_ms: 12_000,
            private_submission: &[
                SubmissionRoute::PrivateBundler,
                SubmissionRoute::FlashbotsProtect,
            ],
            notes: "ERC-4337 account (Nexus) + ERC-7579 rotation hook; Tier B on L2 first.",
        },
        ChainCapabilities {
            chain: Chain::Solana,
            identifier_is_pubkey_hash: false,
            atomic_rotation: Yes,
            custom_contract_for_tier_a: Yes,
            commit_delay_reveal: Yes,
            session_anchor: SessionAnchorKind::PdaField,
            third_party_session_verification: false,
            tier_b: Yes,
            confirmation_window_ms: 400,
            private_submission: &[SubmissionRoute::DirectToLeader, SubmissionRoute::JitoBundle],
            notes: "Custom program stores sha256(owner pubkey) in the wallet PDA.",
        },
        ChainCapabilities {
            chain: Chain::Bitcoin,
            identifier_is_pubkey_hash: true,
            atomic_rotation: Inherent,
            custom_contract_for_tier_a: No,
            commit_delay_reveal: No,
            session_anchor: SessionAnchorKind::IdentityAddress,
            third_party_session_verification: false,
            tier_b: No,
            confirmation_window_ms: 600_000,
            private_submission: &[SubmissionRoute::MinerDirect],
            notes: "Hygiene only: P2WPKH, no reuse, no Taproot key-path. Window excludes mempool time.",
        },
        ChainCapabilities {
            chain: Chain::Tron,
            identifier_is_pubkey_hash: true,
            atomic_rotation: ContractRouteOnly,
            custom_contract_for_tier_a: No,
            commit_delay_reveal: ContractRouteOnly,
            session_anchor: SessionAnchorKind::ZeroOpsPermission,
            third_party_session_verification: false,
            tier_b: ContractRouteOnly,
            confirmation_window_ms: 3_000,
            private_submission: &[SubmissionRoute::OwnNode],
            notes: "Native rotation is two transactions; the TVM contract route is atomic.",
        },
        ChainCapabilities {
            chain: Chain::Xrpl,
            identifier_is_pubkey_hash: true,
            atomic_rotation: Yes,
            custom_contract_for_tier_a: No,
            commit_delay_reveal: No,
            session_anchor: SessionAnchorKind::MessageKey,
            third_party_session_verification: false,
            tier_b: No,
            confirmation_window_ms: 4_000,
            private_submission: &[SubmissionRoute::OwnNode],
            notes: "Batch (ALLORNOTHING) bundles action + SetRegularKey; library support still settling.",
        },
    ]
}

/// Public on-chain state of an account, as read from the chain.
#[derive(Debug, Clone)]
pub struct OnChainAccount {
    pub owner_commitment: Option<String>,
    pub session: Option<(String, u64, SessionAnchor)>,
    pub vault: Option<VaultState>,
}

/// What each chain module implements. None of these methods ever touches an
/// owner key; the server only reads state, verifies session signatures and
/// relays already-signed payloads.
pub trait ChainAdapter: Send + Sync {
    /// Verify an off-chain message signed by the account's session key,
    /// using the chain's anchor (spec §9 "Where the session key is anchored").
    fn verify_session_signature(
        &self,
        req: &VerifySessionSignature,
    ) -> impl Future<Output = Result<SessionVerdict, AppError>> + Send;

    /// Read commitment, session anchor and Tier B counter from the chain.
    fn read_account(
        &self,
        address: &str,
    ) -> impl Future<Output = Result<OnChainAccount, AppError>> + Send;

    /// Post a commit for commit-delay-reveal (spec §10). The commit carries
    /// no owner signature, only `H(pubkey ‖ opHash ‖ salt)`.
    fn post_commit(
        &self,
        req: &CommitRequest,
    ) -> impl Future<Output = Result<CommitReceipt, AppError>> + Send;

    /// Broadcast a client-signed payload through the chain's public RPC.
    ///
    /// Spec §10's private submission (bundler endpoints, Jito, direct-to-
    /// leader) is deferred: it only defends the broadcast-to-confirmation
    /// window, and no attacker can crack a key that fast today. Switch to the
    /// routes in `ChainCapabilities::private_submission` when the
    /// `QuantumResourceEstimate` migration trigger fires.
    fn submit(
        &self,
        req: &SubmitRequest,
    ) -> impl Future<Output = Result<SubmissionReceipt, AppError>> + Send;
}

/// Error for a capability the chain does not have (see `capabilities()`).
pub(crate) fn unsupported(chain: Chain, what: &str) -> AppError {
    AppError::Unsupported(format!("{what} is not available on {chain:?}"))
}
