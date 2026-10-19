//! Across direct ERC20 deposits and unchanged fills. Provider status is not proof.
//! This module requires separately approved contract pins and trusted chain RPC;
//! it does not prepare, sign, broadcast, refund or advance operation state.
use super::{
    evm_prepare::{self, ContractPin, address_serde, hash_serde, uint_serde},
    evm_rpc::{EvmReadRpc, RpcError},
};
use alloy_primitives::{Address, B256, U256, keccak256};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const DEPOSIT: &str = "deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)";
const DEPOSIT_V3: &str = "depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)";
const DEPOSIT_EVENT: &str = "FundsDeposited(bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes32,bytes)";
const FILL_EVENT: &str = "FilledRelay(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,uint256,uint8))";
const TRANSFER: &str = "Transfer(address,address,uint256)";
const MAX_OFFSET: u32 = 31_536_000;
type Result<T> = std::result::Result<T, EvidenceError>;
#[derive(Debug, thiserror::Error)]
pub enum EvidenceError {
    #[error("invalid or unsupported Across evidence")]
    Invalid,
    #[error("Across evidence is missing or not finalized")]
    Pending,
    #[error("Across chain evidence changed")]
    Reorg,
    #[error("Across contract identity changed")]
    Identity,
    #[error("Across evidence deadline exceeded")]
    Timeout,
    #[error(transparent)]
    Rpc(#[from] RpcError),
}
/// Immutable financial terms from an independently reviewed direct deposit.
/// Empty message, zero native value and no periphery/fee callback are mandatory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectDepositTerms {
    #[serde(with = "decimal_serde")]
    pub source_chain: u64,
    #[serde(with = "decimal_serde")]
    pub destination_chain: u64,
    #[serde(with = "address_serde")]
    pub depositor: Address,
    #[serde(with = "address_serde")]
    pub recipient: Address,
    #[serde(with = "address_serde")]
    pub input_token: Address,
    #[serde(with = "address_serde")]
    pub output_token: Address,
    #[serde(with = "uint_serde")]
    pub input_amount: U256,
    #[serde(with = "uint_serde")]
    pub output_amount: U256,
    #[serde(with = "address_serde")]
    pub exclusive_relayer: Address,
    #[serde(with = "decimal_serde")]
    pub quote_timestamp: u32,
    #[serde(with = "decimal_serde")]
    pub fill_deadline: u32,
    #[serde(with = "decimal_serde")]
    pub exclusivity_parameter: u32,
    /// Exact swap/approval attribution trailer; absent for untagged direct calls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swap_api_integrator_id: Option<String>,
}
impl DirectDepositTerms {
    pub fn validate(&self) -> Result<()> {
        if let Some(id) = &self.swap_api_integrator_id
            && (id.len() != 6
                || !id.starts_with("0x")
                || !id[2..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        {
            return Err(EvidenceError::Invalid);
        }
        if self.source_chain == 0
            || self.destination_chain == 0
            || self.source_chain > 9_007_199_254_740_991
            || self.destination_chain > 9_007_199_254_740_991
            || self.source_chain == self.destination_chain
            || [
                self.depositor,
                self.recipient,
                self.input_token,
                self.output_token,
            ]
            .contains(&Address::ZERO)
            || self.input_amount == U256::ZERO
            || self.output_amount == U256::ZERO
            || self.quote_timestamp == 0
            || self.fill_deadline <= self.quote_timestamp
            || (self.exclusivity_parameter > 0 && self.exclusive_relayer == Address::ZERO)
        {
            return Err(EvidenceError::Invalid);
        }
        Ok(())
    }
    /// Validate every byte of the call against consent. Timestamp freshness,
    /// quote limits, allowance and simulation still belong to preparation.
    pub fn validate_calldata(&self, calldata: &str, native_value: U256) -> Result<()> {
        self.validate()?;
        let data = hex_bytes(calldata, 428)?;
        let expected_len = if self.swap_api_integrator_id.is_some() {
            428
        } else {
            420
        };
        if native_value != U256::ZERO
            || data.len() != expected_len
            || (data[..4] != keccak256(DEPOSIT)[..4] && data[..4] != keccak256(DEPOSIT_V3)[..4])
        {
            return Err(EvidenceError::Invalid);
        }
        if let Some(id) = &self.swap_api_integrator_id {
            let suffix = hex::decode(format!("1dc0de{}73c0de", &id[2..]))
                .map_err(|_| EvidenceError::Invalid)?;
            if data[420..] != suffix {
                return Err(EvidenceError::Invalid);
            }
        }
        let abi = Words::new(&data[4..420], 13)?;
        if abi.address(0)? != self.depositor
            || abi.address(1)? != self.recipient
            || abi.address(2)? != self.input_token
            || abi.address(3)? != self.output_token
            || abi.uint(4)? != self.input_amount
            || abi.uint(5)? != self.output_amount
            || abi.uint(6)? != U256::from(self.destination_chain)
            || abi.address(7)? != self.exclusive_relayer
            || abi.small(8)? != self.quote_timestamp
            || abi.small(9)? != self.fill_deadline
            || abi.small(10)? != self.exclusivity_parameter
            || abi.uint(11)? != U256::from(384)
            || abi.uint(12)? != U256::ZERO
        {
            return Err(EvidenceError::Invalid);
        }
        Ok(())
    }
    /// Decode candidate terms only. The quote boundary must still compare these
    /// against the authenticated request and operator route/fee registry.
    pub fn decode_calldata(
        source_chain: u64,
        integrator_id: Option<String>,
        calldata: &str,
        native_value: U256,
    ) -> Result<Self> {
        let data = hex_bytes(calldata, 428)?;
        if data.len() < 420 {
            return Err(EvidenceError::Invalid);
        }
        let w = Words::new(&data[4..420], 13)?;
        let terms = Self {
            source_chain,
            destination_chain: w.uint(6)?.try_into().map_err(|_| EvidenceError::Invalid)?,
            depositor: w.address(0)?,
            recipient: w.address(1)?,
            input_token: w.address(2)?,
            output_token: w.address(3)?,
            input_amount: w.uint(4)?,
            output_amount: w.uint(5)?,
            exclusive_relayer: w.address(7)?,
            quote_timestamp: w.small(8)?,
            fill_deadline: w.small(9)?,
            exclusivity_parameter: w.small(10)?,
            swap_api_integrator_id: integrator_id,
        };
        terms.validate_calldata(calldata, native_value)?;
        Ok(terms)
    }
}
/// Registry data, not quote-supplied addresses. Code identities must be approved
/// independently for the historical deployment and standard ERC20 semantics.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidencePolicy {
    pub chain: u64,
    pub spoke: ContractPin,
    pub spoke_implementation: ContractPin,
    pub token: ContractPin,
    pub token_implementation: Option<(TokenProxy, ContractPin)>,
    #[serde(with = "address_serde")]
    pub wrapped_native: Address,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenProxy {
    Eip1967,
    Usdc,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizedEvent {
    #[serde(with = "hash_serde")]
    pub transaction_hash: B256,
    pub block_number: u64,
    #[serde(with = "hash_serde")]
    pub block_hash: B256,
    pub log_index: u64,
    pub finalized_number: u64,
    #[serde(with = "hash_serde")]
    pub finalized_hash: B256,
}
/// No Deserialize/public constructor: obtained only by checking the pinned
/// source receipt and full event against the original terms.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedAcrossDeposit {
    terms: DirectDepositTerms,
    #[serde(with = "uint_serde")]
    deposit_id: U256,
    exclusivity_deadline: u32,
    source: FinalizedEvent,
    checked_at_ms: i64,
}
impl VerifiedAcrossDeposit {
    pub fn terms(&self) -> &DirectDepositTerms {
        &self.terms
    }
    pub fn deposit_id(&self) -> String {
        self.deposit_id.to_string()
    }
    pub fn source(&self) -> &FinalizedEvent {
        &self.source
    }
    pub fn checked_at_ms(&self) -> i64 {
        self.checked_at_ms
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedAcrossFill {
    deposit: VerifiedAcrossDeposit,
    destination: FinalizedEvent,
    fill_type: u32,
    checked_at_ms: i64,
}
impl VerifiedAcrossFill {
    pub fn checked_at_ms(&self) -> i64 {
        self.checked_at_ms
    }
    pub fn deposit(&self) -> &VerifiedAcrossDeposit {
        &self.deposit
    }
    pub fn destination(&self) -> &FinalizedEvent {
        &self.destination
    }
}
struct Words<'a>(&'a [u8]);
impl<'a> Words<'a> {
    fn new(data: &'a [u8], count: usize) -> Result<Self> {
        if data.len() != count * 32 {
            return Err(EvidenceError::Invalid);
        }
        Ok(Self(data))
    }
    fn word(&self, i: usize) -> Result<&[u8]> {
        self.0
            .get(i * 32..(i + 1) * 32)
            .ok_or(EvidenceError::Invalid)
    }
    fn uint(&self, i: usize) -> Result<U256> {
        Ok(U256::from_be_slice(self.word(i)?))
    }
    fn small(&self, i: usize) -> Result<u32> {
        self.uint(i)?.try_into().map_err(|_| EvidenceError::Invalid)
    }
    fn address(&self, i: usize) -> Result<Address> {
        let b = self.word(i)?;
        if b[..12].iter().any(|v| *v != 0) {
            return Err(EvidenceError::Invalid);
        }
        Ok(Address::from_slice(&b[12..]))
    }
}
fn hex_bytes(s: &str, max: usize) -> Result<Vec<u8>> {
    if !s.starts_with("0x") || s.len() > 2 + max * 2 || !s.len().is_multiple_of(2) {
        return Err(EvidenceError::Invalid);
    }
    hex::decode(&s[2..]).map_err(|_| EvidenceError::Invalid)
}
fn hash(v: &Value) -> Result<B256> {
    let b = hex_bytes(v.as_str().ok_or(EvidenceError::Invalid)?, 32)?;
    if b.len() != 32 || b.iter().all(|v| *v == 0) {
        return Err(EvidenceError::Invalid);
    }
    Ok(B256::from_slice(&b))
}
fn address(v: &Value) -> Result<Address> {
    let b = hex_bytes(v.as_str().ok_or(EvidenceError::Invalid)?, 20)?;
    if b.len() != 20 {
        return Err(EvidenceError::Invalid);
    }
    Ok(Address::from_slice(&b))
}
fn number(v: &Value) -> Result<u64> {
    evm_prepare::quantity(v)
        .map_err(|_| EvidenceError::Invalid)?
        .try_into()
        .map_err(|_| EvidenceError::Invalid)
}
struct Receipt {
    event: FinalizedEvent,
    timestamp: u32,
    logs: Vec<Value>,
}
async fn pin(rpc: &EvmReadRpc, p: &ContractPin, block: &str) -> Result<()> {
    let v = rpc.code(&format!("{:#x}", p.address), block).await?;
    let bytes = hex_bytes(v.as_str().ok_or(EvidenceError::Invalid)?, 49152)?;
    if p.address == Address::ZERO || bytes.is_empty() || keccak256(bytes) != p.code_hash {
        return Err(EvidenceError::Identity);
    }
    Ok(())
}
async fn implementation(
    rpc: &EvmReadRpc,
    proxy: Address,
    slot: &str,
    p: &ContractPin,
    block: &str,
) -> Result<()> {
    let value = rpc.storage(&format!("{proxy:#x}"), slot, block).await?;
    let bytes = hex_bytes(value.as_str().ok_or(EvidenceError::Invalid)?, 32)?;
    if Words::new(&bytes, 1)?.address(0)? != p.address {
        return Err(EvidenceError::Identity);
    }
    pin(rpc, p, block).await
}
async fn receipt(
    rpc: &EvmReadRpc,
    policy: &EvidencePolicy,
    tx: B256,
    source_sender: Option<Address>,
) -> Result<Receipt> {
    if tx == B256::ZERO
        || policy.chain == 0
        || policy.chain > 9_007_199_254_740_991
        || (policy.chain == 31337 && !rpc.is_loopback())
        || number(&rpc.chain_id().await?)? != policy.chain
        || policy.token.address == policy.wrapped_native
        || policy.wrapped_native == Address::ZERO
    {
        return Err(EvidenceError::Invalid);
    }
    let raw = rpc.receipt(&format!("{tx:#x}")).await?;
    if raw.is_null() {
        return Err(EvidenceError::Pending);
    }
    if hash(&raw["transactionHash"])? != tx
        || number(&raw["status"])? != 1
        || source_sender.is_some_and(|a| address(&raw["from"]).ok() != Some(a))
        || address(&raw["to"])? != policy.spoke.address
        || !raw["contractAddress"].is_null()
    {
        return Err(EvidenceError::Invalid);
    }
    let n = number(&raw["blockNumber"])?;
    let bh = hash(&raw["blockHash"])?;
    let index = number(&raw["transactionIndex"])?;
    let finalized = rpc.block("finalized").await?;
    let fnr = number(&finalized["number"])?;
    let fh = hash(&finalized["hash"])?;
    if n > fnr {
        return Err(EvidenceError::Pending);
    }
    let tag = format!("0x{n:x}");
    let block = rpc.block(&tag).await?;
    if number(&block["number"])? != n || hash(&block["hash"])? != bh || (n == fnr && bh != fh) {
        return Err(EvidenceError::Reorg);
    }
    let transactions = block["transactions"]
        .as_array()
        .ok_or(EvidenceError::Invalid)?;
    if index > 100000 || transactions.get(index as usize).map(hash).transpose()? != Some(tx) {
        return Err(EvidenceError::Invalid);
    }
    let timestamp = number(&block["timestamp"])?
        .try_into()
        .map_err(|_| EvidenceError::Invalid)?;
    pin(rpc, &policy.spoke, &tag).await?;
    implementation(
        rpc,
        policy.spoke.address,
        evm_prepare::AAVE_IMPLEMENTATION_SLOT,
        &policy.spoke_implementation,
        &tag,
    )
    .await?;
    pin(rpc, &policy.token, &tag).await?;
    if let Some((family, p)) = &policy.token_implementation {
        implementation(
            rpc,
            policy.token.address,
            match family {
                TokenProxy::Eip1967 => evm_prepare::AAVE_IMPLEMENTATION_SLOT,
                TokenProxy::Usdc => evm_prepare::USDC_IMPLEMENTATION_SLOT,
            },
            p,
            &tag,
        )
        .await?;
    }
    let wrapped = rpc
        .call(
            &format!("{:#x}", policy.spoke.address),
            &evm_prepare::encode_call("wrappedNativeToken()", &[]),
            &tag,
        )
        .await?;
    let wrapped = hex_bytes(wrapped.as_str().ok_or(EvidenceError::Invalid)?, 32)?;
    if Words::new(&wrapped, 1)?.address(0)? != policy.wrapped_native {
        return Err(EvidenceError::Identity);
    }
    let logs = raw["logs"]
        .as_array()
        .filter(|l| l.len() <= 512)
        .ok_or(EvidenceError::Invalid)?;
    let mut prev = None;
    for log in logs {
        let li = number(&log["logIndex"])?;
        if log["removed"] != false
            || hash(&log["transactionHash"])? != tx
            || hash(&log["blockHash"])? != bh
            || number(&log["blockNumber"])? != n
            || number(&log["transactionIndex"])? != index
            || prev.is_some_and(|p| li <= p)
        {
            return Err(EvidenceError::Invalid);
        }
        prev = Some(li);
    }
    // Numeric block reads above must still belong to the same canonical branch.
    for (nr, h) in [(n, bh), (fnr, fh)] {
        let b = rpc.block(&format!("0x{nr:x}")).await?;
        if number(&b["number"])? != nr || hash(&b["hash"])? != h {
            return Err(EvidenceError::Reorg);
        }
    }
    Ok(Receipt {
        event: FinalizedEvent {
            transaction_hash: tx,
            block_number: n,
            block_hash: bh,
            log_index: 0,
            finalized_number: fnr,
            finalized_hash: fh,
        },
        timestamp,
        logs: logs.clone(),
    })
}
fn matching<'a>(receipt: &'a Receipt, emitter: Address, signature: &str) -> Result<Vec<&'a Value>> {
    let topic = format!("{:#x}", keccak256(signature));
    let mut result = vec![];
    for log in &receipt.logs {
        if address(&log["address"])? == emitter && log["topics"][0] == topic {
            result.push(log);
        }
    }
    Ok(result)
}
fn event_words(log: &Value, count: usize) -> Result<(Vec<u8>, Vec<u8>)> {
    let topics = log["topics"]
        .as_array()
        .filter(|t| t.len() == 4)
        .ok_or(EvidenceError::Invalid)?;
    let mut indexed = vec![];
    for t in &topics[1..] {
        let bytes = hex_bytes(t.as_str().ok_or(EvidenceError::Invalid)?, 32)?;
        if bytes.len() != 32 {
            return Err(EvidenceError::Invalid);
        }
        indexed.extend(bytes);
    }
    let data = hex_bytes(
        log["data"].as_str().ok_or(EvidenceError::Invalid)?,
        count * 32,
    )?;
    Words::new(&data, count)?;
    Ok((indexed, data))
}
/// Standard-token transfer accounting; code pins must exclude rebasing,
/// fee-on-transfer and misleading-event tokens. No native-token inference.
fn transfer(
    receipt: &Receipt,
    token: Address,
    sender: Option<Address>,
    recipient: Address,
    amount: U256,
    event_index: u64,
    before: bool,
) -> Result<()> {
    let mut found = 0;
    for log in matching(receipt, token, TRANSFER)? {
        let topics = log["topics"]
            .as_array()
            .filter(|v| v.len() == 3)
            .ok_or(EvidenceError::Invalid)?;
        let decode = |v: &Value| -> Result<Address> {
            let b = hex_bytes(v.as_str().ok_or(EvidenceError::Invalid)?, 32)?;
            Words::new(&b, 1)?.address(0)
        };
        let from = decode(&topics[1])?;
        let to = decode(&topics[2])?;
        let data = hex_bytes(log["data"].as_str().ok_or(EvidenceError::Invalid)?, 32)?;
        let value = Words::new(&data, 1)?.uint(0)?;
        if to == recipient || from == recipient || sender == Some(from) {
            let li = number(&log["logIndex"])?;
            if to != recipient
                || from == recipient
                || sender.is_some_and(|a| a != from)
                || value != amount
                || (before && li >= event_index)
                || (!before && li <= event_index)
            {
                return Err(EvidenceError::Invalid);
            }
            found += 1;
        }
    }
    if found != 1 {
        return Err(EvidenceError::Invalid);
    }
    Ok(())
}
pub async fn verify_deposit(
    rpc: &EvmReadRpc,
    policy: &EvidencePolicy,
    terms: &DirectDepositTerms,
    source_hash: B256,
) -> Result<VerifiedAcrossDeposit> {
    tokio::time::timeout(Duration::from_secs(30), async {
        terms.validate()?;
        if policy.chain != terms.source_chain || policy.token.address != terms.input_token {
            return Err(EvidenceError::Invalid);
        }
        let mut receipt = receipt(rpc, policy, source_hash, Some(terms.depositor)).await?;
        let transaction = rpc.transaction(&format!("{source_hash:#x}")).await?;
        if hash(&transaction["hash"])? != source_hash
            || hash(&transaction["blockHash"])? != receipt.event.block_hash
            || number(&transaction["blockNumber"])? != receipt.event.block_number
            || number(&transaction["chainId"])? != terms.source_chain
            || address(&transaction["from"])? != terms.depositor
            || address(&transaction["to"])? != policy.spoke.address
        {
            return Err(EvidenceError::Invalid);
        }
        terms.validate_calldata(
            transaction["input"]
                .as_str()
                .ok_or(EvidenceError::Invalid)?,
            evm_prepare::quantity(&transaction["value"]).map_err(|_| EvidenceError::Invalid)?,
        )?;
        let logs = matching(&receipt, policy.spoke.address, DEPOSIT_EVENT)?;
        if logs.len() != 1 {
            return Err(EvidenceError::Invalid);
        }
        let log = logs[0];
        let (topics, data) = event_words(log, 11)?;
        let t = Words::new(&topics, 3)?;
        let d = Words::new(&data, 11)?;
        let exclusivity =
            if terms.exclusivity_parameter > 0 && terms.exclusivity_parameter <= MAX_OFFSET {
                receipt
                    .timestamp
                    .checked_add(terms.exclusivity_parameter)
                    .ok_or(EvidenceError::Invalid)?
            } else {
                terms.exclusivity_parameter
            };
        if t.uint(0)? != U256::from(terms.destination_chain)
            || t.address(2)? != terms.depositor
            || d.address(0)? != terms.input_token
            || d.address(1)? != terms.output_token
            || d.uint(2)? != terms.input_amount
            || d.uint(3)? != terms.output_amount
            || d.small(4)? != terms.quote_timestamp
            || d.small(5)? != terms.fill_deadline
            || d.small(6)? != exclusivity
            || d.address(7)? != terms.recipient
            || d.address(8)? != terms.exclusive_relayer
            || d.uint(9)? != U256::from(320)
            || d.uint(10)? != U256::ZERO
            || terms.quote_timestamp > receipt.timestamp
        {
            return Err(EvidenceError::Invalid);
        }
        let deposit_id = t.uint(1)?;
        // Only the counter-based deposit/depositV3 path; unsafe IDs need their own proof.
        if deposit_id > U256::from(u32::MAX) {
            return Err(EvidenceError::Invalid);
        }
        let index = number(&log["logIndex"])?;
        transfer(
            &receipt,
            terms.input_token,
            Some(terms.depositor),
            policy.spoke.address,
            terms.input_amount,
            index,
            true,
        )?;
        let current = rpc
            .block(&format!("0x{:x}", receipt.event.block_number))
            .await?;
        if number(&current["number"])? != receipt.event.block_number
            || hash(&current["hash"])? != receipt.event.block_hash
        {
            return Err(EvidenceError::Reorg);
        }
        receipt.event.log_index = index;
        Ok(VerifiedAcrossDeposit {
            terms: terms.clone(),
            deposit_id,
            exclusivity_deadline: exclusivity,
            source: receipt.event,
            checked_at_ms: evm_prepare::now_ms(),
        })
    })
    .await
    .map_err(|_| EvidenceError::Timeout)?
}
/// The source proof must be refreshed against its source RPC before a durable
/// terminal transition; this function checks the destination branch only.
async fn verify_fill(
    rpc: &EvmReadRpc,
    policy: &EvidencePolicy,
    source: &VerifiedAcrossDeposit,
    candidate: B256,
) -> Result<VerifiedAcrossFill> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let terms = &source.terms;
        if policy.chain != terms.destination_chain || policy.token.address != terms.output_token {
            return Err(EvidenceError::Invalid);
        }
        let mut receipt = receipt(rpc, policy, candidate, None).await?;
        let logs = matching(&receipt, policy.spoke.address, FILL_EVENT)?;
        // Reject batched fills until each is independently disambiguated.
        if logs.len() != 1 {
            return Err(EvidenceError::Invalid);
        }
        let log = logs[0];
        let (topics, data) = event_words(log, 15)?;
        let t = Words::new(&topics, 3)?;
        let d = Words::new(&data, 15)?;
        if t.uint(0)? != U256::from(terms.source_chain)
            || t.uint(1)? != source.deposit_id
            || d.address(0)? != terms.input_token
            || d.address(1)? != terms.output_token
            || d.uint(2)? != terms.input_amount
            || d.uint(3)? != terms.output_amount
            || d.small(5)? != terms.fill_deadline
            || d.small(6)? != source.exclusivity_deadline
            || d.address(7)? != terms.exclusive_relayer
            || d.address(8)? != terms.depositor
            || d.address(9)? != terms.recipient
            || d.uint(10)? != U256::ZERO
            || d.address(11)? != terms.recipient
            || d.uint(12)? != U256::ZERO
            || d.uint(13)? != terms.output_amount
            || d.small(14)? > 2
            || receipt.timestamp > terms.fill_deadline
        {
            return Err(EvidenceError::Invalid);
        }
        let index = number(&log["logIndex"])?;
        transfer(
            &receipt,
            terms.output_token,
            None,
            terms.recipient,
            terms.output_amount,
            index,
            false,
        )?;
        receipt.event.log_index = index;
        Ok(VerifiedAcrossFill {
            deposit: source.clone(),
            destination: receipt.event,
            fill_type: d.small(14)?,
            checked_at_ms: evm_prepare::now_ms(),
        })
    })
    .await
    .map_err(|_| EvidenceError::Timeout)?
}
/// Refresh both sides in one bounded observation and recheck the source branch
/// after destination reads. Callers still need a durable operation/version fence.
pub async fn verify_delivery(
    source_rpc: &EvmReadRpc,
    source_policy: &EvidencePolicy,
    destination_rpc: &EvmReadRpc,
    destination_policy: &EvidencePolicy,
    terms: &DirectDepositTerms,
    source_hash: B256,
    candidate: B256,
) -> Result<VerifiedAcrossFill> {
    tokio::time::timeout(Duration::from_secs(60), async {
        let source = verify_deposit(source_rpc, source_policy, terms, source_hash).await?;
        let mut result =
            verify_fill(destination_rpc, destination_policy, &source, candidate).await?;
        for (n, h) in [
            (source.source.block_number, source.source.block_hash),
            (source.source.finalized_number, source.source.finalized_hash),
        ] {
            let block = source_rpc.block(&format!("0x{n:x}")).await?;
            if number(&block["number"])? != n || hash(&block["hash"])? != h {
                return Err(EvidenceError::Reorg);
            }
        }
        result.checked_at_ms = evm_prepare::now_ms();
        Ok(result)
    })
    .await
    .map_err(|_| EvidenceError::Timeout)?
}
#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) async fn test_deposit() -> VerifiedAcrossDeposit {
    tests::source_proof().await
}
#[cfg(test)]
pub(crate) async fn test_fill() -> VerifiedAcrossFill {
    tests::delivery_proof().await
}

mod decimal_serde {
    use serde::{Deserialize, Deserializer, Serializer};
    use std::str::FromStr;
    pub fn serialize<T: ToString, S: Serializer>(
        value: &T,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, T: FromStr + ToString, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<T, D::Error> {
        let value = String::deserialize(deserializer)?;
        let parsed = value
            .parse::<T>()
            .map_err(|_| serde::de::Error::custom("invalid unsigned integer"))?;
        if parsed.to_string() != value {
            return Err(serde::de::Error::custom("noncanonical integer"));
        }
        Ok(parsed)
    }
}

#[cfg(test)]
pub(crate) use tests::local_delivery_proof as test_local_fill;
