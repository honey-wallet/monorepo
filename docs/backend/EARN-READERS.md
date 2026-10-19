# Earn provider readers: Morpho Vault V2 and Aave V3

Implemented and live-read verified 2026-10-18. Source:
`apps/server/src/providers/{earn,transport}.rs`; reproducible public read:
`apps/server/examples/earn_smoke.rs`. The indexed-data layer now feeds a fenced cached catalog API and web/native Savings
displays; see [EARN-CATALOG.md](EARN-CATALOG.md). Financial capability
`earn` remains unavailable. No signatures, approvals, deposits or withdrawals were
submitted during verification.

## Why this precedes dispatch

The current `WorkStore` persists an intent hash and outbox IDs, but not a validated
provider plan. A restarted worker cannot reconstruct a financial action from that
hash. Do not start a generic worker that acknowledges these jobs or reconstructs
parameters from current prices. The next execution phase needs persisted, immutable
validated intents, explicit signer/chain/product identities, prepared steps and
reconciliation evidence. Indexed observations help preparation; they do not replace
RPC verification, simulation or signed-payload validation.

This phase establishes the two Earn data contracts against actual current provider
responses. It also provides the bounded read transport required by their eventual
cache collectors. Other adapters still need their own versioned schemas and tests.

## Source contract checked

