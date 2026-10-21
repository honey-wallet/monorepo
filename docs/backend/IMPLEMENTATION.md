# Backend implementation and verification

Bridging is NEAR Intents. Authenticated token discovery and signed, dry
exact-input quote previews are wired; production deposit execution and
settlement/refund reconciliation remain open. See [NEAR-INTENTS.md](NEAR-INTENTS.md).

Updated: 2026-10-21. This records foundation, Redis/prices/auth/observability,
Earn and Uniswap local execution, and bridge preview/recovery infrastructure.
The full backend remains in progress. A local 10,000-socket experiment passed;
production mixed-workload capacity remains unverified.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed design and feature roadmap,
and [DECISIONS.md](DECISIONS.md) for the reasoning and alternatives.

## Implemented in P0

| Change | Location | Behavior |
| --- | --- | --- |
| Validated runtime limits | `apps/server/src/config.rs` | Bounded timeout, concurrency, body size, DB pool size and shutdown settings |
| Secret-safe configuration | `apps/server/src/config.rs` | Connection URLs redact Debug; parse errors name variables without printing values |
| HTTP envelope | `apps/server/src/http_runtime.rs` | Per-process request-count admission, 16 MiB aggregate buffered-body payload budget, actual per-request byte limit including chunked bodies, and request deadline |
| Correlation and request spans | `apps/server/src/http_runtime.rs` | Server-generated UUID response header; route template, method, status and duration; no raw URI/query/header/body logging |
| Structured runtime errors | `apps/server/src/error.rs` | JSON 413/503/504 and Retry-After for busy/rate limited responses |
| PostgreSQL pool | `apps/server/src/runtime.rs` | SQLx pool with acquisition timeout and max connections; statement logging disabled |
| Redis connectivity | `apps/server/src/runtime.rs` | Bounded connection manager/PING checks and reconnect attempts |
| Readiness | `GET /ready` | Cached background checks; configured dependencies must be up; stale checks and drain become 503 |
| Liveness | Existing `GET /health` | Remains available during admission saturation or dependency outage |
| Shutdown | `apps/server/src/main.rs` | Marks draining, rejects new application work, bounded HTTP drain, monitor cancellation and pool close |
| Product capabilities | `GET /api/v1/capabilities` | Schema version 3 separates read-only quotes/catalog/account reads from execution and reports planned versus configured providers |
| Shared client | `packages/api-client/src` | Validated capability response, fail-closed feature helper, request ID and retry metadata on ApiError |
| Header interoperability | `packages/api-client/src/client.ts` | Supports Headers/tuple/object inputs; pairing credential cannot be overwritten by caller options |
| Web shell integration | `apps/web/src/App.tsx` | Fetches version/capabilities concurrently; distinguishes unavailable services from capability lookup failure |
| Local dependencies | `compose.backend.yaml` | Isolated, loopback-bound, disposable PostgreSQL/Redis services |
| Infrastructure CI | `.github/workflows/ci.yml` | Dedicated real-service integration test after ordinary Rust tests |

The existing `build_router` remains convenient for in-process tests without
infrastructure. Production startup uses `build_router_with_infrastructure` and runs the
dependency monitor. A configured dependency begins `pending`, then becomes `up`
or `down`; an absent dependency is explicitly `not_configured`.

`REQUIRE_INFRASTRUCTURE=true` requires both URLs at startup. Without it, local
scaffold mode may report ready with both dependencies `not_configured`. This means
the scaffold can serve its implemented routes, **not** that trading is available.
Readiness is a deployment routing signal, not an authorization check.

## Deliberately not implemented yet

### Legacy route boundary

The repository still mounts the original `/accounts`, `/accounts/{id}/recovery`,
`/accounts/{id}/exposure-events`, `/session-signatures/verify`, and `/relay/*`
scaffold handlers through `/api/v1`. Each currently returns `501 not_implemented`;
they must not be treated as an alternate account, recovery, signing, or transaction
path.
The active identity boundary is the SIWE-backed `/auth/*`, `/me`, and `/me/wallets`
API; provider actions use their dedicated authenticated preparation, signing, and
operation routes. The legacy handlers are mounted but remain fail-closed `501` code.
Do not implement beyond these stubs until they have explicit ownership checks,
durable persistence, chain-specific validation, capability reporting, and API-client
contract tests. This avoids accidentally reviving the older account model alongside
the newer wallet-membership model.

- Device management UI and regional/provider eligibility. Same-chain EOA wallet
  listing/linking, server-side rotating refresh families and mobile secure persistence
  are implemented below.
- Production provider activation and dead-letter replay tooling. Bounded read-only
  dead-letter inspection is available through `honey-server dead-letters`; replay is
  intentionally unavailable without provider-specific reconciliation. Supervised
  local Aave/Morpho/Uniswap execution workers and durable dispatch exist below.
- General provider/read-model caches and edge quotas beyond the implemented pairing/price scope.
- Relay has an authenticated, wallet-bound quote preview with server-forced
  `indicativeQuote`, shared Redis pacing and a response projection that omits
  executable item data; commit/reveal/submit remain unavailable. NEAR Intents has authenticated catalog
  reads and signature-verified dry quote previews; non-dry deposits, signing,
  execution and complete refund/settlement reconciliation remain open. Hyperliquid
  exposes public prices and a SIWE-bound clearinghouse read only; order submission is
  unavailable. Polymarket market discovery is read-only; order placement, cancellation,
  redemption and builder fees are unavailable.
- Live provider fee collection and production Aave/Morpho/Uniswap activation. Those
  have bounded local execution/preparation evidence; local forks do not establish
  external signer compatibility, eligibility, credentials, fee approval or production safety.
- Private order streams, indexers, historical candles or real portfolio balances.
- Production dashboard/paging provisioning, SLO burn alerts, worker/chain/fee metrics
  and comprehensive trace-loss visibility (current metrics/traces are documented below).
- Production mobile/extension financial acceptance. Native Earn/Uniswap review,
  signing and recovery are wired; remaining demo screens still need real services.
- Mobile perps and prediction screens retain market previews, but order placement
  is disabled while the backend advertises those execution capabilities as
  unavailable. Perps figures and all prediction market/balance figures are labeled
  as previews; no local success/position state is written. The
  standalone web app has public Earn catalogs but no Aave/Morpho action UI yet. Its
  SIWE bearer remains memory-only and access-only (refresh is not persisted or rotated
  in the web shell). Web execution also needs a wallet-owned raw EVM signing adapter;
  see D98. Hidden-tab account clearing and price-stream suspension are implemented and
  component tested, with real-browser runtime acceptance still open (D99).
- Hyperliquid account state is wired into the authenticated web session as a manually
  refreshed read-only panel and into the mobile non-demo perps route. Both clear data
  on wallet/session/lifecycle changes, and the mobile UI requires the authenticated
  session wallet to match the active local wallet. Relay is wired as an authenticated
  step preview only; neither panel permits order submission or transaction signing.
  Physical-device acceptance, Relay economics/fee rendering, separate Hyperliquid
  account linking, and live provider acceptance remain open (D95).
- Any deployed contracts, provider registrations, funded builder accounts or production writes.

The shared Redis interface now backs distributed one-time pairing, public price
cache/collector coordination and socket admission. PostgreSQL backs identity and
internal durable work repositories. These capabilities are implemented, but production
HA, failover, restore and mixed-workload capacity evidence remain open. Migrations remain explicit. Configured Redis
outages fail application operations closed; local pairing is only for the scaffold
without Redis. No environment flag enables absent financial provider adapters.
The old `/chains` table remains a theoretical specification, not deployment proof.

HTTP admission and the 16 MiB body-payload budget are per-process and cover
handler work through response creation. The body budget is reserved in 1 KiB
quanta before copying request chunks into the buffered body; declared lengths are
reserved before allocating the body buffer, while chunked traffic grows its
reservation as bytes arrive. Allocator, parser-value and transport-frame overhead
remain outside that payload budget, so deployment memory sizing still needs
headroom. Rejections return 503 and `Retry-After`; they do not queue unbounded
buffering work.
The price stream has a separate whole-socket budget and shared Redis quotas. These
do not replace edge DDoS controls or establish fairness for every feature. Incoming
bodies are buffered up to their configured cap; uploads need a separate design.

Application HTTP responses currently use `Cache-Control: no-store`. CORS preflight
is handled outside the application envelope; CORS also decorates runtime errors
so browser clients can read them. Future public market
routes should opt into reviewed cache rules rather than weakening private defaults.
Axum extractor-generated errors still have their existing formats; the common JSON
envelope covers AppError and runtime errors. Normalize extractor failures with the
upcoming request-validation contract rather than claiming complete OpenAPI parity.

## Local setup

The additional Compose file is independent of the existing application Compose
file. It uses fixed local-only credentials, ephemeral PostgreSQL storage and Redis
without persistence. It is a development fixture, not a production deployment.

```sh
docker compose -p honey-backend-dev -f compose.backend.yaml up -d --wait

DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:25432/honey?sslmode=disable' \
REDIS_URL='redis://127.0.0.1:26379' \
REQUIRE_INFRASTRUCTURE=true LOG_FORMAT=json \
cargo run -p honey-server
```

From another terminal:

```sh
curl -i http://127.0.0.1:8080/health
curl -i http://127.0.0.1:8080/ready
curl -i http://127.0.0.1:8080/api/v1/capabilities

TEST_DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:25432/honey?sslmode=disable' \
TEST_REDIS_URL='redis://127.0.0.1:26379' \
cargo test --locked --test infrastructure -- --ignored
```

