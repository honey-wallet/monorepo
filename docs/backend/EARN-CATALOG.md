# Cached Earn delivery and frontend contract

Implemented 2026-10-18. Builds on [EARN-READERS.md](EARN-READERS.md). The API and
web/native/extension displays serve indexed public observations. Deposits,
withdrawals, wallet positions, fee collection and execution remain unavailable.
Read configuration is not product approval. No production deployment or signed
transaction was performed.

## Registry and identity

`EARN_READ_TARGETS` is a JSON array, empty by default, at most eight entries and
8 KiB of configuration. Each entry has exactly protocol, chainId, contractAddress,
assetAddress and label. Protocol is aave_v3 or morpho_vault_v2; chainId is a canonical
positive decimal string. Addresses are explicit nonzero EVM identities. A label is
bounded plain text. Unknown keys, duplicate identities, malformed values and a
nonempty registry without Redis reject startup. There is no URL, credential, fee
recipient or execution flag in this schema.

The product ID is SHA-256 over versioned protocol/chain/contract/asset identity.
Labels are excluded so editorial changes do not create a new financial identity.
There is no symbol-based identity or arbitrary user-selected upstream lookup.
Each process uses only its current configured registry, so an old cached product
cannot reappear merely because a Redis key still exists. Config rollout still needs
coordination between replicas; an old replica retains its old configured list until
replaced. A separate reviewed product/risk registry is required for execution.

## Collector and cache algorithms

Two supervised tasks run only with a nonempty registry:

1. Collector scans the bounded registry, acquiring a per-product Redis refresh
   lease before calling the existing provider reader. The reader's shared provider
   spacing/cooldown remains in force. Registry size does not bypass provider budgets.
2. Mirror reads bounded Redis snapshots into local process memory every five seconds.
   HTTP handlers clone these local observations and perform no provider or Redis IO.

The refresh lease is 30 seconds, the complete reader has a 27-second outer deadline,
and a claim reserves the next attempt at least 60 seconds later. A unique claim
token fences publication. A crashed worker may delay refresh until the reserved
next attempt, but an old worker cannot replace the winner's cache entry. Success
ends the lease; it does not clear provider cooldowns. Failed refreshes keep the old
sample and emit classified protocol/product correlation without raw provider errors.
All multi-key cache scripts use the same Redis hash slot. Provider admission remains
separate per provider.

Positive snapshots retain for ten minutes; the mirror rejects oversized (>16 KiB),
malformed, wrong-identity, wrong-unit or execution-enabled payloads. Publication
preserves the validated observation JSON verbatim and adds Redis-time metadata:
Redis Lua cjson decode/encode changes empty arrays to objects, which the actual
round-trip test caught. Avoid re-encoding typed payloads in Lua.

Local age starts with Redis-time publication age and advances with Rust Instant.
Rereading the same publication cannot lower its age, even if the Redis clock moves
backward. An older publication cannot replace a newer local one. On Redis failure,
local data continues to age; at two minutes it becomes stale and at ten minutes it
is removed. A successful read of an absent/invalid Redis entry removes the local
copy. No cold-cache fallback calls the provider from an HTTP request.

Eight all-Morpho targets require at most 24 successful upstream HTTP reads for one
complete refresh cycle. This is a configuration budget, not measured sustained
throughput or a negotiated provider entitlement. Sequential collection may take
longer under provider failure; the observable result is stale/unavailable products,
not an extended freshness claim. Before increasing registry size, measure refresh
age, quotas, failure latency and cross-provider fairness; consider independently
scheduled provider collectors when the measured need exists.

## API contract

`GET /api/v1/earn/catalog`, schemaVersion=1, maxAgeMs=120000.

| Field/state | Meaning |
| --- | --- |
| not_configured | Registry empty; products empty |
| ready | Every configured product has a recently published observation |
| degraded | At least one configured product is stale or unavailable |
| product fresh | Publication age <= two minutes |
| product stale | Publication age > two minutes and < ten minutes |
| product unavailable | No usable observation; ageMs and observation are null |