Morpho's current documentation recommends REST for covered data and GraphQL for
remaining fields. Public rate limits include a severe-abuse seven-day cooldown.
The reader uses V2 config, state and one-day historical APY endpoints. APY is a
post-fee historical fraction excluding rewards. State/config/APY can have different
indexed blocks, so the result preserves each block separately. The directory of
listed vaults is not an approved Honey registry. [API overview](https://docs.morpho.org/developers/api/get-started/),
[vault endpoints and units](https://docs.morpho.org/developers/api/morpho-vaults/).

Aave V3 has a distinct GraphQL endpoint. The selected `reserve` query fetches no
user data and requests underlying/aToken units, supply APY, supplied amount, supply
cap, freeze/pause/cap flags and optional liquidity. APY is reconstructed from exact
raw/decimals. GraphQL errors invalidate even a response that also contains data.
The selected response supplies no indexed block; an empty sourceBlocks list means
unknown, never latest/finalized. [Aave V3 GraphQL](https://www.aave.com/docs/aave-v3/getting-started/graphql),
[market data](https://www.aave.com/docs/aave-v3/markets/data).

Aave's transaction-preparation and indexed-processing APIs are separate concerns;
indexer processing is not chain finality. Its documented execution plans include
approval-required and insufficient-balance variants, which must be handled by a
future preparation adapter. [Market operations](https://www.aave.com/docs/aave-v3/markets/operations).

## Normalized observation and validation

`EarnTarget::new` requires protocol, chain, exact contract and underlying asset.
Addresses are validated and normalized; zero addresses, malformed paths and unsafe
chain-number encodings are rejected. Fields are private, so callers cannot bypass
construction using public struct literals. These targets authorize public reads
only. The example target list exists only in the smoke example, not production
configuration or a deposit allowlist.

`EarnObservation` carries:

- Protocol version, decimal-string chain ID and contract address.
- Underlying and position asset identities, decimals and bounded symbols.
- Exact raw supplied/liquidity/cap strings. Unknown liquidity/caps remain null.
- Optional APY with explicit fraction and measurement basis. A null historical
  result remains unknown, never zero. Current Aave APY and one-day Morpho APY are
  distinct measurements and must not be ranked as equivalent forward guarantees.
- Nullable protocol restrictions. Unknown is not permission to deposit/withdraw.
- Optional Morpho vault fees with exact WAD values. Null fees remain unknown.
  These are protocol metadata, not Honey revenue or an approved charge policy.
  No annualized management-fee calculation is inferred from the generic WAD field.
- Independent source block references, local completed-fetch time and
  executionAvailable=false. Fetch time does not establish indexer freshness.

Amounts must be canonical unsigned decimal strings within uint256. JSON numbers,
negative/scientific/leading-zero amounts and overflow are rejected. Amount decimals
must match the expected underlying asset; aToken chain/decimals must also match.
Morpho share decimals use checked underlying-decimals + decimals-offset. Unknown
vault versions, changed chain/contract/underlying, invalid gates, out-of-range fee
fractions and malformed response fields fail validation.

APY has separate semantics from amounts: historical returns can be negative. Morpho's
numeric JSON token is captured with serde_json RawValue and preserved as a string,
including scientific notation; it never passes through a float for storage or
calculation. A bounded finite-number check validates syntax/range only. Aave's APY
fraction uses decimal-point placement on the raw string without floating arithmetic.
Symbol bounds and control/bidirectional-character rejection prevent unsafe display
metadata; no provider HTML, icon URLs or descriptions are forwarded.

The selected liquidity is aggregate indexed liquidity, not the current user's
withdrawable amount. In particular, Aave debt/collateral created outside Honey can
constrain exits, and Morpho gates/allocator liquidity can require further checks.
No reader method prepares transactions or decides a user's maximum withdrawal.

## Transport, shared quota and failure policy

`ReadTransport` fixes origins to api.morpho.org and api.v3.aave.com. Its request
methods are visible only inside the provider module. No runtime URL override,
redirect following, credentials or user-selected GraphQL query is exposed. A local
HTTP override is compiled only into tests. The POST is a fixed read-only GraphQL
query; no GraphQL mutation or transaction preparation is performed.

Bounds (engineering defaults, not negotiated provider entitlements):

| Bound | Value / reason |
| --- | --- |
| Local concurrent reader calls | Four per shared transport; caller clones one instance |
| Shared provider request spacing | One grant/second per provider across the Redis namespace |
| Waiting for shared admission | Four seconds maximum, then Busy |
| Connect / total upstream request | One / four seconds, including response body |
| Response body | 256 KiB, enforced for declared and streamed bodies |
| Idle connections | Two per host |
| Retries | No upstream retry; only bounded waiting for quota admission |
| Missing Retry-After | Ten-second shared cooldown for 429/5xx |
| Valid Retry-After | Seconds or HTTP date; retained up to 366 days; minimum ten seconds |
| Invalid/unrepresentable/longer Retry-After | Persistent shared hold requiring operator investigation |

Redis is mandatory. If Redis is unavailable, no provider request is issued. Lua
uses Redis time, shares fixed provider keys, and preserves the longer of concurrent
cooldowns. Success does not erase another request's cooldown. A later short failure
cannot clear a persistent hold. Ordinary spacing keys expire after two seconds;
cooldowns retain their own duration. Production replicas and collector processes
must share the same namespace and egress budget. Redis state loss/failover can lose
quotas; deployment review must account for that, and other apps sharing the egress
IP are outside these counters.

Invalid Retry-After is deliberately conservative: investigate the provider response
through approved diagnostics and provider status before removing the exact
`<namespace>:{provider-read-morpho|provider-read-aave}:cooldown` key. No public reset
endpoint is exposed. Do not use namespace rotation to evade a provider cooldown.

HTTP errors map to bounded classes. Provider bodies, URLs and raw transport errors
are not logged. Provider spans omit inputs. Existing provider metrics now include
morpho/aave earn_read outcomes, with per-provider/operation latency histograms.
A transport `ok` means a successful bounded HTTP response; domain validation can
still reject it. Collector-level validation/refresh-age metrics remain future work.

## Verification and reproduction

Fixtures in `apps/server/tests/fixtures/earn` were captured from the public official
endpoints. The initial Morpho captures intentionally have different source blocks;
unit tests ensure normalization does not falsely collapse them into an atomic read.
Schema inspection used live Aave introspection, with no user address supplied.

```sh
cargo test -p honey-server --lib providers::earn
TEST_REDIS_URL=redis://127.0.0.1:26379 \
cargo test -p honey-server --lib providers::transport::integration -- --ignored
TEST_REDIS_URL=redis://127.0.0.1:26379 \
cargo run -p honey-server --example earn_smoke
```

The smoke uses a stable `earn-smoke` Redis namespace to preserve cooldowns across
runs. Start only the disposable Redis service described in IMPLEMENTATION.md. The
smoke makes four public metadata reads, prints normalized observations and cannot
sign or submit transactions. Captured success output is in
[results/earn-read-smoke-2026-10-18.json](results/earn-read-smoke-2026-10-18.json).

Coverage: exact APY precision, missing history, protocol/chain/asset/decimal mismatch,
partial GraphQL errors, malformed numeric amounts, uint256 boundary, shared spacing
across independent transports, seven-day cooldown retention, persistent hold,
Redis-outage fail-closed behavior, redirects, oversized streamed responses and
upstream timeout. CI runs the isolated Redis/HTTP transport test explicitly.

## Next integration work and release gates

1. Approved product registry with risk owner/version, separate read/deposit/exit
   switches. Neither example address is approved by its presence in fixtures.
2. The fenced snapshot collector/cache, cached API and typed web/native delivery
   are implemented in EARN-CATALOG.md. Expand beyond the bounded read registry only
   with provider-budget and product-review evidence.
3. Chain RPC identity/state/freshness, allowance, liquidity and simulation checks;
   Morpho minimum-output protection and Aave outside-app collateral/debt validation.
4. Immutable persisted provider preparation, exact step review/local signing,
   broadcast attribution, finality/reorg/replacement and durable reconciliation.
5. Reviewed fee/builder policy and measured provider quotas/SLA, mixed-load and
   failure tests. No 10k-user Earn capacity claim follows from four public reads.

The full roadmap in ARCHITECTURE.md remains active. These readers establish actual
provider data integration, not the completion of Earn or financial execution.
