//! Optional relay for payloads the client has already signed (spec §10).
//!
//! The relay never signs for a user. It broadcasts client-signed transactions
//! (public RPC for now; private routes later, see `ChainAdapter::submit`), and
//! for commit-delay-reveal it posts the
//! client-computed commitment `H(pubkey ‖ opHash ‖ salt)` (which carries no
//! signature at all). Gas is paid from an operator fee-payer wallet that holds
//! only dust (spec §14 "Fee payers and relayers are always exposed"). Clients
//! may skip the relay and submit everything themselves.

use serde::{Deserialize, Serialize};

use crate::{
    chains::Chain,
    wallet::{Hash32Hex, UnixSeconds},
};

/// How a signed payload reaches the chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionRoute {
    /// The chain's normal public RPC. The default until spec §10 is adopted.
    PublicRpc,
    // Private routes that keep a public key out of public mempools (spec §10).
    PrivateBundler,
    FlashbotsProtect,
    DirectToLeader,
    JitoBundle,
    /// Our own node near block producers (Tron super representatives, XRPL validators).
    OwnNode,
    MinerDirect,
}

/// Step 1 of commit-delay-reveal. Computed on the client; contains no signature.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub account_id: String,
    /// `H(pubkey ‖ opHash ‖ salt)`; the server never sees the pubkey or salt.
    pub commitment: Hash32Hex,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitReceipt {
    pub commit_id: String,
    pub chain: Chain,
    pub tx_hash: String,
    /// Block or slot the commit landed in.
    pub committed_at: u64,
    /// First block or slot at which the reveal is accepted (`committed_at + d`).
    pub reveal_after: u64,
    pub expires_at: u64,
}

/// Step 2: the client-signed operation that opens the commit.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealRequest {
    /// Serialized, already-signed transaction or UserOp, as the chain expects it.
    pub signed_payload: String,
}

/// Broadcast a client-signed payload without commit-delay-reveal.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRequest {
    pub chain: Chain,
    pub account_id: String,
    /// Serialized, already-signed transaction or UserOp.
    pub signed_payload: String,
    /// Owner key index the client signed with, for the exposure log (spec §12).
    pub owner_key_index: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionReceipt {
    pub tx_hash: String,
    pub route: SubmissionRoute,
    pub submitted_at: UnixSeconds,
}
