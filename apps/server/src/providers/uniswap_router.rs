//! Bounded canonical ABI decoding for Universal Router 2.1.2 CLASSIC ERC20 builds.
//! Decoding is NOT signing authorization: intent/economics, contract identity, EIP-712
//! signatures, nonce/allowance, simulation and durable execution must be checked separately.
use alloy_primitives::{Address, U256, keccak256};
#[cfg(test)]
use serde::Serialize;
use zeroize::Zeroizing;

pub const SOURCE_COMMIT: &str = "802fe4c18f47300e0f183e2a42e9146ec2ea9fc3";
const MAX_BYTES: usize = 65536;
const MAX_COMMANDS: usize = 64;
const MAX_HOPS: usize = 8;
type Result<T> = std::result::Result<T, DecodeError>;
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("unsupported or noncanonical Universal Router 2.1.2 calldata")]
pub struct DecodeError;

#[cfg_attr(test, derive(Serialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
pub struct Execution {
    pub deadline: String,
    pub commands: Vec<Command>,
}
impl Execution {
    /// Verify the embedded permit against independently persisted authority. This
    /// does not validate the other commands' spend/receive/fee economics.
    pub fn verify_embedded_permit(
        &self,
        expected: Option<&super::permit2::PermitTerms>,
        now: u64,
    ) -> std::result::Result<Option<alloy_primitives::B256>, super::permit2::PermitError> {
        use super::permit2::PermitError;
        let permits = self
            .commands
            .iter()
            .enumerate()
            .filter(|(_, c)| matches!(c, Command::PermitSingle { .. }))
            .collect::<Vec<_>>();
        match (expected, permits.as_slice()) {
            (None, []) => Ok(None),
            (
                Some(terms),
                [
                    (
                        0,
                        Command::PermitSingle {
                            token,
                            amount_raw,
                            expiration,
                            nonce,
                            spender,
                            sig_deadline,
                            signature,
                        },
                    ),
                ],
            ) => {
                if token != &terms.token
                    || amount_raw != &terms.amount_raw
                    || expiration != &terms.expiration
                    || nonce != &terms.nonce
                    || spender != &terms.spender
                    || sig_deadline != &terms.sig_deadline
                {
                    return Err(PermitError);
                }
                let deadline = U256::from_str_radix(&self.deadline, 10).map_err(|_| PermitError)?;
                let permit_deadline =
                    U256::from_str_radix(sig_deadline, 10).map_err(|_| PermitError)?;
                if deadline <= U256::from(now) || deadline > permit_deadline {
                    return Err(PermitError);
                }
                terms.verify_signature(signature, now).map(Some)
            }
            _ => Err(PermitError),
        }
    }
}
#[cfg_attr(test, derive(Serialize))]
#[cfg_attr(
    test,
    serde(
        tag = "kind",
        rename_all = "snake_case",
        rename_all_fields = "camelCase"
    )
)]
pub enum Command {
    V2ExactIn {
        recipient: String,
        amount_in_raw: String,
        minimum_out_raw: String,
        path: Vec<String>,
        payer_is_user: bool,
        min_hop_prices: Vec<String>,
    },
    V3ExactIn {
        recipient: String,
        amount_in_raw: String,
        minimum_out_raw: String,
        path: Vec<V3Hop>,
        payer_is_user: bool,
        min_hop_prices: Vec<String>,
    },
    V4 {
        actions: Vec<V4Action>,
    },
    PermitSingle {
        token: String,
        amount_raw: String,
        expiration: String,
        nonce: String,
        spender: String,
        sig_deadline: String,
        #[cfg_attr(test, serde(serialize_with = "serialize_signature"))]
        signature: Zeroizing<String>,
    },
    TransferFrom {
        token: String,
        recipient: String,
        amount_raw: String,
    },
    Sweep {
        token: String,
        recipient: String,
        minimum_raw: String,
    },
    Transfer {
        token: String,
        recipient: String,
        amount_raw: String,
    },
    PayPortion {
        token: String,
        recipient: String,
        bps: String,
    },
    PayPortionFullPrecision {
        token: String,
        recipient: String,
        portion: String,
    },
}
#[cfg_attr(test, derive(Serialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
pub struct V3Hop {
    pub token_in: String,
    pub token_out: String,
    pub fee: u32,
}
#[cfg_attr(test, derive(Serialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
pub struct V4Hop {
    pub token_out: String,
    pub fee: u32,
    pub tick_spacing: u32,
}
#[cfg_attr(test, derive(Serialize))]
#[cfg_attr(
    test,
    serde(
        tag = "kind",
        rename_all = "snake_case",
        rename_all_fields = "camelCase"
    )
)]
pub enum V4Action {
    ExactIn {
        token_in: String,
        path: Vec<V4Hop>,
        amount_in_raw: String,
        minimum_out_raw: String,
        min_hop_prices: Vec<String>,
    },
    Settle {
        token: String,
        amount_raw: String,
        payer_is_user: bool,
    },
    SettleAll {
        token: String,
        maximum_raw: String,
    },
    Take {
        token: String,
        recipient: String,
        amount_raw: String,
    },
    TakeAll {
        token: String,
        minimum_raw: String,
    },
    TakePortion {
        token: String,
        recipient: String,
        bps: String,
    },
}