The endpoint returns 200 for these explicit data states. Common admission, body,
deadline, CORS, request/trace ID and no-store behavior still applies. API readiness
is separate from product data freshness. The financial `earn` capability remains
false; cached market observations are not executable quotes.

Each product includes its stable ID, label, protocol, chain, contract, underlying
asset, age and optional full `EarnObservation`. All quantities retain decimal-string
representation; nullable restrictions/fees/history stay unknown. `fetchedAtMs` is
local provider-fetch completion time, not a provider indexer freshness guarantee.
Source block references remain component-specific; Aave currently provides no
block in the selected query. There is no user address or position in this endpoint.

Types mirror the server in `packages/api-client/src/types.ts`. The shared validator
rejects mismatched product/observation identities, malformed quantities/units,
duplicate products, inconsistent freshness states and any executionAvailable=true.
The client also checks its local clock against fetchedAtMs, advances age after the
response and expires old samples. Clock disagreement conservatively displays stale.

## Frontend behavior and lifecycle

The shared polling controller has one active request, a five-second deadline,
25–35-second jittered refresh, local age updates and explicit cancellation. A late
completion after cleanup cannot revive the view. If a transport ignores abort,
the controller does not accumulate overlapping replacement requests. Native stops
on blur/background; web stops when hidden; both restart on return. Public data has
no need for persisted authentication credentials.

Native/extension non-demo Savings, Earn detail and Savings Add now show indexed
market observations instead of demo yield projections or simulated deposits.
The demo wallet retains its prototype flows. Real savings positions and jars backed
by actual balances remain future work; the live screen explicitly says positions
are not connected. Direct navigation to legacy deposit routes cannot mount the demo
transaction flow for a non-demo wallet.

The web shell uses the same client and displays protocol/chain/contract, rate basis
and unavailable/stale states. Rates use an approximate two-decimal percentage for
presentation; original rate strings remain intact. No monetary amounts or execution
parameters are calculated from display floats. A current supply APY and trailing
day after-fee APY are labelled differently; neither includes rewards here. Neither
screen offers a live deposit/withdraw button or a guaranteed withdrawal claim.

Expo SDK57/React Native0.86 in this checkout was checked against the versioned
[Expo reference](https://docs.expo.dev/versions/v57.0.0/),
[Router API](https://docs.expo.dev/versions/v57.0.0/sdk/router/) and
[AppState API](https://reactnative.dev/docs/appstate). Native implementation reuses
existing navigation, skeleton and theme components; no new native dependency.

## Evidence and reproduction

```sh
TEST_REDIS_URL=redis://127.0.0.1:26379 \
cargo test -p honey-server --lib earn_catalog::tests -- --ignored
TEST_REDIS_URL=redis://127.0.0.1:26379 \
cargo run -p honey-server --example earn_catalog_smoke
pnpm lint && pnpm typecheck && pnpm test
```

The smoke starts two loopback API replicas, uses the reference public targets from
provider documentation, exercises shared collection/mirroring and makes 100 cached
HTTP reads. Provider-call counters must remain unchanged across those reads. The
stable earn-smoke namespace preserves upstream cooldowns across runs. It does not
change production configuration or approve those example products.

[Captured result](results/earn-catalog-smoke-2026-10-18.json): both replicas ready,
100 successful cached HTTP reads, unchanged provider-call counters, all financial
execution flags false. This is functional integration evidence, not a 10k-user Earn
load test. The existing 10k price-socket experiment has a different workload.

Tests cover replica claim races, stale publisher rejection, empty-array round trips,
local aging/expiry, same-sample age monotonicity, tampered execution flags, explicit
unconfigured API behavior, strict client validation, deadlines/cancellation/late
responses and web hidden-page cleanup. The shared client also validates both exact
observations captured from the real two-replica smoke, linking provider JSON through
the server cache/API to the frontend contract. CI explicitly executes the real Redis cache
test. Full workspace checks and the web production build passed, including extension export;
physical-device UI/biometric
acceptance and production mixed-load/failover evidence remain outstanding.

Next: approved execution product registry, RPC/simulation/signer checks, immutable
persisted preparation and step tracking, actual submit attribution and durable
reconciliation. Continue the remaining provider and identity roadmap; this delivery
does not close the full backend goal.
