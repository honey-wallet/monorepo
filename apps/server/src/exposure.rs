//! Exposure log (spec §12 operational rules).
//!
//! Every owner-key signature reveals that key's public key, so each one is
//! recorded with its index. The log lets us prove no key was used twice and
//! alert when a retired commitment signs again (a cracked key or a replay).

use serde::{Deserialize, Serialize};

use crate::{chains::Chain, wallet::UnixSeconds};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExposureKind {
    /// An owner key signed; it is burned from this moment, even if the tx fails.
    OwnerSignature,
    /// Action and rotation could not be bundled (Tron native, XRPL without Batch).
    RotationWindow,
    /// XRPL one-time master key exposure during setup.
    MasterKeySetup,
    /// A Tier B one-time leaf was used.
    VaultLeaf,
}

/// Reported by the client right after its signer produces a signature.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportExposure {
    pub kind: ExposureKind,
    /// Owner key index `i`, or the Tier B leaf index.
    pub key_index: u64,
    pub tx_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposureEvent {
    pub id: String,
    pub account_id: String,
    pub chain: Chain,
    pub kind: ExposureKind,
    pub key_index: u64,
    pub tx_hash: Option<String>,
    pub observed_at: UnixSeconds,
}

/// Alerts the log raises (spec §12).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExposureAlert {
    /// The same owner key index or Tier B leaf was reported twice.
    KeyReuse { account_id: String, key_index: u64 },
    /// A transaction was signed by a commitment that was already rotated away.
    RetiredCommitmentActive { account_id: String, tx_hash: String },
    /// A signed payload was seen in a public mempool despite private submission.
    PublicMempoolLeak { account_id: String, tx_hash: String },
}

// TODO(spec §12): persistence, reuse detection on insert, a chain watcher that
// raises `RetiredCommitmentActive`, and alert delivery.