For a recovery check, stop only this test project's Redis service. `/ready` should
become 503 within the next bounded probe cycle and `/health` remain 200. Restart
Redis; readiness should recover. Probes run every 5 seconds, with a default
1-second budget each, in parallel; cached probe results expire after 30 seconds.
Use SIGTERM to check bounded shutdown. Startup and operation logs must never show
either connection URL or its password.

```sh
docker compose -p honey-backend-dev -f compose.backend.yaml stop redis
docker compose -p honey-backend-dev -f compose.backend.yaml start redis
# Remove only these disposable local dependencies when finished.
docker compose -p honey-backend-dev -f compose.backend.yaml down
```

Production requires secret-managed credentials, verified TLS, private networking,
provider agreements and the later phases. Do not copy the local credentials,
`sslmode=disable`, ephemeral data storage or unauthenticated Redis into production.

## Implemented in P1

Read [IDENTITY-AND-DURABILITY.md](IDENTITY-AND-DURABILITY.md) for the staff-review
record: contracts, transaction boundaries, tradeoffs, failure semantics, local
commands and explicit remaining gates.

- Embedded forward migration for users, exact-chain wallet ownership, challenges,
  hashed/revocable sessions, auth quotas/audit events, operations and durable jobs.
- Explicit `migrate` and bounded `prune-auth` commands; no data-changing API startup.
- SIWE EIP-191 authentication, atomic single-use proof consumption, cross-replica
  revocation, wallet-scoped protected profile and structured auth errors.
- Redis TTL proof/profile quotas in runtime, with atomic PostgreSQL pair quotas for
  isolated/local fixtures; server-side statement/lock/idle-transaction timeouts and
  classified, credential-safe SQL error logs.
- Operation intent idempotency, versioned state transitions and transactionally
  committed jobs; exclusive claims, expiring leases, stale-worker fencing, retries
  with jitter and terminal failure. These are internal primitives, not live workers.
- Typed/validated shared auth methods, restricted sign-in message validator and
  working web review → browser signing → protected profile → sign-out flow.
- Account/network-change cancellation and revocation of late login responses.
- CI runs the real-service durability suite explicitly after ordinary tests.

Access sessions last 15 minutes. Server-side device-bound refresh families now
rotate atomically and revoke all family sessions on token reuse. Only originless
native requests receive refresh credentials; origin-bearing requests receive short-
lived access only, and refresh rejects Origin. Mobile stores refresh credentials through
the device-only secure-store adapter, rotates while foregrounded, and requires owner
confirmation plus profile verification to resume after background/lock. Extension
refresh remains disabled; its browser session is memory-only. The server accepts primary
`AUTH_ORIGIN` plus up to seven exact origins from `AUTH_ADDITIONAL_ORIGINS`; all must
also be in `CORS_ALLOWED_ORIGINS`. Origin-bearing challenges and verification bind to
the exact request origin and receive access-only sessions. Originless native clients use
the primary origin. See D103 and `IDENTITY-AND-DURABILITY.md`. The configured identity
chain does not establish trading or contract-wallet execution readiness.

Authenticated wallet management lists same-chain EOA memberships and adds a wallet
only with a fresh link-intent SIWE proof. Challenges bind to the live session and exact
origin, expire in five minutes, and are consumed transactionally; an address lock and
unique database constraint prevent cross-user claims. Identity merge, unlink, watch-only
and multi-chain links remain unsupported. See D104. PostgreSQL acceptance is in the
ignored durability suite and requires the isolated database environment.

## Verification record

Historical P1 verification for that implementation slice on 2026-10-18 (later
continuations changed this tree; current validation is recorded in the dated sections below):

- Full `pnpm lint && pnpm typecheck && pnpm test`: passed, including Biome,
  cargo fmt/clippy with warnings denied, all five TypeScript tasks and six test tasks.
  The earlier unrelated extension formatting blocker is no longer present.
- Real PostgreSQL durability suite: **7 passed**, explicitly run with `--ignored`.
  Tests create/migrate/drop unique databases inside an isolated disposable service.
- Shared API client: **20 passed**. Web: **7 passed**. Web production build: passed.
- Ordinary Rust suite: **30 passed**. Real infrastructure: **2 passed**, including
  server-side query cancellation and recovery. Together with durability, all **9**
  ignored real-service tests were explicitly run and passed.
- Independent Noble 2.4.0 SIWE fixture: verified by Rust, including hash/signature
  encoding and rejection of a changed statement.
- Built-binary HTTP smoke: schema-gated readiness, explicit migration, independent
  Noble proof, concurrent replay rejection, protected profile, persistence across
  API restart, logout, CORS/request correlation, secret-safe logs and bounded drain.
- Final `cargo audit --json`: **0 vulnerabilities, 0 warnings**, 257 dependencies,
  RustSec revision `999ec89d5d3f10f20be14750ec8c2d8b44e0ac9b`. PostgreSQL-specific
  feature selection removed unused MySQL/RSA from the lockfile; no advisory ignore.
- `git diff --check`: passed. No commits, deployment or production database writes.

The original P0 live outage smoke also passed: Redis stop caused readiness 503
while liveness stayed 200; restart restored readiness; SIGTERM drained within its
configured deadline; logs contained no connection URLs or test credentials.

Durability tests simulate worker crashes by expiring persisted leases, and inject
transaction failures using database constraints. They establish rollback/fencing
invariants, not OS-process kill coverage, managed HA failover, TLS correctness or
PITR. Browser tests mock the wallet provider; they do not certify real hardware
wallets. No benchmark establishes 10,000-user production capacity.

## Redis, public price and native identity continuation

- Distributed pairing with atomic write/read-once slots, TTL tombstones, global/IP
  capacity and no local fallback on Redis outage.
- One shared bounded Redis transport; fenced Hyperliquid collector with shared poll
  budget/backoff, exact decimal strings and explicit USDT contract price units.
- Full-snapshot HTTP/WebSocket contract, latest-value coalescing, local/shared socket
  caps, heartbeat, bounded send/read sizes, stale handling and drain.
- Shared validated stream client with local freshness, sequence handling, jittered
  reconnect and cleanup. Web live price display; native non-demo Perps uses the
  public feed without demo charts/positions, pauses on blur/background.
- Native Settings sign-in screen, independent app origin/chain, full SIWE review,
  local owner confirmation/signature, protected profile, secure refresh rotation,
  foreground suspension and resume. Extension refresh remains disabled on Origin-bearing
  requests under the server response boundary.
- CI includes real Redis/WebSocket tests. Reproducible load and upstream smoke examples.

Design/protocol: [REDIS-AND-PRICES.md](REDIS-AND-PRICES.md). Decisions D24–D29 in
[DECISIONS.md](DECISIONS.md). Native session details extend
[IDENTITY-AND-DURABILITY.md](IDENTITY-AND-DURABILITY.md).

Historical verification for the Redis/price slice on 2026-10-18 (subsequent
continuations add auth and worker changes):

- At that point, `pnpm lint && pnpm typecheck && pnpm test` passed, including the native
  price-screen integration and extension production export.
- Real-service suites: **14 passed** (7 durability, 2 infrastructure, 3 Redis
  application, 2 price streams), explicitly run with `--ignored`.
- Native secure-session controller: **8 focused tests passed**, including background
  suspension, owner-confirmed resume, cancellation, late-response races and explicit
  forget/revocation. Current workspace test totals are captured in turn validation output.
- Live public upstream smoke passed through actual collector → Redis → local mirror,
  with BTC/ETH/SOL validated. No signatures or financial submission.
- Local **10,000 sockets, 60-second soak, zero unexpected disconnects/HTTP errors**;
  600,000 price frames and 5,782 HTTP reads during soak. See
  [CAPACITY-LOCAL.md](CAPACITY-LOCAL.md) for metrics and exact limitations.
- RustSec audit: **0 vulnerabilities, 0 warnings**, 289 dependencies, database
  revision `999ec89d5d3f10f20be14750ec8c2d8b44e0ac9b`.
- Extension production export passed as part of the test pipeline. Existing Metro
  Noble subpath fallback and NO_COLOR warnings are not native device verification.

## Next implementation slices

1. Complete native/extension authentication boundaries and physical-device/browser
   acceptance; add user-visible device revocation. Same-chain EOA wallet
   listing/linking is implemented under D104; cross-chain and smart-account linking
   remain out of scope.
2. Complete NEAR Intents deposit execution, durable settlement/refund reconciliation
   and independent signing acceptance; implement Relay behind confirmed provider
   semantics and durable ownership.
3. Add Hyperliquid perps and Polymarket trading only after signed-order, eligibility,
   builder-fee, custody and reconciliation contracts are verified; current feeds/catalog
   do not authorize execution.
4. Finish production provider activation evidence, queue operations, dashboards/alerts,
   N-1 and mixed-workload capacity, provider quota evidence and restore drills
   and rollout checks before enabling financial capabilities or claiming 10k users.

Review the open decisions register before selecting provider credentials, launch
chains/countries, product registries or fee recipients. Those cannot be inferred
from demo UI labels or generated by implementation convenience.

## Exported observability continuation

- Separate optional OpenMetrics listener; route/method/status counters and latency,
  active HTTP/socket gauges, Redis/provider outcomes, pool/dependency/freshness,
  connection closes and telemetry-export failures with bounded labels.
