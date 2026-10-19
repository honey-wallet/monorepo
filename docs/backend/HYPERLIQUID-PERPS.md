# Hyperliquid perps account read

## Shipped boundary

`GET /api/v1/perps/hyperliquid/account` returns a normalized, read-only clearinghouse
snapshot for the wallet proven by the caller's current Honey SIWE bearer session.
The route does not accept an address, DEX, subaccount, or signer from the client; this
avoids turning a valid bearer into an arbitrary-account query primitive. The verified
session profile's EOA address is sent to Hyperliquid `POST /info` with
`{"type":"clearinghouseState","user":"<profile address>"}`. Requests are bounded
by a 5-second HTTP timeout, no redirects, a 600/minute global and 60/minute per-wallet
database limiter, a shared Redis provider limit, a 1 MiB provider-body ceiling, and a 500-position response ceiling. Provider decimal values stay
decimal strings; the API does not derive liquidation prices or position values.

The API client rejects malformed addresses, non-decimal/exponent values, invalid
margin modes, unsafe timestamps, and unbounded positions. Unknown provider fields are
ignored to tolerate additive venue schema fields; required fields and numeric formats
are validated before a response is returned. This projection is a current upstream
snapshot, not durable trade history or a websocket stream.

This reads only the EOA proven to Honey by SIWE; it does not prove that the address
has an existing Hyperliquid account or is the user's separately linked trading
account. The venue may return an empty account state for an address with no activity.
No alternate address can be requested from this route.

## Shared account-read cache and upstream admission

Authenticated account reads require Redis. The server canonicalizes the SIWE wallet
address and uses its SHA-256 digest in a per-account Redis cache key; the address is
never placed in the key. A valid response is cached for five seconds. Concurrent
misses across replicas contend on an eight-second owner-token lease; followers poll
for at most one second and return `503` if the leader has not published. Cache
publication and lease release both compare the owner token, so an expired leader
cannot overwrite a successor's observation. Redis read, lock, quota, or publication failures
fail the endpoint closed. There is no process-local cache fallback and no stale
response path, so a Redis outage cannot bypass the shared provider pacing policy.

Before a cached response is served, the server checks Redis TTL (positive and no
greater than five seconds), envelope version and venue, exact canonical account,
receipt age, normalized clearinghouse field bounds, and source timestamp freshness.
Invalid entries are treated as misses and replaced only after a fresh provider
response passes the same schema and source-time checks. The endpoint retains its
existing response contract; `fetchedAtMs` remains the local provider receipt time.

Only cache misses consume the distributed provider quota. Hyperliquid documents a
1,200-weight/minute aggregated REST limit per source IP and a weight of two for
`clearinghouseState`. Honey allows at most 500 such fetches/minute across the shared
Redis namespace (1,000 weight/minute), with an additional 12/minute per wallet, and
retains the eight-request per-process semaphore. These limits leave headroom below
the documented IP ceiling; deployment must ensure replicas using a namespace share
the same egress IP or configure limits to match actual provider egress topology.

The ignored isolated Redis/loopback test uses two independent service instances to
verify same-wallet cold-miss coalescing, cache reuse and distinct-wallet isolation;
run it with `TEST_REDIS_URL` and `cargo test -p honey-server hyperliquid_perps::tests::redis_cache_coalesces_cross_instance_misses_and_isolates_accounts --lib -- --ignored`.
Unit tests cover cache schema, account, TTL, receipt-age and source-time rejection.
This local test does not establish production Redis failover, egress-IP topology or
the provider's current quota behavior.

Rate-limit reference: [Hyperliquid API rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits).

## Design decision and tradeoffs

The implementation uses read-only `clearinghouseState` first because it exercises
actual account ownership and reconciles displayed perps positions without creating a
central signer. The five-second shared cache and cold-miss lease reduce repeat reads
and cross-replica bursts; on a miss, a Redis quota provides a conservative egress
limit. The short cache window trades up to five seconds of account freshness for
lower provider load. The API never serves stale data or converts unavailable data
into an empty/zero position.

Trading remains disabled. Hyperliquid's exchange API requires a signed action, and the
correct order asset index is derived from current perps metadata. Subaccount/vault
actions require the master account signer and an explicit target address. Honey has no
verified user-owned signing path for Hyperliquid action payloads, nonce serialization,
builder-fee approval, precision checks, or submit-time reconciliation, so this slice
does not construct or submit orders. This avoids treating the existing demo order UI
as an execution path.

## Verification and remaining acceptance

Unit tests cover the official clearinghouse response projection, signed PnL/size string
handling, address shape, malformed decimal rejection, position-count bound and cache
envelope/time validation. The isolated Redis test verifies cross-instance coalescing,
cache reuse and wallet isolation. API client tests cover the unchanged public contract.
Still required: live account read using a user-approved test wallet, integration
coverage for bearer ownership and rate limits, web/mobile UX labels the data as venue
state and clears it on session or lifecycle changes, cross-device reconciliation, and
signed order/cancel/fill path. Live provider account acceptance remains required
before any perps money movement.

Official references: [Perpetuals info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
documents `clearinghouseState` and its wallet-address parameter;
[exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)
documents signed order actions, metadata-derived asset IDs, and master-wallet signing
for subaccounts/vaults. The source documents are live and can change; re-check the
schema before widening this adapter.
