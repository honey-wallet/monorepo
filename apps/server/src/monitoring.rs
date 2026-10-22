//! Migration triggers (spec §12 "Monitoring triggers").
//!
//! Each trigger is an external event after which a chain's capabilities or the
//! recommended tier change, and users should be prompted to migrate.

use serde::Serialize;

use crate::wallet::UnixSeconds;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationTrigger {
    /// EIP-8141 or a post-quantum precompile on Ethereum mainnet.
    EthereumPqSignatures,
    /// A native post-quantum signature type on Solana mainnet.
    SolanaNativePq,
    /// Stable Batch support in xrpl.js and xrpl-py.
    XrplBatchLibraries,
    /// A quantum resource estimate that puts breaking secp256k1 or ed25519
    /// below a chain's confirmation window.
    QuantumResourceEstimate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerStatus {
    pub trigger: MigrationTrigger,
    pub fired: bool,
    pub last_checked_at: Option<UnixSeconds>,
    pub evidence: Option<String>,
}

// TODO(spec §12): a background task that polls each source (Ethereum fork
// schedule, Solana feature gates, npm/PyPI releases), stores `TriggerStatus`,
// and notifies when one fires.