- Explicit optional OTLP HTTP/protobuf export with 10% default head sampling,
  bounded queue/batches/response/deadlines, no application retries, no untrusted
  remote parent or baggage. Request ID and trace ID correlate safe logs and spans.
- Internal identity/work/Redis/provider spans omit arguments; socket lifecycle has
  connection correlation without high-cardinality metrics. Dependency logs and
  arbitrary panic payloads are excluded. Shared client exposes ApiError.traceId.
- Required API background tasks are supervised; unexpected exit drains the server
  and returns an error. This does not implement the durable financial job worker.
- Disposable pinned collector, Jaeger and Prometheus stack; six candidate alerts,
  rule behavior tests and CI configuration checks. Query/runbook documentation is
  included; no Grafana dashboards or paging receivers are provisioned.

Design, configuration, queries and limitations: [OBSERVABILITY.md](OBSERVABILITY.md).
Engineering tradeoffs: D30–D32 in [DECISIONS.md](DECISIONS.md).

Verification on 2026-10-18:

- `pnpm lint && pnpm typecheck && pnpm test` passed across the shared workspace.
- Real-service suite: **15 passed**, including actual OTLP protobuf correlation,
  private-field omission, remote-parent rejection, HTTP-200 partial rejection and
  collector outage isolation.
- Real Prometheus scrape + Jaeger HTTP/Redis parent-child trace + redacted JSON logs
  verified against the pinned local containers. Collector/config/rule checks passed.
- API SIGINT smoke drained and exited successfully with telemetry enabled.
- Instrumented **10,000 sockets / 60 seconds / 600,000 soak frames / zero unexpected
  disconnects or HTTP errors**. HTTP p95 2.459 ms, p99 27.950 ms; combined process
  RSS ~1.39 GiB. Same-process synthetic public feed, no TLS/DB/trading workload; see
  [CAPACITY-LOCAL.md](CAPACITY-LOCAL.md) for raw output and scope.
- RustSec audit: **0 vulnerabilities, 0 warnings**, 304 dependencies, database
  revision `999ec89d5d3f10f20be14750ec8c2d8b44e0ac9b`.

The full backend goal remains open. Financial provider reads/quotes/execution and
reconciliation, refresh/device sessions and verified production mixed-load/N-1
capacity remain work; implemented telemetry does not make those capabilities live.

## First Earn provider readers

Aave V3 GraphQL reserve and Morpho Vault V2 REST config/state/APY readers now validate
actual public provider responses. They preserve exact units and nullable data,
reject identity/version/decimal mismatches and partial GraphQL errors, and use
bounded fixed-origin transport with shared Redis spacing/cooldowns. Live public
smoke passed for both providers without any signing or financial request.

These readers now feed the cached catalog API and web/native views described below.
Earn execution still requires the approved product registry, RPC validation,
persisted preparation, signing and durable reconciliation.

Design, tests, fixtures, measured read output and next gates:
[EARN-READERS.md](EARN-READERS.md); decisions D33–D35. Verification passed: `pnpm lint && pnpm typecheck && pnpm test`, five new ordinary
provider tests and one explicit isolated Redis/upstream transport test. Both live
public reader smokes also passed. No provider transaction or signed write occurred.

## Cached Earn catalog and frontend delivery

- Explicit max-eight public read registry through EARN_READ_TARGETS; Redis required,
  no default products, no transaction/fee switches. Duplicate/malformed targets fail startup.
- Shared 30-second fenced refresh lease, 60-second refresh spacing, ten-minute cache
  retention, five-second replica mirror. Monotonic local age cannot be reset by
  rereading the same sample. Two-minute freshness budget, explicit stale/unavailable.
- GET /api/v1/earn/catalog reads local snapshots under the common HTTP envelope;
  no request-triggered provider IO. Cached payloads preserve exact JSON arrays/values.
- Shared client validates identities/units/execution=false, ages and expires data,
  bounds polling lifetime/deadline and ignores cancelled responses.
- Web catalog and non-demo native/extension Savings, Earn and Savings Add use public
  market observations. Demo charts, jar balances and simulated deposit flows are
  confined to demo-wallet routes on those screens. Real positions and jar execution
  are still unavailable. Foreground/focus/visibility cleanup stops polling.
- Two real API replicas + public providers + Redis smoke passed; 100 cached HTTP
  reads left provider-call counters unchanged. Replica fencing, stale/expiry, JSON
  round trip and tampered-cache tests passed; shared-client and web lifecycle tests
  cover cancellation/late responses/deadlines and hidden-page cleanup.
- Verification: full workspace lint/typecheck/test, isolated Redis catalog tests,
  public two-replica smoke and web production build passed. The shared client also
  accepts the exact captured Aave/Morpho API payloads (29 client tests total).

Design, operational limits and remaining gates: [EARN-CATALOG.md](EARN-CATALOG.md).
Decisions D36–D37. This does not enable deposits, withdrawals or prove Earn capacity
for 10,000 active users. Physical native-device acceptance remains a release gate.

## Immutable transaction preparation and recovery

Migration `202610180002` adds immutable canonical intent and EVM plan evidence.
New operation creation commits intent + operation + job atomically. A typed bounded
single-chain plan binds membership/chain/signer, intent, policy revisions, fees,
call bundle, simulation block and expiry. Preparation requires a live versioned job
lease and commits plan + operation version + job acknowledgement + successor together.
Generic transitions can only reject an unprepared intent, never assert submission/success.

GET /api/v1/operations/{id} provides principal-and-wallet-scoped recovery metadata,
expiry and exact version, with executionAvailable=false. The shared client validates
that contract and response identity. Legacy digest-only records remain readable but
cannot be prepared. Hash corruption and wrong ownership fail closed. New migration
readiness is required with auth; no startup migration runs.

This is persistence and status plumbing, not actual provider preparation, signed
payload verification, attempt tracking, dispatch or reconciliation. No public create,
prepare or submit mutation is exposed; no UI displays synthetic transaction success.
Design, test matrix, limits and migration rollout: [PREPARATION-AND-RECOVERY.md](PREPARATION-AND-RECOVERY.md), decisions D38–D40.

Verification passed: `pnpm lint && pnpm typecheck && pnpm test`; 15 real PostgreSQL
preparation/durability tests and 8 existing real-service infrastructure, Redis,
WebSocket and trace regressions. Shared-client suite: 32 passing tests.

## Aave preparation, signed-envelope verification and local contract execution

Internal Aave EOA supply/finite-withdraw adapter now validates reserve identity,
balances, allowances and nonce, simulates ordered calls, bounds fees and emits an
expiring immutable plan. Independent Rust EIP-1559 validation checks actual Honey
keyring signatures against every planned call and the aggregate fee ceiling.

A disposable Ethereum fork successfully executed approval, 1 USDC supply and
0.9 USDC withdrawal, with verified hashes, receipts and balances. It caught an
inherited delegated-account fixture and one-unit aToken rounding. The public test
key and all balance/code modifications were confined to local chain 31337 and
reverted. See [AAVE-EXECUTION.md](AAVE-EXECUTION.md) for reproduction, captured evidence,
dependency/audit tradeoffs, compatibility limits and decisions D41–D43.

This advances the earlier persistence-only milestone but does not expose live
execution. The fork driver bypasses API/database orchestration; real operation
submission, nonce coordination, encrypted attempts, reconciliation and frontend
review/sign/status integration remain unfinished. Other providers and production
10k mixed-workload verification remain on the original roadmap.

Verification for this milestone: full workspace lint/typecheck/test passed; four
Aave regressions, four envelope regressions, and the final actual-contract fork
smoke passed. No existing database was migrated; no production transaction was sent.

## Durable signed authorization and dispatch intent

Migration 3 adds encrypted signed transaction evidence, unique nonce slots, a persistent
wallet guard and immutable dispatch/observation records. Acceptance atomically advances
to `signed`; a live fenced lease journals the first dispatch before returning bytes,
advances to `unknown` and creates reconciliation work. RPC acknowledgement never marks
success. Key rotation/restart, ownership, races, rollback and expiry are tested.

Owner-scoped recovery now includes ordered transaction hashes and the `signed` state;
shared client validation is updated. Execution remains unavailable: no public submit,
actual broadcaster, later-step dispatch, receipt reconciliation or guard release exists
in this slice. Details, constraints, key management and design D44–D46:
[SIGNED-SUBMISSIONS.md](SIGNED-SUBMISSIONS.md).

Verification: full workspace lint/typecheck/test; 6 submission + 17 existing real-service
regressions; independent Noble encryption vector and tamper tests. All passed. RustSec:
0 vulnerable packages, 2 pre-existing unmaintained warnings, 467 lockfile packages.

## Canonical receipts, finality and sequential Aave execution

Migration 4 adds immutable observation batches and a fresh checkpoint projection.
Contexts are reconstructed from verified encrypted bytes. RPC collection checks chain,
canonical transaction inclusion/order, exact receipt fees, prior finalized checkpoint
continuity and reorgs during reads. Fenced persistence separates inclusion, uncertainty
and full-bundle finality. Later-step dispatch requires successful canonical predecessors;
only finalized outcomes for every signed slot release the wallet guard. Unchanged healthy
polls refresh current proof without growing history or operation version.

