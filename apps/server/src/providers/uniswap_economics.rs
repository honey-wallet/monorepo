//! Conditional-on-success economic proof for pinned CLASSIC ERC20 router calls.
//! Does not attest code/nonce/signatures, simulate, persist, sign or broadcast.
use super::uniswap_router::{self, Command, V4Action};
use alloy_primitives::{Address, U256};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeeAuthority {
    pub recipient: String,
    pub maximum_bps: String,
    /// Explicit user-reviewed base-unit allowance, 0 or 1; never inferred from a quote.
    pub maximum_rounding_raw: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwapAuthority {
    pub chain_id: String,
    pub owner: String,
    pub router: String,
    pub token_in: String,
    pub token_out: String,
    pub maximum_input_raw: String,
    pub minimum_output_raw: String,
    pub deadline: String,
    pub fee_basis: String,
    pub tokens: Vec<String>,
    pub fees: Vec<FeeAuthority>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouterCall {
    pub chain_id: String,
    pub from: String,
    pub to: String,
    pub value_raw: String,
    #[serde(deserialize_with = "call_data")]
    pub data: zeroize::Zeroizing<String>,
}
fn call_data<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<zeroize::Zeroizing<String>, D::Error> {
    String::deserialize(d).map(zeroize::Zeroizing::new)
}
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EconomicProof {
    pub maximum_debit_raw: String,
    pub guaranteed_output_raw: String,
    pub refund_tokens: Vec<String>,
    pub fee_recipients: Vec<String>,
}
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum EconomicError {
    #[error("invalid swap authority or transaction identity")]
    Policy,
    #[error("unsupported router encoding")]
    Encoding,
    #[error("swap deadline differs or expired")]
    Deadline,
    #[error("swap recipient is not authorized")]
    Recipient,
    #[error("swap exceeds or differs from approved input allocation")]
    Spend,
    #[error("unproven swap token flow")]
    Flow,
    #[error("swap fees exceed reviewed authority")]
    Fees,
    #[error("swap minimum receive is not enforced")]
    Minimum,
    #[error("router can retain swap assets")]
    Refund,
}
type Result<T> = std::result::Result<T, EconomicError>;
use EconomicError as E;
fn n(s: &str) -> Result<U256> {
    if s.is_empty()
        || s.len() > 78
        || s.len() > 1 && s.starts_with('0')
        || !s.bytes().all(|v| v.is_ascii_digit())
    {
        return Err(E::Policy);
    }
    U256::from_str_radix(s, 10).map_err(|_| E::Policy)
}
fn add(a: U256, b: U256) -> Result<U256> {
    a.checked_add(b).ok_or(E::Flow)
}
fn mul(a: U256, b: U256) -> Result<U256> {
    a.checked_mul(b).ok_or(E::Fees)
}
fn sub(a: U256, b: U256) -> U256 {
    a.saturating_sub(b)
}
fn fraction(a: U256, numerator: U256, denominator: U256) -> Result<U256> {
    if denominator == U256::ZERO || numerator > denominator {
        return Err(E::Fees);
    }
    // Division first avoids overflowing a * rate for full-width token amounts.
    add(
        mul(a / denominator, numerator)?,
        mul(a % denominator, numerator)? / denominator,
    )
}
fn full() -> U256 {
    U256::from(1).wrapping_shl(255)
}
fn address(s: &str) -> Result<()> {
    let a: Address = s.parse().map_err(|_| E::Policy)?;
    if s != format!("{a:#x}") || U256::from_be_slice(a.as_slice()) <= U256::from(2) {
        return Err(E::Policy);
    }
    Ok(())
}
#[derive(Clone, Copy)]
struct Balance {
    low: U256,
    high: Option<U256>,
}
impl Balance {
    fn exact(v: U256) -> Self {
        Self {
            low: v,
            high: Some(v),
        }
    }
    fn unknown(low: U256) -> Self {
        Self { low, high: None }
    }
    fn possible(self) -> bool {
        self.high != Some(U256::ZERO)
    }
}
#[derive(Default)]
struct Delta {
    debt: U256,
    credit: U256,
    owned: bool,
}
impl Delta {
    fn add(&mut self, amount: U256) -> Result<()> {
        let cancel = amount.min(self.debt);
        self.debt -= cancel;
        self.credit = add(self.credit, amount - cancel)?;
        self.owned = true;
        Ok(())
    }
    fn spend(&mut self, amount: U256) -> Result<()> {
        let cancel = amount.min(self.credit);
        self.credit -= cancel;
        self.debt = add(self.debt, amount - cancel)?;
        Ok(())
    }
    fn clear(&mut self) {
        *self = Self::default();
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Location {
    Router,
    Pool(usize),
}
struct Proof<'a> {
    policy: &'a SwapAuthority,
    debit: U256,
    output: U256,
    balances: BTreeMap<String, Balance>,
    refunds: BTreeSet<String>,
    paid: BTreeSet<String>,
    fee_source: Option<Location>,
    // Remaining settlement balance R <= (ratio * initial gross) + error.
    // Four fee recipients bound denominator growth to at most 10^72.
    ratio: U256,
    error: U256,
    denominator: U256,
    swaps: usize,
}
impl<'a> Proof<'a> {
    fn token(&self, token: &str) -> Result<()> {
        if !self.policy.tokens.iter().any(|v| v == token) {
            return Err(E::Flow);
        }
        Ok(())
    }
    fn recipient<'b>(&'b self, recipient: &'b str) -> &'b str {
        match recipient {
            "0x0000000000000000000000000000000000000001" => &self.policy.owner,
            "0x0000000000000000000000000000000000000002" => &self.policy.router,
            other => other,
        }
    }
    fn user_debit(&mut self, token: &str, amount: U256) -> Result<()> {
        if token != self.policy.token_in
            || amount >= U256::from(1).wrapping_shl(160) - U256::from(1)
        {
            return Err(E::Spend);
        }
        self.debit = add(self.debit, amount)?;
        if self.debit > n(&self.policy.maximum_input_raw)? {
            return Err(E::Spend);
        }
        Ok(())
    }
    fn incoming(&mut self, token: &str, value: Balance) -> Result<()> {
        self.token(token)?;
        if token == self.policy.token_out && self.fee_source == Some(Location::Router) {
            return Err(E::Fees);
        }
        let old = self
            .balances
            .entry(token.into())
            .or_insert(Balance::exact(U256::ZERO));
        old.low = add(old.low, value.low)?;
        old.high = match (old.high, value.high) {
            (Some(a), Some(b)) => Some(add(a, b)?),
            _ => None,
        };
        Ok(())
    }
    fn consume(&mut self, token: &str, amount: U256, partial: bool) -> Result<Balance> {
        self.token(token)?;
        let value = self.balances.get_mut(token).ok_or(E::Flow)?;
        if !value.possible() {
            return Err(E::Flow);
        }
        if amount == full() {
            let taken = *value;
            *value = if partial {
                Balance {
                    low: U256::ZERO,
                    high: taken.high,
                }
            } else {
                Balance::exact(U256::ZERO)
            };
            return Ok(taken);
        }
        if value.high.is_some_and(|v| amount > v) {
            return Err(E::Flow);
        }
        value.low = sub(value.low, amount);
        if !partial {
            value.high = value.high.map(|v| v - amount);
        }
        Ok(Balance::exact(amount))
    }
    fn receive(&mut self, token: &str, value: Balance, recipient: &str) -> Result<()> {
        self.token(token)?;
        let recipient = self.recipient(recipient).to_owned();
        if recipient == self.policy.router {
            return self.incoming(token, value);
        }
        if recipient != self.policy.owner {
            return Err(E::Recipient);
        }
        if token == self.policy.token_out {
            self.output = add(self.output, value.low)?;
        } else {
            self.refunds.insert(token.into());
        }
        Ok(())
    }
    fn swap(
        &mut self,
        path: &[String],
        amount: U256,
        minimum: U256,
        payer: bool,
        recipient: &str,
        v3: bool,
    ) -> Result<()> {
        if self.fee_source.is_some()
            || path.len() < 2
            || path.len() > 9
            || path.first() == path.last()
        {
            return Err(E::Flow);
        }
        for token in path {
            self.token(token)?;
        }
        if path.windows(2).any(|w| w[0] == w[1]) || amount == U256::ZERO {
            return Err(E::Flow);
        }
        self.swaps += 1;
        if self.swaps > 64 {
            return Err(E::Flow);
        }
        if payer {
            self.user_debit(&path[0], amount)?;
        } else {
            self.consume(&path[0], amount, v3)?;
        }
        // A V3 hop may stop at a price boundary before consuming all its input.
        // Those intermediate router balances need explicit owner cleanup.
        if v3 {
            for token in &path[1..path.len() - 1] {
                self.incoming(token, Balance::unknown(U256::ZERO))?;
            }
        }
        self.receive(
            path.last().ok_or(E::Flow)?,
            Balance::unknown(minimum),
            recipient,
        )
    }
    fn charge(
        &mut self,
        location: Location,
        token: &str,
        recipient: &str,
        low: U256,
        rate: Option<(U256, U256)>,
        fixed: U256,
    ) -> Result<()> {
        if token != self.policy.token_out
            || self.fee_source.is_some_and(|v| v != location)
            || self.paid.contains(recipient)
        {
            return Err(E::Fees);
        }
        let fee = self
            .policy
            .fees
            .iter()
            .find(|v| v.recipient == recipient)
            .ok_or(E::Recipient)?;
        let bps = n(&fee.maximum_bps)?;
        let rounding = n(&fee.maximum_rounding_raw)?;
        match rate {
            None => {
                if fixed > add(fraction(low, bps, U256::from(10000))?, rounding)? {
                    return Err(E::Fees);
                }
                // Ignoring a fixed deduction overestimates later remaining balance.
            }
            Some((num, den)) => {
                if num == U256::ZERO || num > den {
                    return Err(E::Fees);
                }
                let next_den = mul(self.denominator, den)?;
                let fee_ratio = mul(self.ratio, num)?;
                let error = mul(self.error, num)?;
                if mul(fee_ratio, U256::from(10000))? > mul(bps, next_den)? {
                    return Err(E::Fees);
                }
                // When raw rate <= approved gross rate, R <= initial gross proves
                // the bound directly, without any rounding allowance.
                if mul(num, U256::from(10000))? > mul(bps, den)? {
                    let ceiling = error / next_den + U256::from(error % next_den != U256::ZERO);
                    if ceiling > rounding {
                        return Err(E::Fees);
                    }
                }
                self.ratio = mul(self.ratio, den - num)?;
                self.error = add(mul(self.error, den - num)?, next_den)?;
                self.denominator = next_den;
            }
        }
        self.fee_source = Some(location);
        self.paid.insert(recipient.into());
        Ok(())
    }
    fn router_payment(
        &mut self,
        token: &str,
        recipient: &str,
        amount: U256,
        rate: Option<(U256, U256)>,
        sweep: bool,
    ) -> Result<()> {
        self.token(token)?;
        let recipient = self.recipient(recipient).to_owned();
        if recipient == self.policy.router {
            return Err(E::Recipient);
        }
        let balance = self
            .balances
            .get(token)
            .copied()
            .unwrap_or(Balance::exact(U256::ZERO));
        if recipient != self.policy.owner {
            if !balance.possible() || sweep || amount == full() {
                return Err(E::Fees);
            }
            self.charge(
                Location::Router,
                token,
                &recipient,
                balance.low,
                rate,
                amount,
            )?;
        }
        if let Some((num, den)) = rate {
            let paid = fraction(balance.low, num, den)?;
            let remaining = if num == den {
                Balance::exact(U256::ZERO)
            } else {
                Balance {
                    low: balance.low - paid,
                    high: balance
                        .high
                        .map(|v| fraction(v, num, den).map(|paid| v - paid))
                        .transpose()?,
                }
            };
            self.balances.insert(token.into(), remaining);
            if recipient == self.policy.owner {
                self.receive(token, Balance::unknown(paid), &recipient)?;
            }
        } else if sweep || amount == full() {
            if !balance.possible() && amount != U256::ZERO && amount != full() {
                return Err(E::Flow);
            }
            self.balances
                .insert(token.into(), Balance::exact(U256::ZERO));
            let low = if sweep {
                balance.low.max(amount)
            } else {
                balance.low
            };
            self.receive(token, Balance::unknown(low), &recipient)?;
        } else {
            self.consume(token, amount, false)?;
            if recipient == self.policy.owner {
                self.receive(token, Balance::exact(amount), &recipient)?;
            }
        }
        Ok(())
    }
    fn v4(&mut self, actions: &[V4Action], index: usize) -> Result<()> {
        let location = Location::Pool(index);
        let mut deltas = BTreeMap::<String, Delta>::new();
        for action in actions {
            match action {
                V4Action::ExactIn {
                    token_in,
                    path,
                    amount_in_raw,
                    minimum_out_raw,
                    ..
                } => {
                    if self.fee_source.is_some() || path.is_empty() {
                        return Err(E::Flow);
                    }
                    self.token(token_in)?;
                    let mut previous = token_in;
                    for hop in path {
                        self.token(&hop.token_out)?;
                        if previous == &hop.token_out {
                            return Err(E::Flow);
                        }
                        previous = &hop.token_out;
                    }
                    if previous == token_in {
                        return Err(E::Flow);
                    }
                    self.swaps += 1;
                    if self.swaps > 64 {
                        return Err(E::Flow);
                    }
                    let amount = n(amount_in_raw)?;
                    let input = deltas.entry(token_in.clone()).or_default();
                    if amount == U256::ZERO {
                        if !input.owned || input.debt != U256::ZERO {
                            return Err(E::Flow);
                        }
                        input.credit = U256::ZERO; // partial fill can leave positive credit; unlock enforces zero.
                    } else {
                        input.spend(amount)?;
                    }
                    deltas
                        .entry(previous.clone())
                        .or_default()
                        .add(n(minimum_out_raw)?)?;
                    for hop in &path[..path.len() - 1] {
                        deltas.entry(hop.token_out.clone()).or_default().owned = true;
                    }
                }
                V4Action::Settle {
                    token,
                    amount_raw,
                    payer_is_user,
                } => {
                    self.token(token)?;
                    let amount = n(amount_raw)?;
                    let delta = deltas.entry(token.clone()).or_default();
                    if amount == U256::ZERO {
                        if delta.credit != U256::ZERO {
                            return Err(E::Flow);
                        }
                        let debt = delta.debt;
                        if *payer_is_user {
                            self.user_debit(token, debt)?;
                        } else if debt != U256::ZERO {
                            self.consume(token, debt, true)?;
                        }
                        delta.clear();
                    } else {
                        if token == &self.policy.token_out && self.fee_source == Some(location) {
                            return Err(E::Fees);
                        }
                        let credit = if *payer_is_user {
                            self.user_debit(token, amount)?;
                            amount
                        } else {
                            self.consume(token, amount, false)?.low
                        };
                        delta.add(credit)?;
                    }
                }
                V4Action::SettleAll { token, maximum_raw } => {
                    self.token(token)?;
                    let delta = deltas.entry(token.clone()).or_default();
                    if delta.credit != U256::ZERO {
                        return Err(E::Flow);
                    }
                    self.user_debit(token, delta.debt.min(n(maximum_raw)?))?;
                    delta.clear();
                }
                V4Action::Take {
                    token,
                    recipient,
                    amount_raw,
                } => {
                    self.token(token)?;
                    let delta = deltas.entry(token.clone()).or_default();
                    if !delta.owned || delta.debt != U256::ZERO {
                        return Err(E::Flow);
                    }
                    let recipient = self.recipient(recipient).to_owned();
                    let amount = n(amount_raw)?;
                    if amount == U256::ZERO {
                        if recipient != self.policy.owner && recipient != self.policy.router {
                            return Err(E::Recipient);
                        }
                        let low = delta.credit;
                        delta.clear();
                        self.receive(token, Balance::unknown(low), &recipient)?;
                    } else {
                        if amount > delta.credit {
                            return Err(E::Flow);
                        }
                        if recipient != self.policy.owner && recipient != self.policy.router {
                            self.charge(location, token, &recipient, delta.credit, None, amount)?;
                        }
                        delta.spend(amount)?;
                        if recipient == self.policy.owner || recipient == self.policy.router {
                            self.receive(token, Balance::exact(amount), &recipient)?;
                        }
                    }
                }
                V4Action::TakeAll { token, minimum_raw } => {
                    self.token(token)?;
                    let delta = deltas.entry(token.clone()).or_default();
                    if !delta.owned || delta.debt != U256::ZERO {
                        return Err(E::Flow);
                    }
                    let low = delta.credit.max(n(minimum_raw)?);
                    delta.clear();
                    self.receive(token, Balance::unknown(low), &self.policy.owner.clone())?;
                }
                V4Action::TakePortion {
                    token,
                    recipient,
                    bps,
                } => {
                    self.token(token)?;
                    let delta = deltas.entry(token.clone()).or_default();
                    if !delta.owned || delta.debt != U256::ZERO {
                        return Err(E::Flow);
                    }
                    let recipient = self.recipient(recipient).to_owned();
                    let rate = n(bps)?;
                    let paid = fraction(delta.credit, rate, U256::from(10000))?;
                    if recipient != self.policy.owner && recipient != self.policy.router {
                        self.charge(
                            location,
                            token,
                            &recipient,
                            delta.credit,
                            Some((rate, U256::from(10000))),
                            U256::ZERO,
                        )?;
                    }
                    delta.credit -= paid;
                    if recipient == self.policy.owner || recipient == self.policy.router {
                        self.receive(token, Balance::unknown(paid), &recipient)?;
                    }
                }
            }
        }
        // On successful unlock, PoolManager enforces all actual currency deltas zero.
        // A nonzero lower bound already proves this sequence cannot settle as modeled.
        if deltas
            .values()
            .any(|d| d.credit != U256::ZERO || d.debt != U256::ZERO)
        {
            return Err(E::Flow);
        }
        Ok(())
    }
}

/// Validate public authority before calldata or a permit signature exists.
pub fn validate_authority(policy: &SwapAuthority, now: u64) -> Result<()> {
    for a in [
        &policy.owner,
        &policy.router,
        &policy.token_in,
        &policy.token_out,
    ] {
        address(a)?;
    }
    let chain = n(&policy.chain_id)?;
    if policy.fee_basis != "settlement_balance"
        || chain == U256::ZERO
        || chain > U256::from(9_007_199_254_740_991u64)
        || policy.owner == policy.router
        || policy.token_in == policy.token_out
        || !(2..=64).contains(&policy.tokens.len())
        || policy.fees.len() > 4
    {
        return Err(E::Policy);
    }
    let mut tokens = BTreeSet::new();
    for token in &policy.tokens {
        address(token)?;
        if !tokens.insert(token) {
            return Err(E::Policy);
        }
    }
    if !tokens.contains(&policy.token_in) || !tokens.contains(&policy.token_out) {
        return Err(E::Policy);
    }
    let maximum = n(&policy.maximum_input_raw)?;
    if maximum == U256::ZERO
        || maximum >= U256::from(1).wrapping_shl(160) - U256::from(1)
        || n(&policy.minimum_output_raw)? == U256::ZERO
    {
        return Err(E::Policy);
    }
    let mut fees = BTreeSet::new();
    let mut total = U256::ZERO;
    for fee in &policy.fees {
        address(&fee.recipient)?;
        let bps = n(&fee.maximum_bps)?;
        if fee.recipient == policy.owner
            || fee.recipient == policy.router
            || !fees.insert(&fee.recipient)
            || bps == U256::ZERO
            || bps > U256::from(500)
            || n(&fee.maximum_rounding_raw)? > U256::from(1)
        {
            return Err(E::Policy);
        }
        total = add(total, bps)?;
    }
    if total > U256::from(500) {
        return Err(E::Policy);
    }
    let deadline = n(&policy.deadline)?;
    if now == 0
        || now > u64::MAX - 1800
        || deadline <= U256::from(now)
        || deadline > U256::from(now + 1800)
    {
        return Err(E::Deadline);
    }
    Ok(())
}

pub fn validate_economics(
    policy: &SwapAuthority,
    call: &RouterCall,
    now: u64,
) -> Result<EconomicProof> {
    validate_authority(policy, now)?;
    if call.from != policy.owner
        || call.to != policy.router
        || call.chain_id != policy.chain_id
        || call.value_raw != "0"
    {
        return Err(E::Policy);
    }
    let execution = uniswap_router::decode(&call.data).map_err(|_| E::Encoding)?;
    if execution.deadline != policy.deadline {
        return Err(E::Deadline);
    }
    let deadline = n(&policy.deadline)?;
    let maximum = n(&policy.maximum_input_raw)?;
    let mut proof = Proof {
        policy,
        debit: U256::ZERO,
        output: U256::ZERO,
        balances: BTreeMap::new(),
        refunds: BTreeSet::new(),
        paid: BTreeSet::new(),
        fee_source: None,
        ratio: U256::from(1),
        error: U256::ZERO,
        denominator: U256::from(1),
        swaps: 0,
    };
    for (index, command) in execution.commands.iter().enumerate() {
        match command {
            Command::PermitSingle {
                token,
                amount_raw,
                spender,
                expiration,
                sig_deadline,
                ..
            } => {
                if index != 0
                    || token != &policy.token_in
                    || n(amount_raw)? != maximum
                    || spender != &policy.router
                    || n(expiration)? < deadline
                    || n(sig_deadline)? < deadline
                {
                    return Err(E::Policy);
                }
            }
            Command::TransferFrom {
                token,
                recipient,
                amount_raw,
            } => {
                if proof.recipient(recipient) != policy.router {
                    return Err(E::Recipient);
                }
                let amount = n(amount_raw)?;
                proof.user_debit(token, amount)?;
                proof.incoming(token, Balance::exact(amount))?;
            }
            Command::V2ExactIn {
                recipient,
                amount_in_raw,
                minimum_out_raw,
                path,
                payer_is_user,
                ..
            } => proof.swap(
                path,
                n(amount_in_raw)?,
                n(minimum_out_raw)?,
                *payer_is_user,
                recipient,
                false,
            )?,
            Command::V3ExactIn {
                recipient,
                amount_in_raw,
                minimum_out_raw,
                path,
                payer_is_user,
                ..
            } => {
                let mut tokens = vec![path.first().ok_or(E::Flow)?.token_in.clone()];
                for hop in path {
                    if tokens.last() != Some(&hop.token_in) {
                        return Err(E::Flow);
                    }
                    tokens.push(hop.token_out.clone());
                }
                proof.swap(
                    &tokens,
                    n(amount_in_raw)?,
                    n(minimum_out_raw)?,
                    *payer_is_user,
                    recipient,
                    true,
                )?;
            }
            Command::V4 { actions } => proof.v4(actions, index)?,
            Command::Sweep {
                token,
                recipient,
                minimum_raw,
            } => proof.router_payment(token, recipient, n(minimum_raw)?, None, true)?,
            Command::Transfer {
                token,
                recipient,
                amount_raw,
            } => proof.router_payment(token, recipient, n(amount_raw)?, None, false)?,
            Command::PayPortion {
                token,
                recipient,
                bps,
            } => proof.router_payment(
                token,
                recipient,
                U256::ZERO,
                Some((n(bps)?, U256::from(10000))),
                false,
            )?,
            Command::PayPortionFullPrecision {
                token,
                recipient,
                portion,
            } => proof.router_payment(
                token,
                recipient,
                U256::ZERO,
                Some((n(portion)?, U256::from(1_000_000_000_000_000_000u64))),
                false,
            )?,
        }
    }
    if proof.swaps == 0 || proof.debit != maximum {
        return Err(E::Spend);
    }
    if proof.output < n(&policy.minimum_output_raw)? {
        return Err(E::Minimum);
    }
    if proof.paid.len() != policy.fees.len() {
        return Err(E::Fees);
    }
    if proof.balances.values().any(|v| v.possible()) {
        return Err(E::Refund);
    }
    Ok(EconomicProof {
        maximum_debit_raw: proof.debit.to_string(),
        guaranteed_output_raw: proof.output.to_string(),
        refund_tokens: proof.refunds.into_iter().collect(),
        fee_recipients: proof.paid.into_iter().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepted_fee_schedule_is_bounded_for_concrete_integer_balances() {
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/api-client/src/fixtures/uniswap-economics.json"
        ))
        .unwrap();
        let stress = &f["feeStress"];
        let values = |field: &str| {
            stress[field]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().parse::<u128>().unwrap())
                .collect::<Vec<_>>()
        };
        let rates = values("rates");
        let bps = values("grossBps");
        let rounding = values("rounding");
        let minimum = stress["netMinimum"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap();
        for gross in 0u128..=150_000 {
            let mut balance = gross;
            for i in 0..rates.len() {
                let paid = balance * rates[i] / 1_000_000_000_000_000_000;
                assert!(
                    paid <= gross * bps[i] / 10000 + rounding[i],
                    "gross {gross}, leg {i}"
                );
                balance -= paid;
            }
            if gross >= 100_000 {
                assert!(balance >= minimum);
            }
        }
    }
    #[test]
    fn mixed_protocol_economic_proofs_match_independent_fixture_expectations() {
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/api-client/src/fixtures/uniswap-economics.json"
        ))
        .unwrap();
        let now = f["now"].as_u64().unwrap();
        for case in f["valid"].as_array().unwrap() {
            let p: SwapAuthority = serde_json::from_value(case["policy"].clone()).unwrap();
            let call: RouterCall = serde_json::from_value(case["call"].clone()).unwrap();
            let result = validate_economics(&p, &call, now)
                .unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                case["expected"],
                "{}",
                case["name"]
            );
            assert!(validate_economics(&p, &call, now + 300).is_err());
        }
        for case in f["invalid"].as_array().unwrap() {
            let p: SwapAuthority = serde_json::from_value(case["policy"].clone()).unwrap();
            let call: RouterCall = serde_json::from_value(case["call"].clone()).unwrap();
            assert!(
                validate_economics(&p, &call, now).is_err(),
                "{}",
                case["name"]
            );
        }
    }
}