// Require canonical abi.encode offsets, tails, padding, integer widths and booleans.
// Solidity's assembly decoder is more permissive; the signing boundary deliberately
// rejects aliasing, ignored bytes and encodings with multiple interpretations.
struct Abi<'a> {
    data: &'a [u8],
    words: usize,
    end: usize,
}
impl<'a> Abi<'a> {
    fn new(data: &'a [u8], words: usize) -> Result<Self> {
        let end = words.checked_mul(32).ok_or(DecodeError)?;
        if data.len() < end || data.len() > MAX_BYTES {
            return Err(DecodeError);
        }
        Ok(Self { data, words, end })
    }
    fn uint(&self, i: usize, bits: usize) -> Result<U256> {
        if i >= self.words || bits == 0 || bits > 256 {
            return Err(DecodeError);
        }
        let n = U256::from_be_slice(&self.data[i * 32..i * 32 + 32]);
        if bits < 256 && n >= U256::from(1).wrapping_shl(bits) {
            return Err(DecodeError);
        }
        Ok(n)
    }
    fn decimal(&self, i: usize, bits: usize) -> Result<String> {
        Ok(self.uint(i, bits)?.to_string())
    }
    fn size(&self, i: usize) -> Result<usize> {
        let n = self.uint(i, 32)?.to::<usize>();
        if n > MAX_BYTES {
            return Err(DecodeError);
        }
        Ok(n)
    }
    fn address(&self, i: usize) -> Result<String> {
        let bytes = self.uint(i, 160)?.to_be_bytes::<32>();
        Ok(format!("{:#x}", Address::from_slice(&bytes[12..])))
    }
    fn boolean(&self, i: usize) -> Result<bool> {
        Ok(self.uint(i, 1)? == U256::from(1))
    }
    fn dynamic<T>(
        &mut self,
        i: usize,
        parse: impl FnOnce(&'a [u8]) -> Result<(T, usize)>,
    ) -> Result<T> {
        if self.size(i)? != self.end {
            return Err(DecodeError);
        }
        let (value, consumed) = parse(&self.data[self.end..])?;
        self.end = self.end.checked_add(consumed).ok_or(DecodeError)?;
        if self.end > self.data.len() || !self.end.is_multiple_of(32) {
            return Err(DecodeError);
        }
        Ok(value)
    }
    fn bytes(&mut self, i: usize) -> Result<&'a [u8]> {
        self.dynamic(i, |data| {
            let length = Abi::new(data, 1)?.size(0)?;
            let padded = length.div_ceil(32) * 32;
            let end = 32 + padded;
            if end > data.len() || data[32 + length..end].iter().any(|b| *b != 0) {
                return Err(DecodeError);
            }
            Ok((&data[32..32 + length], end))
        })
    }
    fn uints(&mut self, i: usize, max: usize) -> Result<Vec<String>> {
        self.dynamic(i, |data| {
            let n = Abi::new(data, 1)?.size(0)?;
            if n > max {
                return Err(DecodeError);
            }
            let values = Abi::new(&data[32..], n)?;
            Ok((
                (0..n)
                    .map(|i| values.decimal(i, 256))
                    .collect::<Result<_>>()?,
                32 + values.end,
            ))
        })
    }
    fn byte_array(&mut self, i: usize) -> Result<Vec<&'a [u8]>> {
        self.dynamic(i, |data| {
            let n = Abi::new(data, 1)?.size(0)?;
            if n == 0 || n > MAX_COMMANDS {
                return Err(DecodeError);
            }
            let mut values = Abi::new(&data[32..], n)?;
            let result = (0..n).map(|i| values.bytes(i)).collect::<Result<_>>()?;
            Ok((result, 32 + values.end))
        })
    }
    fn finish(&self) -> Result<()> {
        if self.end != self.data.len() {
            return Err(DecodeError);
        }
        Ok(())
    }
}