Owner recovery and the shared client expose/validate per-transaction receipt metadata.
The actual Aave fork smoke now includes PostgreSQL intent/preparation, encrypted signed
acceptance, journaled sequential dispatch and receipt settlement. Both supply and
withdrawal reached Succeeded after explicitly mining Anvil's observed 64-block local
finality lag. The shared client validated both backend recovery responses. This is
simulated local finality, not production consensus or frontend HTTP acceptance.

Evidence, repro, tradeoffs and limits: [RECEIPT-RECONCILIATION.md](RECEIPT-RECONCILIATION.md),
D47–D49. Public mutations, actual broadcaster/worker supervision, fresh pre-send orchestration
and frontend signing/status screens remain open. Other providers and 10k mixed-load
verification remain on the original full-scope roadmap.

Verification for reconciliation: full workspace gates; 28 real-service regressions;
actual-contract/database fork smoke and shared-client validation all passed. Owned
Anvil was stopped; its test database was dropped. No production funds/deployment.

## Aave authenticated API and local worker integration (2026-10-18)

Typed create/signing-request/submit endpoints, atomic immutable nonce/gas/fee terms,
supervised local-fork dispatch/reconciliation, explicit DEK-file configuration and native
review/sign/status are implemented. This supersedes the previous paragraph's missing-API/worker
status for the local fork only. Production capabilities remain disabled. See [AAVE-API.md](AAVE-API.md)
for complete contracts, tradeoffs, tests, operational bounds and remaining frontend/launch gaps.
Decisions D50–D52 record the implementation choices.

## Operation discovery and restart recovery (2026-10-18)

Owner-scoped keyset history, typed immutable Aave-intent recovery, native Activity/Savings
discovery and web signed-in history are implemented. Index migration6 is explicit and
concurrent; auth readiness checks it. Native can reopen an unexpired unsigned Aave request
for a new review, while submitted/unknown work only recovers status. See
[OPERATION-HISTORY.md](OPERATION-HISTORY.md), query evidence and D53-D55. This does not add
an external on-chain activity indexer, offline history or production capacity proof.

Verification for operation discovery: `pnpm lint`, `pnpm typecheck` and `pnpm test`
passed; shared client 40, web 12 and mobile 62 tests passed (6 optional WalletConnect
E2E tests skipped). The final disposable-service regression run passed 33 tests across
preparation/history, submission, durability and infrastructure. Captured HTTP/fork evidence
confirms supply and withdrawal, restart discovery and history with execution disabled.
The harness reverted the fork and dropped its database; the owned Anvil process was stopped.
Production provider execution and mixed 10k-user capacity remain unfinished.

## RPC account coordination and Aave implementation pins (2026-10-18)

Aave now requires explicit implementation address/code pins for its pool, USDC and
aToken and checks them at the same source block during preparation and pre-send.
The service uses Redis account admission across instances, weighted simulation cost,
shared cooldown/hold state and fixed-label RPC metrics. Redis is now a required
Aave execution dependency. A single-use broadcast permit is reserved before journaling
to avoid creating ambiguous attempts merely because the account budget is busy.

Design, configuration migration, tradeoffs and remaining launch evidence:
[RPC-AND-CONTRACT-IDENTITY.md](RPC-AND-CONTRACT-IDENTITY.md), D56–D58. No production
execution capability or new frontend response field is enabled by these changes.

Verification: full lint/typecheck/test gates, 37 real PostgreSQL/Redis regressions and
six preparation tests passed. The actual API/worker local-fork supply and withdrawal
acceptance run passed with all implementation pins and Redis admission enabled,
including restart recovery. Captured evidence is linked in the design note. The owned
fork was reverted/stopped, its database/config/budget keys removed. No new dependencies,
production deployment, production registry approval or production capacity claim.

## Morpho execution and shared Earn engine (2026-10-18)

Morpho Vault V2 now supports exact-asset deposits with a contract share-price bound
and exact-share redemptions with explicit acknowledgment of unprotected output.
Contract/configuration pins, finite allowances and sequential simulation feed the
shared durable Earn engine. The authenticated quote/intent/signing/submission APIs,
typed client and native Savings quote/review/sign/status/recovery flow are connected.
The native signing boundary shares session/key-lifetime protection with Aave and
retains independent protocol calldata verification.

Migration 7 renames the immutable signing table, trigger and index. Old binaries
must be drained first; no canonical payload/hash rewrite occurs. Deployment remains
local-fork-only. Source research, decisions D59–D62, configuration, contract caveats
and reproduction are in [MORPHO-EXECUTION.md](MORPHO-EXECUTION.md).

Verification: full workspace lint/typecheck/tests and 37 disposable PG/Redis service
regressions passed. Actual-contract HTTP acceptance completed a 1 USDC deposit and
exact-share redemption through SIWE, both enabled provider workers, restart recovery,
encrypted staging and local finalized receipts; captured evidence is linked above.
Client tests mutate every authority-bearing action word; native tests check consent,
key wiping, session changes and review snapshots. Real-device UX, production
activation and full wallet/positions integration remain unverified. No production
funds, deployment or capacity claim.

## Uniswap quote integration (2026-10-18)

Authenticated same-chain CLASSIC quote transport, bounded shared account admission,
strict response/Permit2 inspection, exact fee/net/minimum output validation and
public nonsecret configuration are implemented. Typed web/native forms bind results
to session, input and policy and clear stale quotes. The live native form does not
use demo prices or demo swap controls. Permit2's unlimited amount sentinel is rejected.

[UNISWAP-QUOTES.md](UNISWAP-QUOTES.md) records the selected official API schema/hash,
configuration, decisions D63–D65, limitations and ordered execution handoff. No
Trading API key has been supplied and no authenticated upstream acceptance has run.
No calldata/permit leaves the quote endpoint; swap execution remains unavailable.
Rust mutation tests, real disposable PostgreSQL HTTP admission and mock HTTP/Redis
transport regressions pass. These are local/synthetic evidence only.

Final verification for the quote milestone: `pnpm lint`, `pnpm typecheck` and
`pnpm test` passed. The suite needed loopback permission for existing mock RPC
listeners. The opt-in Uniswap PostgreSQL admission test and five Rust quote tests
(including mock HTTP/shared Redis transport) were run separately and passed.
No production service or authenticated Uniswap endpoint was exercised.

## Uniswap router and permit authority groundwork (2026-10-18)

Independent Rust/TypeScript canonical ABI decoders now cover the pinned 2.1.2 V2/V3
six-field commands and V4 exact-input/settlement/payment actions. Fixed PermitSingle
reconstruction, exact quote/wallet binding, EOA digest/recovery and unique leading
embedded-permit checks are implemented. Signed decoder models cannot be logged or
serialized through production derives; Rust owns zeroizing signature buffers.

Five viem-generated router fixtures, 28 rejection cases, word-boundary truncation
checks and an independent EIP-712 signature vector establish local parser/proof
behavior. [UNISWAP-AUTHORITY.md](UNISWAP-AUTHORITY.md) and D66–D67 explain the pinned
sources, safety boundary, evidence and next implementation steps. This does not add
an API signing endpoint, durable swap execution or provider acceptance. Ordered
spend/fee/refund/output validation across mixed protocols remains essential.

Verification for router/permit groundwork: full `pnpm lint`, `pnpm typecheck`
and `pnpm test` passed (API client 53, native 68 plus 6 optional skipped tests,
web 14). Rust runs include canonical-decoder parity, embedded authority and EIP-712
recovery regressions. Only pure helpers and synthetic fixtures changed here; no
new database migration, dependency, production activation or capacity result.

## Uniswap ordered economic verification (2026-10-18)

Server and wallet now independently verify complete CLASSIC router calls against
immutable token spending/receive/deadline/fee authority. Split and mixed V2/V3/V4
flows, possible V3 refunds, V4 open debts and sequential fixed/percentage fees are
modeled. Fee basis is explicitly settlement balance; any per-recipient one-base-unit
rounding allowance must be explicitly reviewed. The shared quote-to-authority helper
preserves exact strings, deadline and policy copies. zkSync quote configuration now
rejects the unsupported pinned 2.1.2 router version.

Sixteen accepted and forty rejected viem-encoded cases exercise both verifiers;
a separate concrete four-fee evaluation covers 150,001 gross balances. Design,
proof assumptions, conservative flow limits and source evidence are in
[UNISWAP-ECONOMICS.md](UNISWAP-ECONOMICS.md), D68–D69. This does not enable signing,
provider execution or production capabilities. Actual-contract acceptance and
authenticated Trading API builds remain unverified.

Verification for economic validation: full `pnpm lint`, `pnpm typecheck` and
`pnpm test` passed. Both independent verifiers accept the same 16 fixtures and
reject the same 40 mutations; the four-recipient fee stress checks also passed.
These results establish local validation behavior, not live provider acceptance
or production capacity. No signing or production execution was enabled.

## Uniswap actual-contract acceptance (2026-10-18)

Seven actual-router 2.1.2 scenarios pass on the pinned disposable Ethereum fork:
V2/V3/V4 direct swaps, V3 two-recipient fees, V4 fees, prepaid V3 cleanup and a
V2/V3/V4 split with aggregate fee settlement. Independent client/server economic
and Permit2 proofs agree; actual receipt balances, fee bounds, zero residuals,
finite approvals and exact InvalidNonce replay rejection are checked. Expired
deadlines, corrupted signatures and an unfillable minimum revert on-chain.

