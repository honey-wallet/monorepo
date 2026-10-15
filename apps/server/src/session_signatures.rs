//! Verifying off-chain messages signed by an account's session key (spec §9).
//!
//! Lets the wallet's own apps and backend authenticate a user on chains where
//! stock Sign-In libraries cannot (Solana PDA, Tron zero-ops permission, XRPL
//! `MessageKey`). Verification uses public keys only.

use serde::{Deserialize, Serialize};

use crate::{chains::Chain, wallet::UnixSeconds};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifySessionSignature {
    pub chain: Chain,
    /// The account address the dApp sees (smart account, PDA, ledger account).
    pub address: String,
    /// The exact message that was signed (UTF-8 for SIWE/SIWS text).
    pub message: String,
    /// Signature in the chain's native encoding (hex on EVM/Tron/XRPL, base58 on Solana).
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionVerdict {
    pub valid: bool,
    /// Why a signature was rejected: expired, unknown key, domain not allowlisted.
    pub reason: Option<String>,
    /// Validity is checked at call time; rotation revokes every past signature.
    pub session_expires_at: Option<UnixSeconds>,
}
