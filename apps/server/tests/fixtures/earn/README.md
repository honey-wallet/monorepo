# Public provider response fixtures

Captured 2026-10-18 from official public endpoints. These are public protocol data,
not user positions, credentials or approved Honey products. JSON whitespace was
formatted by Biome; numeric values and string fields are unmodified.

- `aave-reserve.json`: POST `https://api.v3.aave.com/graphql`, `reserve` query with
  chainId=1, market=0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2,
  underlyingToken=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48. Selection is the
  `AAVE_QUERY` constant in `src/providers/earn.rs`, plus APY `value` in this initial
  fixture. The implementation derives the fraction from raw/decimals exactly.
- `morpho-config.json`: GET `https://api.morpho.org/v0/vaults-v2/1:0x04422053aDDbc9bB2759b248B574e3FCA76Bc145`.
- `morpho-state.json`: GET `https://api.morpho.org/v1/vaults-v2/1:0x04422053aDDbc9bB2759b248B574e3FCA76Bc145/state`.
- `morpho-apy.json`: GET `https://api.morpho.org/v1/vaults-v2/1:0x04422053aDDbc9bB2759b248B574e3FCA76Bc145/apy-averages?lookback=one_day`.

The Morpho contract and Aave market are examples in official documentation. The
responses establish field shapes/units at capture time; they do not establish
contract safety, indexer correctness, future availability or product approval.
See `docs/backend/EARN-READERS.md` for source links, behavior and open gates.