[UNISWAP-CONTRACT-ACCEPTANCE.md](UNISWAP-CONTRACT-ACCEPTANCE.md) and D70 record
reproduction, captured evidence and limits. Full `pnpm lint`, `pnpm typecheck`
and `pnpm test` passed. The driver reverted all fixture state; no database change,
new dependency or production activation. Authenticated provider builds, encrypted
permit/build persistence, service/worker execution and native signing remain open.

## Encrypted built-swap preparation storage (2026-10-18)

Complete Uniswap signing requests now use authenticated encryption, immutable
owner/operation/plan binding and public-only recovery summaries. Plaintext swap
preparation persistence/loading rejects. Existing submission and reconciliation
repositories open sealed records with retained application keys; signed acceptance
also checks the exact persisted nonce, gas and fee terms. Earn uses the shared
exact-term helper and keeps its existing immutable representation.

Migration 8 adds mutually exclusive sealed columns without rewriting existing Earn
records; authenticated readiness requires it. Only disposable test databases were
migrated. Router-size bounds now propagate through swap plans, storage and signed
envelopes; other providers retain their smaller bounds. Details and tradeoffs:
[SEALED-SWAP-PREPARATIONS.md](SEALED-SWAP-PREPARATIONS.md), D71–D72.

Verification: full `pnpm lint`, `pnpm typecheck`, `pnpm test` passed, plus 41 tests
across preparation, sealed-preparation, submission and durability suites with
disposable PostgreSQL enabled. Seven new database tests and two pure tests cover
rollback/concurrency, rotation/restart, exact-term rejection, ambiguous-send guards,
tampering/substitution, expiry, large payloads, HTTP redaction and populated-schema
migration. CI includes the new database suite. No dependencies or client response
types changed. Pre-build permit lifecycle, authenticated provider builds and the
Uniswap HTTP/worker/native signing flow remain unfinished and disabled.


## Pre-build swap reviews and permit admission (2026-10-18)

Immutable public authority and encrypted raw quotes now precede signature admission.
Exact PermitSingle signatures are encrypted with owner/operation/review/version
binding, and accepted atomically with a scoped nonce reservation and build job.
Exact retries return current metadata without replacing signatures or renewing
expiry. Expired unused nonce reuse requires fresh RPC evidence and a finalized
chain timestamp past the inclusive signature deadline. Detailed scope, limits,
state transitions and service obligations: [SWAP-PERMIT-LIFECYCLE.md](SWAP-PERMIT-LIFECYCLE.md), D73–D74.

Migration 9 adds the evidence tables/guards and pre-build states; authenticated
readiness requires it. Client recovery validators and native history labels know
these states without exposing transaction signing. No existing data rewrite or
production/shared database migration. No new dependency or provider activation.

The repository does not yet expose a swap review/permit HTTP endpoint, consume its
build jobs, or advance a reviewed build into sealed preparation. Authenticated
Trading API acceptance, fresh RPC observation production, simulation, reviewed
preparation admission and native signing remain the next integration work.

Verification: full `pnpm lint`, `pnpm typecheck` and `pnpm test` passed. The test
command was rerun with loopback access after the restricted sandbox denied existing
mock listeners. All 49 tests across durability, preparation, sealed preparation,
submission and swap-review suites passed with disposable PostgreSQL enabled. The
new suite has one pure and seven database tests; CI includes it. Test databases
were dropped by their harnesses. These checks do not establish provider acceptance,
physical-device behavior or production capacity.


## Uniswap quote artifacts and build transport (2026-10-18)

Validated quote artifacts now retain exact raw quotes and normalized permit terms
for immutable review creation. Internal build transport reconstructs the fixed
PermitSingle schema from persisted authority, sends the exact signature and reviewed
deadline, and shares quote admission/cooldown. Returned calls independently pass
router, embedded-permit and economic checks; provider gas hints stay separate from
local preparation. Private build result fields preserve provenance without exposing
signed calldata through public APIs or diagnostics. Details, source hash, request
policy and compatibility limits: [UNISWAP-BUILDS.md](UNISWAP-BUILDS.md), D75–D76.

No migration, dependency or public response type change. No live credentials or
production provider response were used. Fresh RPC admission, local simulation and
reviewed build-to-preparation persistence, worker/HTTP/native flows and authenticated
provider acceptance are still required before swap execution is available.

Verification: full `pnpm lint`, `pnpm typecheck` and `pnpm test` passed. Sixteen
Uniswap checks passed with the two opt-in Redis/HTTP transport tests enabled, plus
eight swap-review tests with disposable PostgreSQL. New coverage includes five
pure build tests and one mock transport test; the response boundary accepts all
16 existing supported no-permit route fixtures. CI includes Uniswap transport
coverage. This evidence is local and synthetic; authenticated provider acceptance
and end-to-end service/native execution remain unverified.


## Uniswap chain observations and local preparation (2026-10-18)

The internal Ethereum preparer now validates registry/code/proxy identity, EOA and
nonce state, source/finalized blocks, balances and both allowance layers. It builds
finite reset/approval steps when needed and simulates them with the verified swap,
checking owner/output/fee/router balance changes and final Permit2 state. Exact
nonce/gas/fee terms retain the immutable review expiry and private build provenance.
Details and constraints: [UNISWAP-PREPARATION.md](UNISWAP-PREPARATION.md), D77–D78.

This new path has mock RPC coverage only; the previous router fork evidence is not
evidence for this preparer. Reviewed durable persistence, HTTP/worker/native signing,
pre-dispatch revalidation and actual-contract preparation acceptance remain open.
No migration, production registry, public API response change or new dependency.

Verification: full `pnpm lint`, `pnpm typecheck` and `pnpm test` passed. Five new
pure/local-RPC tests cover the preparation and adverse-state paths, including a
positive output below the minimum and wrong final Permit2 amount/expiration. Empty
approval returns require an explicit token-registry opt-in. No live provider or
actual-contract preparation test ran in this milestone. Local preparation is still
separate from the unfinished durable signing transition and user-facing swap flow.


## Uniswap reviewed preparation persistence (2026-10-18)

