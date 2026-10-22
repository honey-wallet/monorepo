//! Account model: the server's mirror of on-chain wallet state.
//!
//! The server never holds a seed, owner key or one-time signature key. Keys are
//! derived and used only by the signers (spec §3). What lives here is public
//! on-chain state the server reads, caches and indexes: commitments, counters,
//! session-key anchors and recovery configuration.

use serde::{Deserialize, Serialize};

use crate::chains::Chain;

/// 0x-prefixed lowercase hex of a 32-byte hash (a commitment, Merkle root or op hash).
pub type Hash32Hex = String;

/// Unix time in seconds.
pub type UnixSeconds = u64;

/// Security tier (spec §2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    /// Hot: curve signature plus hash-commitment rotation, optional commit-delay-reveal.
    A,
    /// Vault: WOTS+ under an XMSS tree, verified on chain. No curve key exists.
    B,
}

/// One wallet on one chain.
///
/// "Account" is the ERC-4337 contract on EVM and Tron, the PDA on Solana and
/// the ledger account on XRPL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub chain: Chain,
    /// The address users and dApps see (smart account, PDA, ledger account).
    pub address: String,
    pub tier: Tier,
    /// Tier A: index `i` of the next owner key the signer will use (spec §3).
    pub owner_key_index: u64,
    /// Tier A: `hash(owner_key[i].pub)` as stored on chain. On EVM, Tron and XRPL
    /// this is the owner address itself; on Solana a sha256 in the PDA.
    pub owner_commitment: Option<Hash32Hex>,
    pub session: Option<SessionKey>,
    pub vault: Option<VaultState>,
    /// Commit-delay-reveal delay `d` in blocks or slots, if enabled (spec §10).
    pub commit_delay: Option<u64>,
}

/// Request to start tracking an already-deployed account. The client sends
/// public data only; the server verifies it against the chain.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterAccount {
    pub chain: Chain,
    pub address: String,
    pub tier: Tier,
}

/// Off-chain signing key (spec §2, §9). Expected to be exposed; harmless only
/// while its anchor has no execution rights.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionKey {
    pub public_key: String,
    pub expires_at: UnixSeconds,
    pub anchor: SessionAnchor,
}

/// Where the account vouches for its session key (spec §9 table).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionAnchor {
    /// EVM / Tron contract: ERC-7579 validator that hard-fails `validateUserOp`.
    Erc7579Validator { validator: String },
    /// Solana: `session_pubkey` + `session_expiry` fields in the wallet PDA.
    PdaField,
    /// Tron native: active permission whose `operations` bitmap is all zeros.
    ZeroOpsPermission { permission_id: u32 },
    /// XRPL: the account's `MessageKey` field.
    MessageKey,
}

/// Tier B on-chain state (spec §11).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultState {
    pub merkle_root: Hash32Hex,
    /// The chain rejects any leaf index at or below the last used one.
    pub next_leaf_index: u64,
    /// XMSS tree height (10–16); `2^height` one-time signatures per root.
    pub tree_height: u8,
}

/// Recovery configuration and in-flight migrations (spec §12).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    /// Guardians are hash commitments, never addresses with exposed keys.
    pub guardian_commitments: Vec<Hash32Hex>,
    pub threshold: u8,
    pub pending_migration: Option<PendingMigration>,
    /// Months without an owner operation before guardians may rotate without veto.
    pub dead_man_switch_months: Option<u8>,
    pub last_owner_operation_at: Option<UnixSeconds>,
}

/// A timelocked `freezeAndMigrate` the current owner can still veto.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMigration {
    pub new_owner_commitment: Option<Hash32Hex>,
    pub new_validator: Option<String>,
    pub executable_at: UnixSeconds,
}