fn hop_prices(prices: &[String], hops: usize) -> Result<()> {
    if hops == 0 || hops > MAX_HOPS || (!prices.is_empty() && prices.len() != hops) {
        return Err(DecodeError);
    }
    Ok(())
}
fn fee(n: U256) -> Result<u32> {
    let n = n.to::<u32>();
    // No dynamic-fee flag: these routes forbid hooks.
    if n > 1_000_000 {
        return Err(DecodeError);
    }
    Ok(n)
}
fn spacing(abi: &Abi<'_>, i: usize) -> Result<u32> {
    // PoolManager permits strictly positive int24 tick spacing, up to 32767.
    let n = abi.uint(i, 24)?.to::<u32>();
    if n == 0 || n > 32767 {
        return Err(DecodeError);
    }
    Ok(n)
}
fn no_hooks(abi: &Abi<'_>, i: usize, data: &[u8]) -> Result<()> {
    if abi.uint(i, 160)? != U256::ZERO || !data.is_empty() {
        return Err(DecodeError);
    }
    Ok(())
}
type CommandInputs<'a> = (Abi<'a>, &'a [u8], Vec<&'a [u8]>);
fn paired(data: &[u8], words: usize) -> Result<CommandInputs<'_>> {
    let mut abi = Abi::new(data, words)?;
    let commands = abi.bytes(0)?;
    let inputs = abi.byte_array(1)?;
    if commands.is_empty() || commands.len() != inputs.len() {
        return Err(DecodeError);
    }
    abi.finish()?;
    Ok((abi, commands, inputs))
}

pub fn decode(data: &str) -> Result<Execution> {
    if !data.starts_with("0x") || data.len() > 2 + MAX_BYTES * 2 || !data.len().is_multiple_of(2) {
        return Err(DecodeError);
    }
    let bytes = Zeroizing::new(hex::decode(&data[2..]).map_err(|_| DecodeError)?);
    let selector = keccak256(b"execute(bytes,bytes[],uint256)");
    if bytes.get(..4) != Some(&selector[..4]) {
        return Err(DecodeError);
    }
    let (abi, commands, inputs) = paired(&bytes[4..], 3)?;
    let deadline = abi.decimal(2, 256)?;
    let commands = commands
        .iter()
        .zip(inputs)
        .map(|(op, input)| command(*op, input))
        .collect::<Result<_>>()?;
    Ok(Execution { deadline, commands })
}