The private RPC-prepared result now advances `building_swap → awaiting_signature`
under the existing job/operation fences. A version-2 encrypted envelope preserves
review hash and build request ID with the exact prepared calls. Persistence and keyed
recovery authenticate the review, quote and admitted signature and recheck plan/call
binding. State, evidence, job completion and successor commit together; late lease,
expiry or simulation-age failure rolls back. The signing-evidence loader returns the
original review alongside the preparation. Legacy encrypted preparations remain
readable only without review rows. Details: [UNISWAP-PREPARATION.md](UNISWAP-PREPARATION.md#reviewed-durable-handoff), D79.

No migration, dependency or public response change. Old readers must drain before
writing version-2 envelopes. HTTP/worker/native wiring and actual-contract acceptance
of this preparation lifecycle are still unfinished; no execution capability enabled.

Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test` and `git diff --check`
passed. Ten Uniswap preparer/persistence tests passed with opt-in PostgreSQL tests
enabled, including five new durability cases. Forty-nine existing preparation,
review, submission and durability tests also passed with isolated databases. CI
runs the new opt-in suite. This is mock-RPC/database evidence, not actual-contract
preparer acceptance or a completed user flow.


## Uniswap local service and native signing (2026-10-18)

Authenticated swap intent/review/permit/signing/submission routes and a supervised
service-owned worker now connect the reviewed lifecycle. An explicit localhost/
chain-31337 fixture mode keeps normal Trading API configuration and real funds
separate. The worker reconstructs the saved call for preflight and uses existing
journaled dispatch/reconciliation. Shared client types and independent economics/
permit/approval validation support native permission and transaction confirmations,
foreground/session fencing, offline permit verification and history reopening.
Details, configuration, tradeoffs and evidence limits: [UNISWAP-SERVICE.md](UNISWAP-SERVICE.md), D80–D81.

The new service has synthetic HTTP-to-signed-admission evidence. Actual-contract
preparer/service dispatch/finality, physical-device behavior, web/extension execution
and production acceptance remain unverified. No dependency, SQL migration, production
activation, credential, real-funds transaction or deployment was introduced.

Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test` and `git diff --check` passed. Targeted checks passed: one HTTP/worker signed-admission test with isolated PostgreSQL/Redis, eleven preparer/persistence tests, thirty-five durability/review/submission regressions and twelve transport tests. Shared client tests passed (63); native tests passed (73, with six existing optional WalletConnect skips). These checks do not establish actual-contract service dispatch or finality.


## Uniswap actual-contract service acceptance (2026-10-18)

The new reproducible HTTP fork harness completed a real V3 USDC/WETH swap through
SIWE, immutable review, Permit2 admission, actual RPC preparation, independent client
validation/keyring signing, encrypted submission, sequential worker dispatch and
finalized receipt recovery. Restart before signing and after submission preserves
the original artifacts. A second run paid two bounded 100-bps fees and recovered
a deliberately lost successful broadcast response with each signed hash sent once.
An unfillable provider minimum failed actual simulation before any preparation or
submission, preserving balances, allowances, nonce and review. No production code
relaxation was needed. Evidence and reproduction: [UNISWAP-SERVICE-ACCEPTANCE.md](UNISWAP-SERVICE-ACCEPTANCE.md), D82.

Each run restored the owned fork snapshot and removed its disposable database.
Production acceptance, other route/fault/device coverage and the full backend
roadmap remain unfinished.

Verification: all three actual-contract scenarios passed. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `git diff --check` passed. The owned Anvil process was stopped; the disposable databases and exact leftover test quota policies were removed. No production transaction, deployment or commit was performed.

## Relay advisory recovery (2026-10-18)

Fixed-origin provider readers validate status identity, chains, source hash and
bounded candidate transactions. Redis admission/cooldowns, request/body deadlines,
static error labels and secret-safe metrics bound provider access. PostgreSQL
migration 10 adds immutable watches, fenced leases and latest observations; an
owner-authenticated read returns stored results without calling the provider.
Web/native history and the shared validator keep provider reports distinct from
source finality and destination/refund confirmation. D83–D84 and
[BRIDGE-RECOVERY.md](BRIDGE-RECOVERY.md) record contracts, limits and the execution plan.

No public bridge command creates an attachable signed source bundle yet. Quote,
deposit execution, source-event identity, verified destination/refund settlement,
terminal-proof polling retirement and actual device/provider acceptance remain
unfinished. Tests seed relational metadata and synthetic provider replies; they do
not prove a valid signed bridge preparation or transfer. Runtime readiness now
requires migration 10; only disposable test databases were migrated here.

Verification: `pnpm lint`, `pnpm typecheck` and `pnpm test` passed. The ordinary
suite required loopback permission for existing RPC fixture listeners. Provider
tests passed (5 including Redis/HTTP); monitor tests passed (3 including PostgreSQL
and authenticated recovery); existing opt-in durability/preparation regressions
passed (20). Shared-client and web suites include advisory status validation and
source-success/destination-pending regression coverage. CI runs both opt-in bridge
suites. No production credentials, funds, deployment, commit or base DB migration.

## Required worker supervision behavior

Required background task handles are selected together by `supervision::watch`.
Any unexpected normal return, panic, or cancellation increments a bounded
`honey_background_failures_total{outcome=...}` counter, revokes readiness, marks
the process draining, and causes the server to drain before exiting nonzero. Panic
payloads are deliberately not logged: dependency panic messages may contain
connection details. A regression test now exercises panic classification,
readiness revocation, metric emission, and absence of panic text in metrics. This
does not provide per-worker names in metrics (the log currently contains startup
index), restart-in-place, or an external dead-job dashboard; those remain
operational follow-ups. Shutdown still relies on bounded HTTP drain followed by
task cancellation, with durable leases and reconciliation handling interrupted
work.

## Disposable database/Redis acceptance sweep (2026-10-18)

The full opt-in server test set was run with
`TEST_DATABASE_URL=postgres://honey:honey_local_only@127.0.0.1:25439/honey` and
`TEST_REDIS_URL=redis://127.0.0.1:26389` against an isolated Compose project. All
ignored server tests passed: provider/bridge/queue service tests; authentication
and worker durability;
PostgreSQL statement timeout/readiness; preparation/history, price WebSocket and
Redis pairing; RPC budgets; sealed signing/submission/reconciliation; and real OTLP
export. Monitor acceptance passed 3 PostgreSQL-backed cases.

This validates the current local fixtures and process-level invariants. It does
not prove provider credentials, mainnet execution, external worker/relayer behavior,
browser/mobile hardware acceptance, managed database/Redis failover, or production
mixed-workload capacity. The temporary Compose project was removed after the run;
no migration was applied to a shared or production database.

## Refresh-token groundwork and strict 10k local price gate (2026-10-18)

Added migration `202610180012_refresh_families.sql`, opaque 30-day refresh families,
one-active-access-session enforcement, single-use token rotation, device-ID matching,
family revocation on replay/logout, and bounded expiry cleanup. Only originless
requests receive refresh credentials; Origin-bearing sign-in receives access-only
and Origin-bearing refresh is rejected. The shared API client includes device ID and
refresh methods. Mobile secure refresh and extension access-only sign-in UX are now
implemented; the extension deliberately stores no access credential beyond the live
popup process and has no refresh token.
The design and tradeoffs are recorded as D89 in `DECISIONS.md`.

Verification: all eight ignored PostgreSQL durability tests passed against the
disposable local fixture, including rotation/replay revocation and the browser
Origin response boundary; server library tests passed (68 passed, 25 ignored),
server clippy/fmt passed, workspace typecheck/lint passed, and API-client (82), web
(21), and mobile (78, six optional skips) tests passed. Separately, the corrected
strict 10k external generator passed exact request-count and zero-deadline-backlog
checks; measurements and explicit scope limits are in `CAPACITY-LOCAL.md`.

## Mobile secure refresh lifecycle (2026-10-18)

The mobile backend session stores the refresh family via `secure-store` (Keychain /
Keystore, device-only accessibility), never persists the short access bearer, and
rotates before access expiry while foregrounded. Background and app-lock events
suspend the access session but retain the secure refresh record. Resume UI requires
local owner confirmation, active-wallet and server-config matching, rotation, and a
protected-profile read before restoring the in-memory access token. Account changes
immediately invalidate the bearer, clear local refresh state, and attempt best-effort
family revocation. Explicit sign-out and “Forget saved session” remove local refresh
state and attempt revocation. D90 records the tradeoffs.

Focused mobile session tests cover key removal/wiping, refresh rotation, background
suspension, owner-confirmed resume, and profile validation. This is simulator/unit
evidence only; iOS Keychain and Android Keystore behavior, locked-device availability,
background transitions, and extension auth against a packaged build/backend configured
for the exact installed extension origin still need release acceptance. The extension
uses the browser password prompt after displaying the challenge, and access ends after
15 minutes or when the popup backgrounds. Multi-origin SIWE policy is documented in D103.

## Current validation update (2026-10-18)

Validation on the combined tree: `pnpm lint` and `pnpm typecheck` pass; `pnpm test`
passes all seven workspace tasks when run with the repository-supported Node runtime
(Node 25.2.1; six optional WalletConnect E2E tests remain skipped). Counts include 97
API-client tests, 21 web tests, 81 mobile tests, 27 extension tests, 46 keyring tests,
and 79 ordinary Rust unit tests; the extension production export also succeeds.
Disposable-service acceptance passed: 8 PostgreSQL durability tests, 3 Polymarket
Redis catalog tests, 3 Redis application tests, 2 price-stream/WebSocket tests, and
2 infrastructure tests. These are local isolated-service results, not production HA
or external provider acceptance. The repo's pnpm command initially resolved Node 20
from PATH despite requiring >=22.13; with `/opt/homebrew/opt/node@25/bin` first in PATH,
all workspace tasks passed. Local capacity remains a one-replica connection test and
does not establish distinct authenticated-user capacity. A later local mixed
profile did connect 10,000 public price sockets for a 60-second soak while
completing 6,000 authenticated `/api/v1/me` reads at 100 RPS with zero errors,
using one short-lived SIWE session; see the run ID and latency distribution in
[CAPACITY-LOCAL.md](CAPACITY-LOCAL.md). This still does not establish 10,000
distinct authenticated users, multi-replica/TLS capacity, or financial-operation
capacity.

## Validation update (2026-10-19)

The coordinated external generator now accepts a shared UUID run ID and future
Unix-millisecond start epoch, phases HTTP shards across the aggregate open-loop
schedule, records issue/completion counts for each soak second, and emits one
report per process. `aggregate_price_load_reports.py` fails closed on mismatched
epochs, missing/duplicate shards, per-second issue-rate loss, deadline completion
shortfall, generator errors/backlog, socket closes, or frame freshness failures.
Synthetic reducer tests and Rust scheduler tests pass. No new coordinated soak is
claimed here: Docker daemon access is denied in the current environment.

The server suite was rerun with all DB/Redis/loopback-gated tests enabled against
the disposable compose services: 108 library tests and all integration binaries
passed serially. This exposed and fixed a stale readiness test that invalidated
migration `202610180010` although runtime readiness now requires
`202610180012`. A fresh 4-principal SIWE profile smoke passed 20 reads at 2 RPS.

The revised independent generator then ran 10,000 public price sockets with 15
distinct SIWE principals. The best single-process run kept all sockets open, met
the 45-frame floor and completed 5,995 of 6,000 planned authenticated profile
reads with no errors or backlog, but skipped five scheduled slots; strict exact
100-RPS acceptance therefore remains open. A split-generator run passed the 10k
socket gate while a separate 15-principal process completed 5,988 of 6,000 profile
reads (99.8 RPS) with no errors/backlog. See the dated raw reports in
[CAPACITY-LOCAL.md](CAPACITY-LOCAL.md). These remain single-replica loopback results;
the API's production pool budget, TLS/edge topology, multi-replica failover and
10,000 authenticated identities still require separate validation.

Price-feed diagnostics now count Redis polling, snapshot publish/fencing, and
cross-replica mirror-read outcomes using fixed low-cardinality labels; structured
warnings identify lease and publish failures without logging payloads. The metrics
contract tests and real two-hub Redis/WebSocket tests pass. Remaining capacity evidence
is still open: the 10k-socket and 100-RPS profile diagnostics were split across runs,
and same-host generator scheduling missed exact request slots. A strict combined soak
needs independent API and generator hosts, a shared barrier/run ID, exactly 6,000
scheduled authenticated profile requests during the 60-second 10k-socket soak, zero
skipped slots/errors/backlog, and server/DB/Redis resource time series. Packaged
extension/browser acceptance still needs a real installed extension ID with matching
`AUTH_ADDITIONAL_ORIGINS` and `CORS_ALLOWED_ORIGINS` configuration.

The 2026-10-19 continuation added authenticated `/me` read limits, loopback-only
metrics binding, canonical idempotency validation, and extra Redis price-script
integration assertions for expired-owner fencing, sequence continuity, owner-bound
backoff and stale socket-lease reclamation. Mobile wallet-link cancellation now
invalidates in-flight approval before key access or submission; regression coverage
passes. The complete `pnpm lint`, `pnpm typecheck` and `pnpm test` commands pass, and
the ignored PostgreSQL durability, Redis price-stream and Redis application suites
pass against disposable local services. This is code/test evidence only; provider
release gates and the independent-host mixed-load acceptance above remain open.

Queue operations now publish due-ready, leased, expired-lease and dead-job gauges,
oldest ages and refresh health through the loopback-only metrics listener. A bounded
10,001-row probe runs every 30 seconds; new migration `202610190002` adds the
dead-job age index. Counts are saturated, shared across replicas, and contain no job
or wallet identifiers. This gives aggregate alerting only: there is still no audited
dead-letter inspection/replay endpoint or per-worker identity metric. The queue-state
PostgreSQL integration test and fixed-label/cap metrics tests pass. Provider retry
policies differ, so dead-job count does not represent every retrying provider task.

## Polymarket read-only CLOB book slice (2026-10-19)

Added a catalog-bound public order-book read API and web display. Honey accepts only
active, open Gamma `clobTokenIds` with `enableOrderBook`, requires the upstream CLOB
`asset_id` and market condition to match, limits the body/level count, validates exact
sorted decimal strings and freshness, and caches per-token snapshots in Redis behind a
versioned hashed key and shared provider pacing. The API client rejects malformed or
execution-enabled payloads. The UI exposes best bid/ask only; all trading capabilities
remain disabled. See [POLYMARKET-READ-ONLY.md](POLYMARKET-READ-ONLY.md) for the source
contract, cache policy, parser limits and tradeoffs.

Validation for this slice: Rust parser tests passed (including identity, sorting,
precision, missing-field, stale timestamp and size-bound rejection); isolated Redis +
loopback route/cache integration passed; API client tests passed (99); web tests passed
(29); API-client/web typechecks and server clippy passed. This is a public read-only
book display; eligibility, builder fee attribution, signer/account compatibility,
orders, redemption and reconciliation remain unimplemented and unverified.

## Extension refresh-token client guard (2026-10-19)

The extension build now enforces its documented access-only policy in the client as
well as relying on the server's Origin boundary. If sign-in unexpectedly returns a
refresh token or refresh expiry, the extension rejects the session and attempts a
bounded logout so the server revokes the session family. Extension lifecycle checks
do not expose native resume and clear any local refresh record. Native mobile refresh
behavior is unchanged. D102 records the defense-in-depth choice and its tradeoff.

The mobile Vitest suite passed (86 tests, six optional skips), including an injected
server-contract regression that returns refresh credentials to an extension build.
This is unit evidence; the installed Chrome extension against a deployment configured
for that exact extension origin still needs acceptance. The workspace currently
resolves Node 20.20.2 despite requiring Node >=22.13, so this run does not replace the
supported-runtime workspace validation.

## Web browser session boundary (2026-10-19)

The current `apps/web` sign-in is a browser SPA calling the API directly; it is not an
HttpOnly-cookie BFF. Its short-lived access token exists only in component memory,
and the client now rejects and attempts to revoke any session response containing
refresh credentials. The API also receives `Origin`, issues browser sessions without
refresh credentials, and refuses Origin-bearing refresh requests. This is defense in
depth, not a substitute for the planned BFF: cross-origin CORS is not a CSRF defense,
and JavaScript memory does not protect an access token from same-origin script
compromise. A BFF migration remains a separate architecture/security task.

## Security and capacity continuation (2026-10-19)

HTTP body collection now has a per-process 16 MiB aggregate payload budget, in
addition to per-request size and request-count limits (D116). Extension dApp reads
have bounded per-origin/global rates and concurrency, payload/response sizes, and
deadlines (D118). Mobile approval and signer gates now fail closed for EVM calls,
EIP-712 fields and unsupported Solana instructions (D117). Hyperliquid account reads
have an eight-request process-local admission cap (D119), and the Redis global price
socket lease index expires after one lease window (D120).

Focused validation passed for the Hyperliquid account-read tests (5), extension
tests (36), API-client tests (101), web tests (29), and mobile focused
provider/lifecycle tests (32). Rust formatting, server clippy, and the price-stream
integration-test binary compilation passed. The full workspace test command had
four server Uniswap tests fail because this sandbox denied loopback socket binds;
other package suites completed. Redis/PostgreSQL integration tests requiring
`TEST_REDIS_URL` or `TEST_DATABASE_URL`, live-provider acceptance, physical-device
acceptance, and authenticated mixed-workload capacity were not demonstrated in this
continuation. The deep security scan recorded zero reportable findings in its
selected review, while explicitly limiting file coverage and noting that code/tests
were not run. None of this establishes production readiness or 10,000 authenticated
users.

The operational follow-up adds minute-cadence supervised auth-retention cleanup guarded by
schema readiness and a transaction advisory lock (D121/D123), plus a bounded, read-only
`dead-letters` CLI with keyset pagination and no intent/provider payloads (D122).
Compose stop grace now exceeds the default drain and bounded cleanup window. The
disposable Postgres tests cover auth cleanup batching/concurrency and dead-letter
pagination/redaction, but remain unexecuted because `TEST_DATABASE_URL` is absent;
these changes are compile-checked, not runtime-accepted against PostgreSQL.

## Auth quota persistence bound (2026-10-19)

Identity proof/profile quotas now use Redis fixed-minute Lua counters with TTL when
the runtime has Redis. Global/IP admission is one atomic pair; address, linked-wallet,
and profile-user quotas use hashed single-subject keys. Redis transport failures fail
closed and do not fall back to PostgreSQL. Direct `Identity` instances used by
isolated/local fixtures retain a PostgreSQL compatibility limiter; its paired path
rolls back the global increment when a subject limit denies the request. Production
deployments must set `REQUIRE_INFRASTRUCTURE=true`, which requires Redis at startup.

PostgreSQL remains authoritative for challenges, sessions, refresh rotation and
replay protection. Supervised cleanup now runs every minute under the transaction
advisory lock. It drains up to 50,000 old compatibility rate rows and 5,000 challenge
rows per table per pass; sessions, refresh tokens and families use 20,000-row batches.
Each maintenance attempt has a separate 10-second deadline from the fast dependency
probe timeout; failures are logged and retried on the next minute.
This exceeds the current DB fallback's theoretical 26,400 rate rows/minute and the
proof endpoint's 1,200 durable auth records/minute. Redis TTL removes new public
limiter cardinality; cleanup also drains historical rows and remains safe if a
fixture used the DB fallback.

Focused checks added: a Redis integration case verifies shared subject enforcement,
key hashing and positive expiry TTL; ignored disposable-Postgres tests cover Redis/DB
pair-admission parity and draining 50,001 expired quota rows plus a 5,001-challenge
backlog while retaining live/current records. `cargo fmt`, server clippy and test
binary compilation are the local validation targets. Real Redis/Postgres execution
still requires isolated `TEST_REDIS_URL` / `TEST_DATABASE_URL` services.

## Atomic route quota admission (2026-10-19)

Active Aave, Morpho, swap execution, bridge-status and Hyperliquid account routes
now check global plus wallet quotas through the atomic pair primitive. Operation
recovery/list use Redis-backed
single-subject quotas when configured. This closes the quota-drain behavior where
rejected wallet requests incremented a shared global bucket, and removes
per-request quota writes from PostgreSQL in configured runtime. Fixed domains use
the Redis-safe lowercase/digit/underscore/hyphen alphabet. PostgreSQL fallback
remains for direct Identity fixtures and retains transactional pair rollback.

The existing ignored Redis and disposable-Postgres tests cover subject-denial
non-consumption of global allowance and concurrent quota admission. This workspace
has no configured TEST_REDIS_URL or TEST_DATABASE_URL, so those services cannot be
runtime-accepted here. Validation includes route-domain unit coverage, focused test
binary compilation, fmt, clippy and diff checks.

## Pairing secret-buffer cleanup (D125)

Pairing now clears owned X25519 offer/answer private-key buffers and handshake
nonces after the last transcript use. `pairSession` clears the X25519 shared secret,
HKDF salt/info/code intermediates and failed session-key outputs in `finally` blocks.
Payload seal/open paths clear temporary nonce, plaintext, ciphertext envelope, and
decoded byte buffers. The mobile and extension owners retire session keys after the
payload transfer or on abort, expiry, mismatch, restart, error and unmount; they keep
the key alive through code confirmation and the corresponding encryption/decryption.
The protocol wire representation is unchanged.

This is best-effort JavaScript buffer hygiene. JavaScript strings and object fields
that contain the mnemonic, React state, engine-created copies, native crypto
internals and garbage-collected copies cannot be reliably zeroized; the code does not
claim protection against process dumps or a compromised runtime. Pairing unit tests
verify explicit buffer overwrite and retain successful agreement/payload coverage.

## Durable queue and history acceptance gate

Do not apply blanket TTL deletion to terminal jobs, operations, fee evidence or
transaction observations. These records support idempotency, reconciliation and
financial history; archive/retention behavior requires an explicit product and
operational policy first. Before production sizing, run `EXPLAIN (ANALYZE, BUFFERS)`
for the mixed ready-job and expired-lease claim query against a representative
backlog, and measure job/operation/audit table growth and vacuum behavior over time.
The query currently combines ready and expired-lease predicates with `OR`; separate
partial indexes exist, but their effectiveness under real backlog distribution has
not been demonstrated here. No disposable production-like database is configured in
this workspace, so this is an outstanding acceptance gate rather than a claimed
performance result.

## Pre-authentication API admission (2026-10-19)

When both identity and Redis are configured, private operation, quote and
Hyperliquid account routes now pass through a shared Redis IP/global quota before
their handlers authenticate bearer tokens. This protects the PostgreSQL session
lookup from random syntactically valid tokens, which previously reached the
per-wallet quota only after authentication. The shared ceiling is 300,000 requests
per minute and each peer is limited to 6,000/minute; trusted proxy extraction and
IPv6 `/64` grouping reuse identity proof admission behavior. Existing auth proof
and profile routes are deliberately excluded and keep their dedicated tighter
quotas. Wallet quotas still run after successful authentication.

An ignored Redis integration test sends repeated random bearer requests through
the middleware and asserts that the second is rejected before the downstream
handler (the DB-auth boundary) runs; it also verifies proof routes are not double
limited. The test requires isolated `TEST_REDIS_URL`. The quota ceiling adds one
Redis operation per private API call and has not been measured under the target
10k mixed workload; shared NAT behavior and Redis failover remain operational
acceptance items.

## Polymarket distributed cache fencing

Catalog and order-book Redis refresh locks now cover the worst-case bounded
refresh path (catalog 30 seconds; order book 60 seconds) and publish through one
Lua compare-owner-and-set step. The order-book path previously used a five-second
lock despite up to two bounded Redis admission calls, a retry wait and a four-second
provider timeout. If a refresh outlives its lease, the old worker can no longer
overwrite a newer replica's cache result. A source unit test verifies that both TTLs
exceed the configured timeout/fetch bounds with margin; an ignored Redis integration
test covers takeover and missing-lock fencing. It requires isolated
`TEST_REDIS_URL`; no Redis endpoint is configured in this workspace, so that runtime
race test remains unexecuted here.

## Price socket lease renewal scheduling

Each price socket renews its distributed Redis capacity lease on a 20-second cadence.
The first renewal is now phase-spread deterministically from the random connection
UUID across the 10–20 second window, rather than aligning every connection admitted
in one burst on the same Redis deadline. The server's one-minute lease leaves room
for this initial delay and later renewal attempts. This reduces the chance that a
large synchronized cohort overwhelms the bounded Redis command semaphore and gets
disconnected together. Unit coverage verifies the phase bounds and stable variation;
it is not a substitute for the coordinated 10k lease-renewal soak, whose close-reason
and Redis busy metrics must be checked on the live deployment topology.

The first real-router rerun found that awaiting the scheduled first interval tick
before entering the socket event loop delayed every frame by 10–20 seconds. The
handler now enters the select loop immediately and lets the phased interval wake
only its lease-renewal branch. The Redis-backed WebSocket integration test verifies
that a newly installed full snapshot is delivered within its two-second deadline.

The complete ignored server acceptance suite was then run serially against disposable
PostgreSQL 17 and Redis 7.4 with loopback fixtures; all selected tests passed, including
durability, operation/outbox recovery, provider transport budgets, cache fencing,
pairing quotas, sealed preparations, and OTLP export.
This exposed two test defects that were corrected: the readiness test now toggles
`LATEST_SCHEMA_VERSION` rather than a retired migration number, and the Redis pairing
byte-budget test uses 64-write waves so it tests atomic global reservation without
overrunning the intentionally bounded 128-command client semaphore. This evidence is
local service-backed acceptance, not multi-replica production or external-provider
acceptance.

## Public Polymarket read admission

The catalog and order-book GET handlers now pass through shared Redis IP/global
admission before cache or provider work, even when wallet authentication is
disabled. The initial ceilings are 300,000 requests/minute globally and 6,000 per
peer; trusted proxy and IPv6 `/64` handling match private API admission. Redis
errors fail closed. Route selection is unit-tested; an isolated Redis integration
test verifies allow/deny and that trusted forwarded identities receive distinct
peer buckets. The integration test requires `TEST_REDIS_URL`. These ceilings are
not measured production capacity; review D130 for the tradeoffs and validation
gate.

## Wallet approval and RPC resource boundaries

dApp requests now cross a clear approval boundary: the owner confirms first, then
the UI claims the still-pending request before it signs or applies any connection
side effect. A disconnect rejects requests that have not crossed that boundary;
claimed requests can complete. Empty-calldata contract calls require a separate
affirmative acknowledgement because the wallet cannot inspect arbitrary fallback
code. This acknowledgement is not execution simulation. Web approval uses the
browser vault password prompt; native approval requires enrolled device security
and a successful device authentication prompt for sensitive actions.
See D131 and the router/UI tests.

Mobile WalletConnect RPC calls now have a 15-second end-to-end deadline and a 1 MiB
response cap enforced before JSON parsing. Tests exercise streamed overflow
cancellation and timeout. The test runtime supports Web Streams; target React Native
streaming and abort behavior still needs confirmation on the release runtime. See
D132. The mobile portfolio and its exported share card are also marked as sample
data wherever the screen uses fixture performance values; those labels prevent a
mock chart from being mistaken for on-chain history.

## Extension Hyperliquid account read (2026-10-19)

After exact-origin SIWE sign-in, the extension Home offers a user-triggered,
read-only Hyperliquid account lookup. It uses the popup's in-memory bearer, checks
that the provider response belongs to the signed-in wallet, and aborts/clears the
view when the account changes, the user signs out, or the popup locks/unmounts.
Errors remain visible with a retry action; provider data is not stored. No order
submission or signing is exposed. Authenticated client request and wallet-binding
tests cover this slice; packaged-extension acceptance against a deployment with
the installed extension origin and configured Hyperliquid credentials remains
required. Other provider workflows and financial execution remain unavailable.

## Explicit API and worker process roles (2026-10-19)

`SERVER_ROLE=combined|api|worker` selects process responsibilities, with combined
as the compatibility default. API replicas serve the existing frontend contracts
and mirror Redis price/Earn snapshots without starting their collectors or the
financial worker loops. Worker replicas collect and publish snapshots, process
configured financial/bridge jobs and prune expired auth state; their HTTP router
only exposes `/health` and `/ready`. Both retain dependency probes, queue metrics,
private metrics export, fail-stop supervision and bounded shutdown. Split roles
require Redis. D148 records the design and operational tradeoffs.

The local [binary smoke result](results/process-roles-local-2026-10-19.json)
records startup against isolated Redis, health/readiness, product route isolation
and clean SIGTERM exit for all three modes. It uses no authenticated or financial
workload. Role/router tests include production construction with readiness closed
before dependency probes. Redis tests exercise the API price/Earn mirror receiving
another instance's publication. Prometheus alert fixtures include a failed worker
metrics target while the API target stays healthy; deployment scrape configuration
must actually register worker targets under `honey-worker`.

This separates process work, not credentials: API construction still loads the
configured adapters it needs for quoting, preparation and submission. API readiness
does not prove remote worker availability. Deploy both roles with matching shared
namespace/configuration and monitor worker availability, queue age and data
freshness. Stream-only isolation, hosted deployment acceptance, failover and 10k
mixed authenticated capacity remain open.

Validation for this slice: workspace `pnpm lint`, `pnpm typecheck` and `pnpm test`
passed. Eight focused role/config/router/price-mirror tests and the Earn replica
fixture passed with isolated Redis; the production-builder readiness case ran in
this focused pass. `promtool test rules` passed. The owned Redis container and all
smoke-test binaries were stopped. No production services or funds were involved.

## 2026-10-19 — Local restore drill and recovery security review

The [recovery runbook](RECOVERY-RESTORE.md) now defines writer fencing, offline
credential invalidation, historical-key/config retention, Redis policy reconstruction,
external transaction reconciliation and staged reopening. An actual `pg_dump` /
`pg_restore` test restores encrypted unknown dispatch state into a separate database;
it verifies ownership, key retention/failure, duplicate-dispatch rejection and a
visible backup-loss window. The checked-in auth reset SQL is exercised through real
identity methods and preserves ownership/audit/replay evidence while invalidating
restored credentials and outstanding proofs. CI invokes matching PostgreSQL clients
from its service container, independent of runner client versions.

A stale terminal-job test was corrected to expect no successor after success and
retry the prior lease when checking terminal fencing. This follows the earlier
queue cleanup behavior; production terminal transitions are unchanged by that fix.

The [scoped security pass](RECOVERY-SECURITY-REVIEW.md) inventories 99 backend
production source files and 14 migrations. It found and fixed price-WS stale-state
suppression after Redis sequence rollback. Decisions D149–D150 explain the
tradeoffs. Bridging is now NEAR Intents ([NEAR-INTENTS.md](NEAR-INTENTS.md)).

Local evidence is in [the restore result](results/recovery-restore-local-2026-10-19.json).
These tests use synthetic data and loopback providers, not production backups or
real-money settlement. Production PITR/failover, measured RTO/RPO, restored external
activity reconciliation and the broader repository client/contract/dependency scan
remain open; this slice does not mark the overall backend goal complete.
