# Polymarket public market catalog (read only)

Honey exposes `GET /api/v1/prediction/markets?limit=20&cursor=...` as a bounded proxy to Polymarket Gamma `GET /markets/keyset?closed=false&limit=100`. The local query limit defaults to 20 and is clamped to 1–100. A local decimal offset cursor pages over the currently cached snapshot; the API response returns `nextCursor` and `sourceTruncated`. The server uses a fixed HTTPS host and a four-second per-request timeout; caller input cannot choose an upstream URL. The response is a Honey-owned schema (`schemaVersion: 1`) with market ID, slug, question, condition ID, protocol version, outcome token IDs and position IDs, the Gamma `enableOrderBook` flag, and active/closed flags. Gamma V1 and V2 use different outcome identifiers, so clients must retain the version and must not treat an empty token ID list as proof that a market is invalid. Missing order-book metadata is conservatively `false`. Identifiers must be nonempty, bounded and restricted to alphanumeric, underscore, or hyphen characters; unsupported versions and malformed or over-limit outcome sets are dropped as a whole rather than partially normalized. Each upstream body is capped at 1 MiB and the complete bounded walk at 4 MiB; an oversized declared length is rejected before reading, and streamed bytes are capped incrementally when length is absent or inaccurate.

`executionAvailable` is hard-coded false. `orderBookEnabled` is provider metadata only: it does not retrieve books or prices and cannot create, sign, submit, cancel, redeem, or reconcile orders. Polymarket documents Gamma `/markets/keyset` separately from CLOB orderbook and pricing endpoints; market discovery therefore does not imply a live book, market eligibility or trading availability. Upstream cursors are consumed only by the server and never exposed as trusted client cursors.

Design choices: proxy Gamma through Honey to avoid leaking provider coupling into clients, keep the production upstream hostname fixed to prevent SSRF, and normalize only fields needed for discovery instead of returning provider JSON as a stable Honey contract. A refresh follows at most ten Gamma keyset pages of 100 markets each, for at most 1,000 normalized markets and 4 MiB total upstream bytes. Repeated cursors, malformed pagination, incomplete full pages with a cursor, timeouts, or any failed page reject the whole refresh; partially fetched catalogs are never published. Duplicate market IDs across pages are retained once. Hitting the page/market cap with another cursor publishes the complete bounded result and sets `sourceTruncated=true`. The completed snapshot is cached under one fixed namespaced Redis key for up to five minutes; local limits/cursors slice that snapshot and do not create cache-key cardinality. Responses are `fresh` for 30 seconds. Between 30 and 300 seconds they may be served as `stale`, with `fetchedAtMs` and `ageMs` exposed for UI treatment. Older entries expire and are never served.

Cold refresh is coalesced within a process and across replicas with a Redis lease sized to cover the maximum ten-page upstream walk plus bounded cache publication and lease release. Followers wait at most one second for a fresh shared value, then receive an explicitly stale entry if available or a bounded `503 catalog_unavailable`; they never fan out to Gamma. Redis is required for refresh coordination: on Redis failure the service uses an in-process entry only if it is no older than five minutes, otherwise returns `503` without attempting an upstream fetch. If Gamma fails or exceeds its timeout/body caps, the service serves a still-valid stale cache entry; with no eligible stale entry it returns `503`. Cached data is shared across replicas; the local cache is only a short-circuit/fallback and does not extend the five-minute stale bound. The API client method accepts `polymarketCatalog(init?, cursor?)` and validates freshness and pagination metadata.

Tradeoffs: shared Redis storage and a lease prevent request storms during cold starts, but a slow refresh can make followers wait up to one second and then receive a service error. Redis outages intentionally sacrifice cold availability to bound Gamma load. Client cursors are offsets into a snapshot that can refresh between page requests. The web UI compares `fetchedAtMs` on each page response and restarts at page one if the snapshot changed, preventing mixed-snapshot duplicate or skipped-page presentation at the cost of discarding the in-progress pagination. The cache has no background refresh, circuit breaker, or provider quota telemetry; monitor these before increasing traffic or the source page bounds.

Trading remains blocked pending current verified contracts and implementation for market/outcome versioning (including V1/V2 differences), CLOB book and price semantics, wallet authentication/signing and signer compatibility, fee schedules and builder-fee eligibility, region/account eligibility, order lifecycle/partial fills/cancel, redemption, and reconciliation. No credentials, builder agreement, signer, or provider account are required or used for this catalog route. Do not enable prediction money movement from this metadata.

Evidence: [Gamma keyset market API](https://docs.polymarket.com/api-reference/markets/list-markets-keyset-pagination) documents Gamma's market response fields, including `clobTokenIds`, `positionIds`, `version`, `enableOrderBook`, `active`, and `closed`. The [CLOB Get Order Book API](https://docs.polymarket.com/api-reference/market-data/get-order-book) specifies a token-ID keyed book with bids, asks, tick size, minimum order size, negative-risk status, and last-trade price; that is a distinct schema and is not returned by this endpoint. These provider contracts can evolve, so response normalization and fixtures need review when upgrading the integration. `enableOrderBook` alone is not used as an execution gate.

## Read-only order-book snapshots (2026-10-19)

`GET /api/v1/prediction/order-book?token_id=...` now proxies the official CLOB
`GET /book?token_id=...` response for display. The server first resolves the canonical
Gamma catalog and accepts only a `clobTokenIds` member of an active, non-closed market
with `enableOrderBook=true`; V2 `positionIds` are never treated as CLOB assets. Both
returned `asset_id` and `market` must exactly match that token and Gamma `conditionId`.
The token is then hashed for a versioned Redis cache key. Redis coordinates a 5-second
refresh lease across replicas, caches for 60 seconds, and globally spaces CLOB fetches
to at most one per second. Freshness uses the older of the local fetch and provider
snapshot timestamp; results older than 60 seconds are not returned, and stale results
are explicitly labeled. Redis failure does not bypass provider admission or trigger a
cold direct request.

The parser caps the response at 512 KiB and 500 levels per side, requires provider
metadata, validates exact decimal syntax/ranges and strictly sorted levels, checks the
book identity, and bounds all strings. It retains price/size strings instead of using
floating-point arithmetic in the API contract. The web UI can request a book for each
eligible outcome and displays best bid/ask plus freshness. The response keeps
`executionAvailable=false`; it creates no quote, fee, eligibility, balance, order,
signing, or settlement capability. This is an indicative public snapshot only.

The conservative one-request-per-second shared gate limits bursts across replicas but
can make cold books unavailable when many distinct outcomes are requested at once;
callers get an eligible stale snapshot or a service error. Revisit the gate only with
measured CLOB quota evidence. Integration tests cover catalog membership, identity
binding, Redis cache reuse, and no CLOB request for unlisted tokens; unit tests cover
sorting, exact decimal boundaries, missing fields, and identity mismatch.

Contract source: [Polymarket CLOB Get Order Book](https://docs.polymarket.com/api-reference/market-data/get-order-book), which specifies `token_id`, the `asset_id`/market snapshot identity, sorted bids and asks, tick/minimum size, negative-risk flag, and last-trade price. The public catalog still does not establish region eligibility or trading support; no order path is enabled.