fn command(op: u8, data: &[u8]) -> Result<Command> {
    // Exact op matching rejects ALLOW_REVERT/reserved bits, nested subplans,
    // position operations, cross-chain calls, native currency and arbitrary calls.
    match op {
        0x00 | 0x08 => {
            let mut abi = Abi::new(data, 6)?;
            let recipient = abi.address(0)?;
            let amount_in_raw = abi.decimal(1, 256)?;
            let minimum_out_raw = abi.decimal(2, 256)?;
            let payer_is_user = abi.boolean(4)?;
            let result = if op == 0x08 {
                let path: Vec<String> = abi.dynamic(3, |data| {
                    let n = Abi::new(data, 1)?.size(0)?;
                    if !(2..=MAX_HOPS + 1).contains(&n) {
                        return Err(DecodeError);
                    }
                    let a = Abi::new(&data[32..], n)?;
                    Ok((
                        (0..n).map(|i| a.address(i)).collect::<Result<_>>()?,
                        32 + a.end,
                    ))
                })?;
                let min_hop_prices = abi.uints(5, MAX_HOPS)?;
                hop_prices(&min_hop_prices, path.len() - 1)?;
                Command::V2ExactIn {
                    recipient,
                    amount_in_raw,
                    minimum_out_raw,
                    path,
                    payer_is_user,
                    min_hop_prices,
                }
            } else {
                let packed = abi.bytes(3)?;
                if packed.len() < 43
                    || (packed.len() - 20) % 23 != 0
                    || (packed.len() - 20) / 23 > MAX_HOPS
                {
                    return Err(DecodeError);
                }
                let mut path = Vec::new();
                for start in (0..packed.len() - 20).step_by(23) {
                    let f = U256::from_be_slice(&packed[start + 20..start + 23]);
                    path.push(V3Hop {
                        token_in: format!("{:#x}", Address::from_slice(&packed[start..start + 20])),
                        token_out: format!(
                            "{:#x}",
                            Address::from_slice(&packed[start + 23..start + 43])
                        ),
                        fee: fee(f)?,
                    });
                }
                let min_hop_prices = abi.uints(5, MAX_HOPS)?;
                hop_prices(&min_hop_prices, path.len())?;
                Command::V3ExactIn {
                    recipient,
                    amount_in_raw,
                    minimum_out_raw,
                    path,
                    payer_is_user,
                    min_hop_prices,
                }
            };
            abi.finish()?;
            Ok(result)
        }
        0x02 | 0x04..=0x07 => {
            let abi = Abi::new(data, 3)?;
            abi.finish()?;
            let token = abi.address(0)?;
            let recipient = abi.address(1)?;
            Ok(match op {
                0x02 => Command::TransferFrom {
                    token,
                    recipient,
                    amount_raw: abi.decimal(2, 160)?,
                },
                // Dispatcher declares amountMin uint160, so enforce that narrower width.
                0x04 => Command::Sweep {
                    token,
                    recipient,
                    minimum_raw: abi.decimal(2, 160)?,
                },
                0x05 => Command::Transfer {
                    token,
                    recipient,
                    amount_raw: abi.decimal(2, 256)?,
                },
                0x06 => Command::PayPortion {
                    token,
                    recipient,
                    bps: abi.decimal(2, 256)?,
                },
                _ => Command::PayPortionFullPrecision {
                    token,
                    recipient,
                    portion: abi.decimal(2, 256)?,
                },
            })
        }
        0x0a => {
            let mut abi = Abi::new(data, 7)?;
            let signature = abi.bytes(6)?;
            if ![64, 65].contains(&signature.len()) {
                return Err(DecodeError);
            }
            abi.finish()?;
            Ok(Command::PermitSingle {
                token: abi.address(0)?,
                amount_raw: abi.decimal(1, 160)?,
                expiration: abi.decimal(2, 48)?,
                nonce: abi.decimal(3, 48)?,
                spender: abi.address(4)?,
                sig_deadline: abi.decimal(5, 256)?,
                signature: Zeroizing::new(format!("0x{}", hex::encode(signature))),
            })
        }
        0x10 => {
            let (_, actions, inputs) = paired(data, 2)?;
            Ok(Command::V4 {
                actions: actions
                    .iter()
                    .zip(inputs)
                    .map(|(op, data)| v4_action(*op, data))
                    .collect::<Result<_>>()?,
            })
        }
        _ => Err(DecodeError),
    }
}

fn v4_action(op: u8, data: &[u8]) -> Result<V4Action> {
    match op {
        0x06 | 0x07 => {
            let mut outer = Abi::new(data, 1)?;
            let action = outer.dynamic(0, |data| {
                if op == 0x06 {
                    let mut abi = Abi::new(data, 10)?;
                    let hook_data = abi.bytes(9)?;
                    no_hooks(&abi, 4, hook_data)?;
                    let zero_for_one = abi.boolean(5)?;
                    let currency0 = abi.address(0)?;
                    let currency1 = abi.address(1)?;
                    if currency0 >= currency1 {
                        return Err(DecodeError);
                    }
                    let (token_in, token_out) = if zero_for_one {
                        (currency0, currency1)
                    } else {
                        (currency1, currency0)
                    };
                    Ok((
                        V4Action::ExactIn {
                            token_in,
                            path: vec![V4Hop {
                                token_out,
                                fee: fee(abi.uint(2, 24)?)?,
                                tick_spacing: spacing(&abi, 3)?,
                            }],
                            amount_in_raw: abi.decimal(6, 128)?,
                            minimum_out_raw: abi.decimal(7, 128)?,
                            min_hop_prices: vec![abi.decimal(8, 256)?],
                        },
                        abi.end,
                    ))
                } else {
                    let mut abi = Abi::new(data, 5)?;
                    let path = abi.dynamic(1, |data| {
                        let n = Abi::new(data, 1)?.size(0)?;
                        if n == 0 || n > MAX_HOPS {
                            return Err(DecodeError);
                        }
                        let mut array = Abi::new(&data[32..], n)?;
                        let mut path = Vec::new();
                        for i in 0..n {
                            path.push(array.dynamic(i, |data| {
                                let mut hop = Abi::new(data, 5)?;
                                let hook_data = hop.bytes(4)?;
                                no_hooks(&hop, 3, hook_data)?;
                                Ok((
                                    V4Hop {
                                        token_out: hop.address(0)?,
                                        fee: fee(hop.uint(1, 24)?)?,
                                        tick_spacing: spacing(&hop, 2)?,
                                    },
                                    hop.end,
                                ))
                            })?);
                        }
                        Ok((path, 32 + array.end))
                    })?;
                    let min_hop_prices = abi.uints(2, MAX_HOPS)?;
                    hop_prices(&min_hop_prices, path.len())?;
                    Ok((
                        V4Action::ExactIn {
                            token_in: abi.address(0)?,
                            path,
                            amount_in_raw: abi.decimal(3, 128)?,
                            minimum_out_raw: abi.decimal(4, 128)?,
                            min_hop_prices,
                        },
                        abi.end,
                    ))
                }
            })?;
            outer.finish()?;
            Ok(action)
        }
        0x0b..=0x10 if op != 0x0d => {
            let abi = Abi::new(data, if op == 0x0c || op == 0x0f { 2 } else { 3 })?;
            abi.finish()?;
            let token = abi.address(0)?;
            Ok(match op {
                0x0b => V4Action::Settle {
                    token,
                    amount_raw: abi.decimal(1, 256)?,
                    payer_is_user: abi.boolean(2)?,
                },
                0x0c => V4Action::SettleAll {
                    token,
                    maximum_raw: abi.decimal(1, 256)?,
                },
                0x0e => V4Action::Take {
                    token,
                    recipient: abi.address(1)?,
                    amount_raw: abi.decimal(2, 256)?,
                },
                0x0f => V4Action::TakeAll {
                    token,
                    minimum_raw: abi.decimal(1, 256)?,
                },
                _ => V4Action::TakePortion {
                    token,
                    recipient: abi.address(1)?,
                    bps: abi.decimal(2, 256)?,
                },
            })
        }
        _ => Err(DecodeError),
    }
}

