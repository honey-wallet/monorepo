//! PermitSingle hashing and EOA signature proof. No RPC, persistence or broadcast.
//! Trusted service code must bind these terms to an immutable intent and a fresh
//! on-chain allowance nonce before calling; signature validity alone is not admission.
use alloy_primitives::{Address, B256, Signature, U256, keccak256};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermitTerms {
    pub chain_id: String,
    pub permit2: String,
    pub owner: String,
    pub token: String,
    pub amount_raw: String,
    pub spender: String,
    pub nonce: String,
    pub expiration: String,
    pub sig_deadline: String,
}
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("invalid or expired Permit2 authority")]
pub struct PermitError;
type Result<T> = std::result::Result<T, PermitError>;
fn uint(s: &str, bits: usize) -> Result<U256> {
    if s.is_empty()
        || s.len() > 78
        || s.len() > 1 && s.starts_with('0')
        || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(PermitError);
    }
    let n = U256::from_str_radix(s, 10).map_err(|_| PermitError)?;
    if bits < 256 && n >= U256::from(1).wrapping_shl(bits) {
        return Err(PermitError);
    }
    Ok(n)
}
fn address(s: &str) -> Result<Address> {
    let a: Address = s.parse().map_err(|_| PermitError)?;
    if s != format!("{a:#x}") || a == Address::ZERO {
        return Err(PermitError);
    }
    Ok(a)
}
fn word(a: Address) -> [u8; 32] {
    let mut word = [0; 32];
    word[12..].copy_from_slice(a.as_slice());
    word
}
fn hash(words: &[[u8; 32]]) -> B256 {
    keccak256(words.concat())
}
impl PermitTerms {
    /// Applies Honey's bounded lifetime/finite amount policy, stricter than Permit2.
    /// `now` is trusted Unix seconds. Exact deadline equality is rejected deliberately.
    pub fn digest(&self, now: u64) -> Result<B256> {
        let chain = uint(&self.chain_id, 64)?;
        let amount = uint(&self.amount_raw, 160)?;
        let nonce = uint(&self.nonce, 48)?;
        let expiration = uint(&self.expiration, 48)?;
        let deadline = uint(&self.sig_deadline, 48)?;
        if now == 0
            || now > u64::MAX - 2_592_000
            || chain == U256::ZERO
            || chain > U256::from(9_007_199_254_740_991u64)
            || amount == U256::ZERO
            || amount == U256::from(1).wrapping_shl(160) - U256::from(1)
            || deadline <= U256::from(now)
            || deadline > U256::from(now + 1800)
            || expiration < deadline
            || expiration > U256::from(now + 2_592_000)
        {
            return Err(PermitError);
        }
        address(&self.owner)?;
        let domain = hash(&[
            keccak256(b"EIP712Domain(string name,uint256 chainId,address verifyingContract)").0,
            keccak256(b"Permit2").0,
            chain.to_be_bytes(),
            word(address(&self.permit2)?),
        ]);
        let details = hash(&[
            keccak256(
                b"PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)",
            )
            .0,
            word(address(&self.token)?),
            amount.to_be_bytes(),
            expiration.to_be_bytes(),
            nonce.to_be_bytes(),
        ]);
        let message = hash(&[
            keccak256(b"PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)").0,
            details.0, word(address(&self.spender)?), deadline.to_be_bytes(),
        ]);
        let mut bytes = vec![0x19, 0x01];
        bytes.extend_from_slice(domain.as_slice());
        bytes.extend_from_slice(message.as_slice());
        Ok(keccak256(bytes))
    }
    /// Proves EOA ownership of exactly these terms. Caller still owes nonce/state,
    /// intent, fee and destination checks. No signature bytes are returned or logged.
    pub fn verify_signature(&self, raw: &str, now: u64) -> Result<B256> {
        let digest = self.digest(now)?;
        if !raw.starts_with("0x") || ![130, 132].contains(&raw.len()) {
            return Err(PermitError);
        }
        let bytes = Zeroizing::new(hex::decode(&raw[2..]).map_err(|_| PermitError)?);
        let signature = if bytes.len() == 64 {
            Signature::from_erc2098(&bytes)
        } else {
            // Permit2's ecrecover requires 27/28, not the normalization accepted by
            // some wallet libraries (0/1, or transaction EIP-155 recovery values).
            if ![27, 28].contains(&bytes[64]) {
                return Err(PermitError);
            }
            Signature::from_raw(&bytes).map_err(|_| PermitError)?
        };
        // Honey requires low-S even though raw ecrecover accepts malleable high-S.
        if signature.normalize_s().is_some()
            || signature
                .recover_address_from_prehash(&digest)
                .map_err(|_| PermitError)?
                != address(&self.owner)?
        {
            return Err(PermitError);
        }
        Ok(digest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    #[test]
    fn viem_digest_and_both_signature_encodings_prove_exact_owner_authority() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../../packages/api-client/src/fixtures/permit2.json"
        ))
        .unwrap();
        let terms: PermitTerms = serde_json::from_value(f["terms"].clone()).unwrap();
        let now = f["now"].as_u64().unwrap();
        let digest = terms.digest(now).unwrap();
        assert_eq!(format!("{digest:#x}"), f["digest"].as_str().unwrap());
        for field in ["signature", "compact"] {
            assert_eq!(
                terms
                    .verify_signature(f[field].as_str().unwrap(), now)
                    .unwrap(),
                digest
            );
        }
        assert!(
            terms
                .verify_signature(f["highS"].as_str().unwrap(), now)
                .is_err()
        );
        let signature = f["signature"].as_str().unwrap();
        for (field, value) in [
            ("chainId", json!("2")),
            (
                "permit2",
                json!("0x1111111111111111111111111111111111111111"),
            ),
            ("owner", json!("0x1111111111111111111111111111111111111111")),
            ("token", json!("0x1111111111111111111111111111111111111111")),
            (
                "spender",
                json!("0x1111111111111111111111111111111111111111"),
            ),
            ("amountRaw", json!("1001")),
            ("nonce", json!("8")),
            ("expiration", json!((now + 3601).to_string())),
            ("sigDeadline", json!((now + 601).to_string())),
        ] {
            let mut changed = f["terms"].clone();
            changed[field] = value;
            let changed: PermitTerms = serde_json::from_value(changed).unwrap();
            assert!(changed.verify_signature(signature, now).is_err(), "{field}");
        }
        for recovery in ["00", "01", "25", "ff"] {
            assert!(
                terms
                    .verify_signature(&format!("{}{recovery}", &signature[..130]), now)
                    .is_err()
            );
        }
        assert!(terms.verify_signature(signature, now + 600).is_err());
        for (field, value) in [
            ("amountRaw", "0".into()),
            ("amountRaw", "01".into()),
            (
                "amountRaw",
                (U256::from(1).wrapping_shl(160) - U256::from(1)).to_string(),
            ),
            ("nonce", (1u64 << 48).to_string()),
            ("expiration", (now + 2_592_001).to_string()),
            ("expiration", (now + 1).to_string()),
            ("sigDeadline", (now + 1801).to_string()),
        ] {
            let mut changed = f["terms"].clone();
            changed[field] = json!(value);
            assert!(
                serde_json::from_value::<PermitTerms>(changed)
                    .unwrap()
                    .digest(now)
                    .is_err(),
                "{field}"
            );
        }
    }
}
