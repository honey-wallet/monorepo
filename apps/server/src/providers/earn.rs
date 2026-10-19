//! Indexed Earn observations, not executable quotes or user withdrawal limits.
use super::transport::{ReadError, ReadTransport};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use std::time::{SystemTime, UNIX_EPOCH};

const UINT256_MAX: &str =
    "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const AAVE_QUERY: &str = "query HoneyReserve($request: ReserveRequest!) { reserve(request: $request) { market { address chain { chainId } name } underlyingToken { address chainId decimals symbol } aToken { address chainId decimals symbol } isFrozen isPaused supplyInfo { apy { raw decimals } supplyCap { amount { raw decimals } } supplyCapReached total { raw decimals } } borrowInfo { availableLiquidity { amount { raw decimals } } } } }";

#[derive(Clone, Debug)]
pub struct EarnTarget {
    protocol: EarnProtocol,
    chain: u64,
    contract: String,
    asset: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EarnProtocol {
    AaveV3,
    MorphoVaultV2,
}
impl EarnTarget {
    /// An explicit read target is not an approved product or execution allowlist.
    pub fn new(
        protocol: EarnProtocol,
        chain: u64,
        contract: &str,
        asset: &str,
    ) -> Result<Self, ReadError> {
        if chain == 0 || chain > 9_007_199_254_740_991 || !address(contract) || !address(asset) {
            return Err(ReadError::InvalidTarget);
        }
        Ok(Self {
            protocol,
            chain,
            contract: contract.to_ascii_lowercase(),
            asset: asset.to_ascii_lowercase(),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EarnObservation {
    pub schema_version: u8,
    pub protocol: EarnProtocol,
    pub chain_id: String,
    pub contract_address: String,
    pub asset: EarnAsset,
    pub position_asset: EarnAsset,
    pub total_supplied_raw: String,
    pub available_liquidity_raw: Option<String>,
    pub supply_cap_raw: Option<String>,
    pub supply_apy: Option<YieldObservation>,
    pub restrictions: Restrictions,
    pub vault_fees: Option<Vec<VaultFee>>,
    pub source_blocks: Vec<SourceBlock>,
    /// Local completed-fetch time, NOT proof of indexer freshness or chain finality.
    pub fetched_at_ms: u64,
    /// Always false until registry, RPC validation, signer and reconciliation ship.
    pub execution_available: bool,
}
impl EarnObservation {
    pub fn valid_for(&self, target: &EarnTarget) -> bool {
        self.schema_version == 1
            && !self.execution_available
            && self.protocol == target.protocol
            && self.chain_id == target.chain.to_string()
            && self.contract_address == target.contract
            && self.asset.address == target.asset
            && valid_asset(&self.asset)
            && valid_asset(&self.position_asset)
            && self.fetched_at_ms > 0
            && self.fetched_at_ms <= 9_007_199_254_740_991
            && uint256(&self.total_supplied_raw)
            && [&self.available_liquidity_raw, &self.supply_cap_raw]
                .into_iter()
                .flatten()
                .all(|n| uint256(n))
            && self.supply_apy.as_ref().is_none_or(|a| {
                decimal_fraction(&a.fraction)
                    && !a.rewards_included
                    && matches!(
                        (self.protocol, a.basis),
                        (EarnProtocol::AaveV3, YieldBasis::CurrentSupply)
                            | (
                                EarnProtocol::MorphoVaultV2,
                                YieldBasis::TrailingOneDayAfterFees
                            )
                    )
            })
            && self.source_blocks.len() <= 3
            && self.source_blocks.iter().all(|b| uint256(&b.number))
            && self.vault_fees.as_ref().is_none_or(|fees| {
                fees.len() <= 2
                    && fees.iter().all(|f| {
                        f.rate_wad.as_ref().is_none_or(|v| {
                            uint256(v) && !cmp_uint(v, "1000000000000000000").is_gt()
                        })
                    })
            })
            && match self.protocol {
                EarnProtocol::AaveV3 => self.asset.decimals == self.position_asset.decimals,
                EarnProtocol::MorphoVaultV2 => self.position_asset.address == target.contract,
            }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EarnAsset {
    pub address: String,
    pub decimals: u8,
    pub symbol: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YieldObservation {
    /// Exact source decimal fraction, potentially scientific notation. 0.05 = 5%.
    pub fraction: String,
    pub basis: YieldBasis,
    pub rewards_included: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum YieldBasis {
    CurrentSupply,
    TrailingOneDayAfterFees,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Restrictions {
    pub paused: Option<bool>,
    pub frozen: Option<bool>,
    pub supply_cap_reached: Option<bool>,
    pub gated: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFee {
    pub kind: VaultFeeKind,
    pub rate_wad: Option<String>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultFeeKind {
    Performance,
    Management,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBlock {
    pub component: SourceComponent,
    pub number: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceComponent {
    Configuration,
    State,
    Apy,
}

#[derive(Clone)]
pub struct EarnReader {
    transport: ReadTransport,
}
impl EarnReader {
    pub fn new(transport: ReadTransport) -> Self {
        Self { transport }
    }
    #[tracing::instrument(name = "provider.earn_observation", skip_all)]
    pub async fn read(&self, target: &EarnTarget) -> Result<EarnObservation, ReadError> {
        match target.protocol {
            EarnProtocol::AaveV3 => {
                let bytes = self.transport.aave(&json!({"query":AAVE_QUERY,"variables":{"request":{
                    "chainId":target.chain,"market":target.contract,"underlyingToken":target.asset
                }}})).await?;
                parse_aave(target, &bytes)
            }
            EarnProtocol::MorphoVaultV2 => {
                let selector = format!("{}:{}", target.chain, target.contract);
                let config = self
                    .transport
                    .morpho(&format!("/v0/vaults-v2/{selector}"))
                    .await?;
                let state = self
                    .transport
                    .morpho(&format!("/v1/vaults-v2/{selector}/state"))
                    .await?;
                let apy = self
                    .transport
                    .morpho(&format!(
                        "/v1/vaults-v2/{selector}/apy-averages?lookback=one_day"
                    ))
                    .await?;
                parse_morpho(target, &config, &state, &apy)
            }
        }
    }
}
#[derive(Deserialize)]
struct Rest<T> {
    data: T,
}
#[derive(Deserialize)]
struct MorphoConfig {
    chain_id: u64,
    address: String,
    version: String,
    symbol: String,
    asset: EarnAsset,
    decimals_offset: u8,
    last_indexed_block: String,
    management_fee_wad: Option<String>,
    performance_fee_wad: Option<String>,
    gates: Gates,
}
#[derive(Deserialize)]
struct Gates {
    send_shares: Option<String>,
    receive_shares: Option<String>,
    send_assets: Option<String>,
    receive_assets: Option<String>,
}
#[derive(Deserialize)]
struct MorphoState {
    chain_id: u64,
    address: String,
    last_indexed_block: String,
    total_assets: String,
    total_supply: String,
    withdrawable_assets: String,
    share_price_ray: String,
}
#[derive(Deserialize)]
struct MorphoApy {
    chain_id: u64,
    vault_address: String,
    last_indexed_block: String,
    lookback: String,
    apy: Box<RawValue>,
}

fn parse_morpho(
    target: &EarnTarget,
    config: &[u8],
    state: &[u8],
    apy: &[u8],
) -> Result<EarnObservation, ReadError> {
    let c: MorphoConfig = decode::<Rest<_>>(config)?.data;
    let s: MorphoState = decode::<Rest<_>>(state)?.data;
    let a: MorphoApy = decode::<Rest<_>>(apy)?.data;
    let shares_decimals = c
        .asset
        .decimals
        .checked_add(c.decimals_offset)
        .ok_or(ReadError::InvalidResponse)?;
    let gates = [
        c.gates.send_shares,
        c.gates.receive_shares,
        c.gates.send_assets,
        c.gates.receive_assets,
    ];
    let fraction = (a.apy.get() != "null").then(|| a.apy.get().to_owned());
    if target.protocol != EarnProtocol::MorphoVaultV2
        || c.version != "2.0"
        || !same_target(target, c.chain_id, &c.address)
        || !same_target(target, s.chain_id, &s.address)
        || !same_target(target, a.chain_id, &a.vault_address)
        || !c.asset.address.eq_ignore_ascii_case(&target.asset)
        || !valid_asset(&c.asset)
        || !symbol(&c.symbol)
        || a.lookback != "one_day"
        || fraction.as_ref().is_some_and(|v| !decimal_fraction(v))
        || [
            &c.last_indexed_block,
            &s.last_indexed_block,
            &a.last_indexed_block,
            &s.total_assets,
            &s.total_supply,
            &s.withdrawable_assets,
            &s.share_price_ray,
        ]
        .into_iter()
        .any(|n| !uint256(n))
        || [&c.performance_fee_wad, &c.management_fee_wad]
            .into_iter()
            .flatten()
            .any(|v| !uint256(v) || cmp_uint(v, "1000000000000000000").is_gt())
        || gates.iter().flatten().any(|gate| !address(gate))
    {
        return Err(ReadError::InvalidResponse);
    }
    Ok(EarnObservation {
        schema_version: 1,
        protocol: target.protocol,
        chain_id: target.chain.to_string(),
        contract_address: target.contract.clone(),
        asset: normalized_asset(c.asset),
        position_asset: EarnAsset {
            address: target.contract.clone(),
            decimals: shares_decimals,
            symbol: c.symbol,
        },
        total_supplied_raw: s.total_assets,
        available_liquidity_raw: Some(s.withdrawable_assets),
        supply_cap_raw: None,
        supply_apy: fraction.map(|fraction| YieldObservation {
            fraction,
            basis: YieldBasis::TrailingOneDayAfterFees,
            rewards_included: false,
        }),
        restrictions: Restrictions {
            paused: None,
            frozen: None,
            supply_cap_reached: None,
            gated: Some(gates.iter().any(Option::is_some)),
        },
        vault_fees: Some(vec![
            VaultFee {
                kind: VaultFeeKind::Performance,
                rate_wad: c.performance_fee_wad,
            },
            VaultFee {
                kind: VaultFeeKind::Management,
                rate_wad: c.management_fee_wad,
            },
        ]),
        source_blocks: vec![
            SourceBlock {
                component: SourceComponent::Configuration,
                number: c.last_indexed_block,
            },
            SourceBlock {
                component: SourceComponent::State,
                number: s.last_indexed_block,
            },
            SourceBlock {
                component: SourceComponent::Apy,
                number: a.last_indexed_block,
            },
        ],
        fetched_at_ms: now_ms(),
        execution_available: false,
    })
}

#[derive(Deserialize)]
struct GraphResponse {
    data: Option<AaveData>,
    errors: Option<Vec<Value>>,
}
#[derive(Deserialize)]
struct AaveData {
    reserve: Option<Reserve>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reserve {
    market: Market,
    underlying_token: Currency,
    a_token: Currency,
    is_frozen: bool,
    is_paused: bool,
    supply_info: SupplyInfo,
    borrow_info: Option<BorrowInfo>,
}
#[derive(Deserialize)]
struct Market {
    address: String,
    chain: Chain,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chain {
    chain_id: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Currency {
    address: String,
    chain_id: u64,
    decimals: u8,
    symbol: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupplyInfo {
    apy: Scaled,
    supply_cap: Amount,
    supply_cap_reached: bool,
    total: Scaled,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BorrowInfo {
    available_liquidity: Amount,
}
#[derive(Deserialize)]
struct Amount {
    amount: Scaled,
}
#[derive(Deserialize)]
struct Scaled {
    raw: String,
    decimals: u8,
}
fn parse_aave(target: &EarnTarget, bytes: &[u8]) -> Result<EarnObservation, ReadError> {
    let response: GraphResponse = decode(bytes)?;
    if response.errors.is_some_and(|e| !e.is_empty()) {
        return Err(ReadError::InvalidResponse);
    }
    let r = response
        .data
        .ok_or(ReadError::InvalidResponse)?
        .reserve
        .ok_or(ReadError::NotFound)?;
    let asset = EarnAsset {
        address: r.underlying_token.address,
        decimals: r.underlying_token.decimals,
        symbol: r.underlying_token.symbol,
    };
    let position_asset = EarnAsset {
        address: r.a_token.address,
        decimals: r.a_token.decimals,
        symbol: r.a_token.symbol,
    };
    let supply = r.supply_info;
    if target.protocol != EarnProtocol::AaveV3
        || !same_target(target, r.market.chain.chain_id, &r.market.address)
        || r.underlying_token.chain_id != target.chain
        || r.a_token.chain_id != target.chain
        || !asset.address.eq_ignore_ascii_case(&target.asset)
        || !valid_asset(&asset)
        || !valid_asset(&position_asset)
        || asset.decimals != position_asset.decimals
        || !uint256(&supply.apy.raw)
        || supply.apy.decimals > 77
        || !scaled_amount(&supply.total, asset.decimals)
        || !scaled_amount(&supply.supply_cap.amount, asset.decimals)
        || r.borrow_info
            .as_ref()
            .is_some_and(|b| !scaled_amount(&b.available_liquidity.amount, asset.decimals))
    {
        return Err(ReadError::InvalidResponse);
    }
    Ok(EarnObservation {
        schema_version: 1,
        protocol: target.protocol,
        chain_id: target.chain.to_string(),
        contract_address: target.contract.clone(),
        asset: normalized_asset(asset),
        position_asset: normalized_asset(position_asset),
        total_supplied_raw: supply.total.raw,
        available_liquidity_raw: r.borrow_info.map(|b| b.available_liquidity.amount.raw),
        supply_cap_raw: Some(supply.supply_cap.amount.raw),
        supply_apy: Some(YieldObservation {
            fraction: scaled_fraction(&supply.apy),
            basis: YieldBasis::CurrentSupply,
            rewards_included: false,
        }),
        restrictions: Restrictions {
            paused: Some(r.is_paused),
            frozen: Some(r.is_frozen),
            supply_cap_reached: Some(supply.supply_cap_reached),
            gated: None,
        },
        vault_fees: None,
        source_blocks: vec![],
        fetched_at_ms: now_ms(),
        execution_available: false,
    })
}
fn scaled_fraction(value: &Scaled) -> String {
    let n = usize::from(value.decimals);
    if n == 0 {
        return value.raw.clone();
    }
    let mut digits = format!("{:0>width$}", value.raw, width = n + 1);
    digits.insert(digits.len() - n, '.');
    digits
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
}
fn scaled_amount(value: &Scaled, decimals: u8) -> bool {
    value.decimals == decimals && uint256(&value.raw)
}
fn same_target(target: &EarnTarget, chain: u64, contract: &str) -> bool {
    chain == target.chain && contract.eq_ignore_ascii_case(&target.contract)
}
fn address(value: &str) -> bool {
    value.len() == 42
        && value.starts_with("0x")
        && value[2..].bytes().all(|c| c.is_ascii_hexdigit())
        && value[2..].bytes().any(|c| c != b'0')
}
fn symbol(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
fn valid_asset(asset: &EarnAsset) -> bool {
    address(&asset.address) && symbol(&asset.symbol)
}
fn normalized_asset(mut asset: EarnAsset) -> EarnAsset {
    asset.address.make_ascii_lowercase();
    asset
}
fn cmp_uint(left: &str, right: &str) -> std::cmp::Ordering {
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}
fn uint256(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 78
        && value.bytes().all(|c| c.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
        && !cmp_uint(value, UINT256_MAX).is_gt()
}
fn decimal_fraction(value: &str) -> bool {
    // Validation only: the original lexical number is retained, never rounded via f64.
    value.len() <= 80
        && serde_json::from_str::<serde_json::Number>(value)
            .ok()
            .and_then(|n| n.as_f64())
            .is_some_and(f64::is_finite)
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, ReadError> {
    serde_json::from_slice(bytes).map_err(|_| ReadError::InvalidResponse)
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    const ASSET: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const AAVE: &[u8] = include_bytes!("../../tests/fixtures/earn/aave-reserve.json");
    const CONFIG: &[u8] = include_bytes!("../../tests/fixtures/earn/morpho-config.json");
    const STATE: &[u8] = include_bytes!("../../tests/fixtures/earn/morpho-state.json");
    const APY: &[u8] = include_bytes!("../../tests/fixtures/earn/morpho-apy.json");
    fn aave_target() -> EarnTarget {
        EarnTarget::new(
            EarnProtocol::AaveV3,
            1,
            "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
            ASSET,
        )
        .unwrap()
    }
    fn morpho_target() -> EarnTarget {
        EarnTarget::new(
            EarnProtocol::MorphoVaultV2,
            1,
            "0x04422053aDDbc9bB2759b248B574e3FCA76Bc145",
            ASSET,
        )
        .unwrap()
    }
    #[test]
    fn live_fixtures_preserve_exact_units_and_do_not_imply_execution_or_atomicity() {
        let a = parse_aave(&aave_target(), AAVE).unwrap();
        assert_eq!(
            a.supply_apy.unwrap().fraction,
            "0.038313795766101947560963736"
        );
        assert_eq!(a.asset.decimals, 6);
        assert_eq!(
            a.available_liquidity_raw.as_deref(),
            Some("157022404660081")
        );
        assert!(a.source_blocks.is_empty());
        assert!(!a.execution_available);
        let m = parse_morpho(&morpho_target(), CONFIG, STATE, APY).unwrap();
        assert_eq!(m.position_asset.decimals, 18);
        assert_eq!(m.supply_apy.unwrap().fraction, "0.05450325062161674");
        assert_ne!(m.source_blocks[0].number, m.source_blocks[1].number);
        assert!(m.vault_fees.unwrap()[1].rate_wad.is_none());
        assert!(!m.execution_available);
    }
    #[test]
    fn historical_apy_keeps_lexical_precision_and_missing_history_is_not_zero() {
        for fraction in ["0.12345678901234567890123456789", "-0.01", "5e-19"] {
            let original = std::str::from_utf8(APY).unwrap();
            let response = original.replace("0.05450325062161674", fraction);
            let result =
                parse_morpho(&morpho_target(), CONFIG, STATE, response.as_bytes()).unwrap();
            assert_eq!(result.supply_apy.unwrap().fraction, fraction);
        }
        let response = std::str::from_utf8(APY)
            .unwrap()
            .replace("0.05450325062161674", "null");
        assert!(
            parse_morpho(&morpho_target(), CONFIG, STATE, response.as_bytes())
                .unwrap()
                .supply_apy
                .is_none()
        );
    }
    #[test]
    fn wrong_identity_units_partial_graphql_results_and_numeric_amounts_fail_closed() {
        for pointer in [
            "/data/reserve/market/chain/chainId",
            "/data/reserve/underlyingToken/decimals",
            "/data/reserve/aToken/chainId",
        ] {
            let mut v: Value = serde_json::from_slice(AAVE).unwrap();
            *v.pointer_mut(pointer).unwrap() = json!(2);
            assert_eq!(
                parse_aave(&aave_target(), &serde_json::to_vec(&v).unwrap()).unwrap_err(),
                ReadError::InvalidResponse
            );
        }
        let mut v: Value = serde_json::from_slice(AAVE).unwrap();
        v["errors"] = json!([{"message":"private-provider-error"}]);
        assert_eq!(
            parse_aave(&aave_target(), &serde_json::to_vec(&v).unwrap()).unwrap_err(),
            ReadError::InvalidResponse
        );
        v.as_object_mut().unwrap().remove("errors");
        v["data"]["reserve"]["supplyInfo"]["total"]["raw"] = json!(123);
        assert_eq!(
            parse_aave(&aave_target(), &serde_json::to_vec(&v).unwrap()).unwrap_err(),
            ReadError::InvalidResponse
        );
    }
    #[test]
    fn morpho_version_target_and_share_decimals_are_checked() {
        for (field, value) in [
            ("version", json!("1.0")),
            ("chain_id", json!(8453)),
            ("decimals_offset", json!(255)),
        ] {
            let mut v: Value = serde_json::from_slice(CONFIG).unwrap();
            v["data"][field] = value;
            assert_eq!(
                parse_morpho(
                    &morpho_target(),
                    &serde_json::to_vec(&v).unwrap(),
                    STATE,
                    APY
                )
                .unwrap_err(),
                ReadError::InvalidResponse
            );
        }
        assert!(EarnTarget::new(EarnProtocol::AaveV3, 1, "//evil.example", ASSET).is_err());
        assert!(uint256(UINT256_MAX));
        for raw in [
            "01",
            "-1",
            "1e18",
            "115792089237316195423570985008687907853269984665640564039457584007913129639936",
        ] {
            assert!(!uint256(raw));
        }
    }
}