#[cfg(test)]
fn serialize_signature<S: serde::Serializer>(
    value: &Zeroizing<String>,
    s: S,
) -> std::result::Result<S::Ok, S::Error> {
    s.serialize_str(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_permit_requires_exact_persisted_terms_and_one_leading_signature() {
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/api-client/src/fixtures/permit2.json"
        ))
        .unwrap();
        let terms: super::super::permit2::PermitTerms =
            serde_json::from_value(f["terms"].clone()).unwrap();
        let now = f["now"].as_u64().unwrap();
        let data = f["calldata"].as_str().unwrap();
        let execution = decode(data).unwrap();
        assert_eq!(
            execution.verify_embedded_permit(Some(&terms), now).unwrap(),
            Some(terms.digest(now).unwrap())
        );
        assert!(execution.verify_embedded_permit(None, now).is_err());
        let mut missing = decode(data).unwrap();
        missing.commands.remove(0);
        assert!(missing.verify_embedded_permit(Some(&terms), now).is_err());
        assert_eq!(missing.verify_embedded_permit(None, now).unwrap(), None);
        let mut reordered = decode(data).unwrap();
        reordered.commands.swap(0, 1);
        assert!(reordered.verify_embedded_permit(Some(&terms), now).is_err());
        let mut duplicate = decode(data).unwrap();
        duplicate
            .commands
            .insert(0, decode(data).unwrap().commands.remove(0));
        assert!(duplicate.verify_embedded_permit(Some(&terms), now).is_err());
        let mut changed = terms.clone();
        changed.nonce = "8".into();
        assert!(
            execution
                .verify_embedded_permit(Some(&changed), now)
                .is_err()
        );
        let mut late = decode(data).unwrap();
        late.deadline = (now + 601).to_string();
        assert!(late.verify_embedded_permit(Some(&terms), now).is_err());
        assert!(
            execution
                .verify_embedded_permit(Some(&terms), now + 600)
                .is_err()
        );
    }
    #[test]
    fn independent_abi_encoder_fixtures_match_wallet_decoder_contract() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/api-client/src/fixtures/uniswap-router.json"
        ))
        .unwrap();
        assert_eq!(fixtures["sourceCommit"], SOURCE_COMMIT);
        for fixture in fixtures["valid"].as_array().unwrap() {
            let data = fixture["data"].as_str().unwrap();
            assert_eq!(
                serde_json::to_value(decode(data).unwrap()).unwrap(),
                fixture["expected"],
                "{}",
                fixture["name"]
            );
            for end in (10..data.len()).step_by(64) {
                assert!(decode(&data[..end]).is_err(), "{}:{end}", fixture["name"]);
            }
        }
        for fixture in fixtures["invalid"].as_array().unwrap() {
            assert!(
                decode(fixture["data"].as_str().unwrap()).is_err(),
                "{}",
                fixture["name"]
            );
        }
        for data in [
            "".to_string(),
            "0x".into(),
            "0xzz".into(),
            format!("0x3593564c{}", "00".repeat(MAX_BYTES)),
        ] {
            assert!(decode(&data).is_err());
        }
    }
}
