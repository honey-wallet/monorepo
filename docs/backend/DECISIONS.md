# Backend decision record

Date: 2026-10-17. These are engineering decisions/proposals, not user-approved
commercial terms. See [ARCHITECTURE.md](ARCHITECTURE.md) for evidence, feature
coverage, unresolved inputs and implementation gates. See
[IMPLEMENTATION.md](IMPLEMENTATION.md) for what actually exists.

## D01 — Keep Rust/axum and use a modular monolith

**Decision:** retain the repository's runtime; organize application services by
domain, with separate API, worker and stream deployment roles when implemented.
**Pros:** preserves existing code/tooling; transactions stay local; fewer network
boundaries; independently scalable long-lived stream role. **Cons:** shared release
discipline; module boundaries need enforcement; Rust provider SDK coverage must
be evaluated. **Alternatives:** rewrite in Node/Go; provider microservices. Neither
is justified by measured bottlenecks. **Revisit:** sustained independent scaling
or ownership needs. **Status:** selected architecture, roles beyond API planned.

## D02 — PostgreSQL is the durable authority for Honey workflow state

**Decision:** users, ownership, operations, idempotency, outbox and revenue evidence
use PostgreSQL; chains/providers remain authoritative for actual funds.
**Pros:** constraints and atomic commits protect business invariants; mature backup
and query tooling. **Cons:** write-primary budget, schema maintenance and index
cost; cannot make external side effects atomic. **Alternatives:** document DB or
Redis-only persistence. They do not simplify the required uniqueness/transaction
invariants. **Revisit:** measured write/retention requirements, not user count alone.
**Status:** connection/readiness foundation first; business schema follows P1.

## D03 — PostgreSQL jobs/outbox before another durable broker

**Decision:** short claims with SKIP LOCKED, leases/fencing, at-least-once consumers,
and outbox in the same transaction as operations. **Pros:** avoids DB/broker dual
write gaps; one durable system to operate initially. **Cons:** polling and table
maintenance; contention if poorly indexed; workers need explicit dedupe. **Rejected:**
in-memory queues, Redis Pub/Sub for durable events, claims of exactly-once delivery.
**Revisit:** measured lag/throughput, independent consumers or replay retention
justify SQS/Streams/Kafka. **Status:** designed, not implemented in P0.

## D04 — Redis is ephemeral and partitioned by failure semantics

**Decision:** bounded public caches, atomic quotas, pairing and fanout; keep eviction-
tolerant caches separate from pairing tombstones/other fail-closed coordination.
**Pros:** fast shared state and efficient fanout. **Cons:** another dependency;
failure policy is feature-specific; loss of pairing state requires restart.
**Alternative:** process-local maps only. They cannot coordinate replicas.
**Revisit:** managed topology, memory and latency measurements. **Status:** dependency
connection/probing first; distributed pairing/cache algorithms remain P2.

## D05 — No server-held user signing keys

**Decision:** prepare and validate on server, review/sign on device; relay only
already-signed, intent-bound payloads. Provider trading-agent keys also stay client-
side. **Pros:** preserves repository custody model; limits server compromise impact.
**Cons:** background trading and cross-device nonce coordination are harder;
some provider/account combinations may be unavailable. **Alternative:** custodial
execution service. Requires a separate explicit product/security/legal decision.
**Status:** existing boundary retained; signer compatibility remains a launch gate.

## D06 — Explicit canonical IDs and integer money

**Decision:** chain namespace/reference + asset address/reference; decimal strings
for raw amounts; checked integer/decimal arithmetic; provider-specific fee units.
**Pros:** avoids symbol collisions and precision loss; auditable calculations.
**Cons:** more parsing/formatting than JS numbers; schema migration from demo types.
**Alternative:** symbol/chain-name keys and floats. Unsuitable for execution.
**Status:** required for P1/P3 contracts; existing demo models are not silently changed.

## D07 — Opaque sessions initially

**Decision:** single-use wallet challenges, hashed opaque credentials, rotating
refresh families and explicit ownership; email identity does not authorize spend.
**Pros:** direct revocation; simpler than early JWT key distribution. **Cons:** DB
or carefully bounded cache lookup; refresh concurrency needs tests.
**Alternatives:** short-lived JWTs, managed auth. Revisit with the selected identity
provider and distributed runtime requirements. **Status:** proposed P1 design.

## D08 — Shared public feeds; private streams require provider-specific treatment

**Decision:** ingest each public instrument once per shard; coalesce and fan out
bounded updates. Private data uses authorized topics and durable resync. Hyperliquid
private-stream scale requires a documented supported arrangement or client-direct
path. **Pros:** dramatically reduces upstream requests; bounded memory.
**Cons:** snapshot/sequence protocol and ownership leases add implementation work;
does not eliminate per-user provider quotas. **Alternative:** one upstream socket
per Honey client behind the backend. Conflicts with published limits.
**Status:** designed P4; no WebSocket capacity claim yet.

## D09 — No shared executable quote cache

**Decision:** public display data may be cached; executable quotes are scoped to
intent/user and provider validity rules; Across no-cache rule is explicit.
**Pros:** prevents cross-user parameters, stale fees and expired execution.
**Cons:** more provider requests; quote quotas and input debouncing matter.
**Alternative:** cache every quote by token pair. Unsafe because amount, recipient,
allowance, slippage, fee revision and time matter. **Status:** adapter requirement.

## D10 — Durable operation state before enabling submission

**Decision:** idempotency key + intent digest + operation/job transaction; provider
timeouts become ambiguous/reconciling until checked. **Pros:** restart recovery,
safe duplicate UI actions, explainable support. **Cons:** more lifecycle states and
worker code. **Alternative:** frontend calls provider and immediately shows success.
Insufficient evidence for wallet receipts. **Status:** P1 prerequisite for P5–P9.

## D11 — Provider-specific adapters and progressive capability enablement

**Decision:** preserve provider signing/status/fee semantics; enable only tested
actions/account versions, initially no live provider capabilities.
**Pros:** avoids falsely uniform APIs and guessed SDK behavior; safe staged rollout.
**Cons:** more fixtures and mapping code. **Alternative:** generic proxy that forwards
all user payloads to any provider. It cannot enforce reviewed intent or credentials.
**Status:** capability contract begins P0; adapters follow roadmap.

## D12 — No invented commercial fees or builder registrations

**Decision:** rates, recipients, builder identities, partner agreements and payout
handling are explicit immutable policy revisions once approved. **Pros:** clear
user consent and financial reconciliation; attribution is not mistaken for revenue.
**Cons:** monetization is blocked pending real agreements. **Alternative:** hardcode
a suggested percentage or treat referral codes as fee entitlement. Unsupported.
**Status:** unresolved launch configuration; no real-money action performed.

## D13 — Curated Earn products, direct protocol paths initially

**Decision:** approved Morpho vault versions and Aave V3 reserves; supply/withdraw
first, no automatic rebalancing/new wrapper deployment. **Pros:** bounded risk and
test scope, clear custody, fewer novel contracts. **Cons:** lower initial breadth;
revenue may require later agreements/wrappers. **Alternative:** select maximum APY
across arbitrary vaults. Ignores liquidity, curator/contract risk and fees.
**Status:** proposed P7, needs approved registry and chain deployments.

## D14 — Safe request correlation and bounded HTTP work first

**Decision:** generate request IDs server-side; log route templates, status and
duration without URI/query/body/header payloads; cap body bytes and in-flight
requests; use a structured timeout/overload error. **Pros:** prevents common log
leaks and resource blowups; testable before real integrations. **Cons:** inbound
client request IDs are not preserved; global concurrency cap is not per-user
rate limiting or a complete edge defense. **Alternative:** default raw-URI trace
spans and unbounded handler concurrency. Not appropriate for wallet data.
**Status:** P0 implementation. Exported distributed tracing is a later P2 step.

## D15 — Background dependency probes and explicit readiness

**Decision:** bounded background PostgreSQL/Redis probes; readiness serves the last
probe result; liveness stays independent. Optional dependencies are explicit in
local scaffold mode; production requires configuration. **Pros:** health requests
cannot amplify into DB traffic; outage does not trigger meaningless crash loops.
**Cons:** readiness lags a failure by a probe interval; it proves connectivity,
not schema compatibility or provider correctness. **Alternative:** synchronous
probe on every health request. Adds load at exactly the wrong time.
**Status:** P0; schema compatibility checks belong with real migrations.

## D16 — Bound rollout claims to evidence

**Decision:** mark 10k workload/SLO/hardware figures as proposed; require mixed-load,
N-1, failure and restore results before launch. **Pros:** staff review can separate
architecture arithmetic from operational proof. **Cons:** requires staging/test
budget and provider coordination. **Alternative:** infer capacity from Rust/Redis
or an idle-socket benchmark. Insufficient. **Status:** always applies.

## D17 — Preserve the existing product UI while replacing its authority

**Decision:** reuse current frontend components, migrate shared API/data seams per
feature, and keep demo state explicitly separate. **Pros:** coherent UX and bounded
review scope; existing keyring work remains intact. **Cons:** transition requires
strict live/demo and feature-gate tests; adding client methods does not wire every
screen automatically. **Alternative:** rewrite the UI simultaneously or feed demo
success into live receipts. Neither is justified. **Status:** shared P0 contract;
screen integrations listed in the architecture roadmap.

## D18 — Small initial dependency surface and no automatic migrations

**Decision:** SQLx PostgreSQL pool and redis-rs connection manager; explicit runtime
timeouts and configuration; migrations are a separate later command/deployment job.
**Pros:** established drivers, async pools, no data-changing startup behavior.
**Cons:** lockfile grows; connectivity must be verified with actual services; pool
configuration does not create domain persistence. **Alternative:** hand-written
wire protocols or an ORM/repository framework before entities exist. Unnecessary.
**Status:** P0; versions pinned by Cargo.lock and checked against the toolchain.

## D19 — Explicit SIWE identity scope, key proof before membership

**Decision:** first method is SIWE/EIP-191 for an explicitly configured origin and
chain. Store the server-generated challenge, atomically consume it, and create
membership/session/audit in one transaction. Never accept a message or principal
chosen by a caller. **Pros:** compatible standard; no signing secrets on server;
replay races and ownership constraints are testable. **Cons:** initial sessions
cover one chain/address, not a user's entire multichain wallet; contract/delegated
account execution needs additional verification. **Alternatives:** email OTP needs
unconfigured delivery infrastructure and still needs wallet proof; address-only
login proves nothing. **Status:** P1 implemented; EOA method proves key control,
not absence of code at an address. See IDENTITY-AND-DURABILITY.md.

## D20 — Short opaque sessions before refresh families

**Decision:** 15-minute random bearer, digest only in PostgreSQL, immediate checked
revocation, memory-only browser storage. No refresh token yet. **Pros:** simple
cross-replica revocation; small compromise window; no server JWT signing key or
unfinished refresh-reuse semantics. **Cons:** repeated signatures; database read
per protected request; a lost verification response requires a fresh challenge.
**Alternative:** signed JWT plus blacklist adds consistency questions; long-lived
unrotated tokens increase exposure. **Status:** implemented P1; supersedes the
proposed long refresh lifetime only for this initial slice. Rotation, secure native
storage and device management remain required for the intended production UX.

## D21 — Direct PostgreSQL queue, versioned intent and fenced database writes

**Decision:** operation and job/outbox rows commit together. Commands deduplicate
by principal/action/key and canonical intent digest; state changes require expected
version and a live job lease. Claims use SKIP LOCKED and a new token each time.
**Pros:** no broker publish gap; clear ownership/version constraints; replay,
rollback and stale-worker behavior verified against real PostgreSQL. **Cons:**
write/index maintenance on primary; internal APIs are not an implemented worker
service; leases cannot prevent an old external request being accepted by a provider.
**Alternative:** separate Kafka/Redis queue requires delivery reconciliation anyway.
**Status:** P1 primitives implemented. At-least-once only; ambiguous financial
requests must reconcile rather than blindly retry.

## D22 — Database-backed auth quotas and bounded retention

**Decision:** fixed-minute, atomic DB buckets for the first low-volume proof routes;
global cap before per-IP/address allocation, IPv6 /64 grouping, bounded explicit
cleanup and server-side query/lock timeouts. **Pros:** replicas share the same limits;
DB outage fails closed; Redis is not another identity consistency dependency.
**Cons:** fixed-window bursts and a hot global counter; conservative limits are not
a 10k-login claim; public address issuance quotas and global quotas can be exhausted
by abuse. **Alternative:** process-local counters multiply by replica count; general
market quotas belong in Redis/edge controls. **Status:** P1; schedule cleanup,
monitor backlog and add edge controls before public registration.
The PostgreSQL-counter storage choice is superseded by D123; the fixed-window limits,
global-before-subject cardinality bounds, and edge-control caveat remain relevant.

## D23 — Explicit embedded migrations and PostgreSQL-targeted SQLx features

**Decision:** compile forward SQL migrations into the binary; run only an explicit
operator command using SQLx migration locking/checksums. Enable type/migration
features directly on matching `sqlx-core`/`sqlx-postgres` 0.8.6 dependencies, with
the facade's default features disabled. **Pros:** distroless runtime needs no
filesystem; no startup schema writes; excludes optional MySQL/RSA resolution and
does not need an advisory ignore. **Cons:** new migrations must be registered in
the embedded source; three SQLx crates must stay on the same exact version; a
schema-version readiness probe does not validate all grants/checksums. **Alternative:**
umbrella features pulled optional MySQL/RSA into Cargo.lock (not the binary),
triggering RUSTSEC-2023-0071. Suppressing that advisory was unnecessary. **Status:**
P1 implemented; release migrations still require separate runtime/migration roles
and expand/contract discipline. No existing database was migrated.

## D24 — Redis atomic one-time pairing, no outage fallback

**Decision:** one channel hash, read tombstones, shared Redis-time expiry and bounded
quota sorted sets in one hash slot; noeviction; fail unavailable if Redis fails.
**Pros:** independent replicas enforce the same one-write/one-read contract; bounded
state; no replica affinity. **Cons:** Redis becomes an availability dependency;
write loss invalidates pairing; Lua errors do not roll back reservations. **Alternatives:**
local maps require sticky routing and lose state on restart; PostgreSQL is durable
but puts ephemeral ciphertext and polling on the primary. **Status:** implemented,
real-Redis races/quotas verified. Production HA semantics remain a deployment gate.

## D25 — One fenced poller and complete public display snapshots

**Decision:** fixed Hyperliquid allMids reader at most once/second across replicas;
Redis lease/fenced cache publication; every update contains BTC/ETH/SOL in full.
**Pros:** provider calls independent of user count; small, testable contract;
reconnect needs no delta replay; shared backoff. **Cons:** polling/mirror latency,
fixed asset list, no exchange timestamp; not suitable for order-book execution.
**Alternatives:** upstream WS has lower latency but requires reconnect/subscription
supervision; per-client polling would exhaust quotas. **Status:** implemented for
public display; private streams and trade execution remain separate work.

## D26 — Decimal strings and explicit venue contract units

**Decision:** preserve provider decimals as strings, expose quoteUnit=USDT for the
three supported Hyperliquid perps; distinguish collateral from denomination and
mid/last from mark/oracle/quote. **Pros:** no float truncation or false USD valuation;
frontend knows exactly what it can display. **Cons:** formatting/calculation needs
explicit decimal handling; cannot reuse this feed as generic portfolio prices.
**Alternative:** dollar-labelled JavaScript numbers would erase precision and units.
**Status:** implemented and validated on both sides; primary sources in
REDIS-AND-PRICES.md. Future assets need explicit contract metadata review.

## D27 — Latest-value socket fanout with shared expiring admission

**Decision:** watch channel plus one serialized frame per replica, local semaphore,
Redis global/IP socket leases, bounded frames/sends, heartbeat, drain, Origin check.
**Pros:** no unbounded queue for slow consumers; global cap survives multiple
replicas; stale lease releases capacity after process death. **Cons:** capacity may
be held 60 seconds after crashes; NAT users share a conservative cap; renewals add
Redis load and can cause disconnections during outages. **Alternatives:** unbounded
broadcast queues exhaust memory; local limits multiply by replica count; durable
stream replay is unnecessary for complete public snapshots. **Status:** implemented;
local experiment and deployment benchmarks are separate evidence.

## D28 — Shared client validates freshness independently

**Decision:** bounded schema validation, decimal/u64 strings, full snapshots on
reconnect, local stale timer, exponential jitter and explicit cleanup. **Pros:** a
quiet/broken connection cannot leave indefinitely fresh prices; both native and web
use one protocol; lifecycle cleanup stops background reconnects. **Cons:** needs
clock synchronization, screen foreground wiring and separate tests on physical
native runtimes; no browser-visible HTTP Retry-After on WS failures. **Alternative:**
trusting server stale flags alone fails when updates stop. **Status:** shared client
and web/native display implemented, including native focus/background cleanup.

## D29 — Native/extension proof uses existing local keys and explicit app identity

**Decision:** a Settings sign-in screen shows the exact SIWE message before device
owner/password confirmation; existing keyring signs locally; independent build
configuration pins relying-party origin/chain. Memory-only short session, checked
protected profile; wallet change, lock, real background, expiry and cancelled work
invalidate state and revoke known credentials. **Pros:** never uploads keys; rejects
API-selected identity scope; reuses native/extension vault; race tests prevent late
responses reviving a cancelled session. **Cons:** backgrounding requires another
sign-in; popup closure may leave a server token valid until its 15-minute expiry if
revocation cannot complete; no refresh/device-management UX yet; JS key wiping is
best effort and does not promise all runtime copies are erased. **Alternative:**
persisting an unrotated long-lived bearer improves convenience but would obscure
missing refresh-family/reuse semantics. **Status:** implemented local controller,
screen and lifecycle; device biometrics and extension password UI need real-runtime
acceptance. Tokens are excluded from generic app persistence.

## D30 — Private pull metrics and bounded, sampled OTLP export

**Decision:** a separate optional metrics listener, finite label vocabularies, and
application-only trace spans exported asynchronously through an explicitly configured
collector; default 10% head sampling, 2,048 queued spans and no application export
retries. Server-generated trace IDs are returned for correlation. Public incoming
trace context/baggage is ignored. **Pros:** API behavior survives collector failure;
labels cannot grow with addresses/paths/users; an untrusted caller cannot force
sampling or impersonate a trace parent. **Cons:** sampled-out errors and queue-full
spans are lost; the SDK does not expose a precise queue-drop counter here; distributed
frontend trace parenting is unavailable. Long-lived socket spans export at close.
**Alternatives:** synchronous export adds request dependencies; 100% export plus tail
sampling requires a separately measured collector memory budget. **Status:** implemented;
real protobuf, collector outage, redaction, Prometheus and Jaeger tests verified.
See OBSERVABILITY.md for signal coverage and production gaps.

## D31 — Reuse the existing HTTP/TLS stack for telemetry

**Decision:** a small OpenTelemetry HttpClient bridge uses the existing reqwest 0.12
client and live Tokio runtime. Disable the exporter's default HTTP client features.
**Pros:** avoids a second reqwest/TLS dependency tree; explicitly bounds connect/request
time, redirects and response bytes; counts HTTP failures and OTLP partial rejection.
**Cons:** adapter maintenance and protobuf response validation are our responsibility;
SDK queue losses are distinct from transport failures. **Alternative:** SDK reqwest
feature is simpler but currently pulls a separate reqwest 0.13 dependency. **Status:**
implemented with real wire-format testing and dependency audit. No raw exporter error
or collector response is logged.

## D32 — A dead required background task drains the API

**Decision:** supervise health, market and optional metrics-server tasks; unexpected
completion/cancellation/panic revokes readiness, drains the process, cancels remaining
tasks and returns an error for the process supervisor. Log only task index and class;
the panic hook omits arbitrary payloads and retains source location. **Pros:** an API
cannot stay healthy while its required tasks silently disappear; credentials in panic
payloads are not printed. **Cons:** a metrics-listener failure causes an API restart;
file/line and correlated safe events must replace panic payloads during debugging;
a final failure counter may disappear before the next scrape. **Alternative:** restart
each task internally risks hiding persistent defects and needs per-task recovery state.
**Status:** implemented for current API background tasks. This is not a durable job
worker supervisor, and process restart policy remains a deployment responsibility.

## D33 — Version-specific Earn readers precede transaction dispatch

**Decision:** separate Aave V3 GraphQL and Morpho Vault V2 REST readers with explicit
chain/contract/asset targets and strict response identity/unit validation. Capture
live public fixtures and retain protocol-specific restrictions. **Pros:** executable
code is grounded in actual schemas; V3/V4 and Vault V1/V2 cannot be silently mixed;
validated observations can feed later preparation/cache layers. **Cons:** indexed
state is insufficient for execution; additional RPC, curated registry, cache and
frontend work remain. **Alternative:** wiring a generic provider response into the
existing demo screen would hide asset/version and liquidity differences. **Status:**
readers and live smoke implemented; no public API route or financial capability is
enabled. The current WorkStore intent hash cannot reconstruct an execution plan;
persisting validated preparation and reconciliation evidence is a separate next step.

## D34 — Shared conservative read admission with persistent uncertain cooldowns

**Decision:** fixed origins, mandatory Redis time-based per-provider spacing,
bounded local admission/deadline/body, no redirects/retries, shared Retry-After
cooldowns. Invalid or unrepresentable cooldowns create an operator-cleared hold.
**Pros:** replica count cannot multiply these readers' request grants; a seven-day
provider ban survives a process restart; no Redis-outage bypass or arbitrary URL
proxy. **Cons:** Redis failure stops reads; malformed Retry-After can stop a provider
until investigated; one request/second is an engineering default, not a provider
agreement, and may constrain large registries. **Alternatives:** local-only limits
multiply across replicas; truncating long bans to a short retry interval repeatedly
violates upstream policy; automatic retries obscure the caller's recovery budget.
**Status:** implemented and verified with independent transports, real Redis and
local upstream faults. A shared cached collector is required before user-facing use.

## D35 — Preserve APY basis, unknown data and independent source blocks

**Decision:** Aave raw/scale conversion uses strings; Morpho captures the original
JSON number token. Preserve current vs trailing-one-day-after-fees APY, optional
history, nullable restriction/fee/liquidity fields and component block references.
**Pros:** no float rounding of economic values, unknown is not zero/permission,
indexer reads do not masquerade as an atomic finalized snapshot. **Cons:** client
formatting must handle decimal scientific notation and different measurement bases;
absence of an Aave indexed block limits freshness evidence; aggregate liquidity
cannot answer user withdrawal limits. **Alternative:** a single numeric APY and
boolean depositAvailable would erase these distinctions. **Status:** implemented
normalization and adversarial fixture tests; no yield ranking or execution decision
is made from these observations. Morpho vault fees are not Honey revenue.

## D36 — A bounded read registry feeds a fenced, locally mirrored catalog

**Decision:** explicit max-eight protocol/chain/contract/asset targets, no default
products; per-product Redis lease and refresh spacing, validated exact-JSON cache,
local monotonic aging and HTTP reads without dependency IO. **Pros:** user count
does not drive provider calls; stale workers cannot overwrite current data; removing
a registry entry removes it from that process's response; outages cannot silently
renew freshness. **Cons:** up to five seconds mirror delay; sequential refresh can
age other products during provider failure; Redis coordination loss can lose quota
state; deployments must coordinate registry versions. **Alternatives:** per-request
provider fanout does not scale; symbol-only keys collide; cjson decode/encode breaks
empty arrays; a large scheduler is premature for the bounded initial registry.
**Status:** implemented and verified with real Redis, two API replicas and public
provider reads. Read configuration is not financial product/risk approval.

## D37 — Real-wallet Earn views consume observations and exclude demo execution

**Decision:** shared strict typed client and cancellable jittered polling; explicit
APY basis, local stale/expiry checks; non-demo Savings/Earn/Savings Add show public
market data and unavailable positions/execution. Demo wallet retains prototype
flows. **Pros:** a real wallet cannot reach simulated deposit completion through
these routes; native/extension/web share identity and freshness semantics; hidden
screens stop network work. **Cons:** real jars/positions remain unavailable while
those backends are unfinished; physical-device acceptance still required; polling
adds bounded HTTP traffic and display latency. **Alternative:** reusing demo yield,
liquidity and receipt state would falsely imply user earnings or settled deposits.
**Status:** wired and tested at contract/lifecycle/build level. No deposit/withdraw
or private position capability is enabled; full execution remains on the roadmap.

## D38 — Persist immutable intent evidence instead of only its digest

The queue cannot reconstruct a digest after a restart. New operation creation now
commits bounded canonical intent, operation and initial job together. Migration 2
adds separate evidence tables without altering migration 1; legacy rows explicitly
lack recoverable intent. Existing idempotency and digest format remain unchanged.

Pros: restart reconstruction, auditability and a stable semantic binding. Cons:
private economic data now requires retention, access-control and erasure policy;
immutable evidence needs an audited administrative removal process. Alternatives:
client resend risks intent substitution and unavailable clients; Redis persistence
makes transaction evidence depend on a disposable cache. Neither was selected.
Details and limits: [PREPARATION-AND-RECOVERY.md](PREPARATION-AND-RECOVERY.md).

## D39 — One immutable EVM plan owns the preparation state transition

A bounded typed single-chain call plan records signer/intent binding, revisions,
fees/limits, simulation block/call digest and expiry. A live versioned queue lease
installs it, advances state, acknowledges work and inserts the successor atomically.
Requotes require a new operation. Generic queue transitions can only reject an
unprepared intent; they cannot synthesize financial success or submission.

Pros: no plan/outbox commit gap, stale-writer rejection, no silent approved-plan edits.
Cons: repricing requires explicit replacement review; administrative workflows need
separate evidence-aware methods; the format cannot represent exchange orders or
bridge settlement. A universal JSON plan was rejected because it hides signing and
lifecycle differences. Full per-provider plans remain required where semantics differ.
Structural checks are not proof of calldata/simulation correctness. D41–D42 add
independent signed-envelope verification and an internal Aave preparer; D44–D46 add the initial encrypted submission/dispatch ledger. Receipt reconciliation
and worker orchestration remain unimplemented.

## D40 — Expose owner-scoped recovery metadata before signable payloads

GET /operations/{id} uses the existing session's principal and wallet, one DB snapshot,
hash verification and a 60/minute wallet quota. It returns exact version, preparation
summary and expiry, with executionAvailable=false. The client validates the contract
and binds response ID to request ID; it never retries a submission or signs metadata.

Pros: a stable restart/status contract without inventing a live execution flow or
exposing calldata through a generic endpoint. Cons: this is not history or a private
stream; DB-backed read quotas and authentication still need mixed-load measurement.
A generic plan submission API was rejected until provider semantics and independent
signature verification exist. Existing financial UI cannot claim a completed backend
transaction from this read endpoint alone.

## D41 — Verify EIP-1559 signed bytes independently of the client

**Decision:** use Alloy's exact canonical envelope decoder and explicitly checked
low-S recovery; match the entire ordered bundle to the immutable plan plus a trusted
fresh nonce/gas policy. Reject unsupported types/access lists rather than silently
loosening the schema. Verified bytes have a private wrapper without Debug/Serialize.

**Pros:** no handwritten RLP/cryptography; a compromised client cannot substitute
signer, call, value, chain or fee budget; independent real-keyring fixture coverage.
**Cons:** EIP-7702/smart accounts and alternate envelope types need separate designs;
RPC freshness/fork-specific gas checks and durable submission remain necessary.
**Alternatives:** trusting client hashes or recovered addresses alone leaves calldata
and fee substitution; using only the client's signer library provides less independent
validation. A client signature is broadcastable authorization, not settlement evidence.

## D42 — Prove one Aave path on actual forked contracts before enabling its UI

**Decision:** prepare finite self-supply/withdrawal using pinned-block reserve reads,
exact approvals, sequential simulation, conservative gas margins and bounded fee
ceilings. Require explicit reviewed registry input. Use zero app fee/referral only in
this inactive adapter/test configuration; no product fee policy is silently approved.
Record no exact aToken minimum on supply because the contract does not enforce one.

**Pros:** actual wallet signing, independent verification and receipt/balance checks
exercise the concrete integration; fork testing discovered delegated-account and
rounding cases. Exact allowance reduces residual authorization after success.
**Cons:** three-call reset/approve/supply can partly succeed, costs more gas and needs
per-step durable recovery. Sequential simulation requires RPC support. EOA-only finite
withdrawals leave dust; proxy code hashes do not pin implementations. The current
harness bypasses API/persistence and is not frontend acceptance or production proof.
**Alternatives:** unlimited allowances reduce repeat gas but increase authorization;
opaque provider calldata or demo receipts cannot prove this contract path. A public
submit button before attempt persistence would create unrecoverable ambiguous outcomes.
See [AAVE-EXECUTION.md](AAVE-EXECUTION.md) for exact activation gates and evidence.

## D43 — Pin the transaction codec to the existing toolchain's compatible release

**Decision:** Alloy consensus/eips 2.1.1 and primitives 1.7.3 with restricted features;
raise declared MSRV to dependency metadata's 1.91 while retaining the installed/CI
1.93 toolchain. Do not claim newest Alloy or a verified 1.91 build.
**Pros:** maintained Ethereum primitives instead of custom transaction parsing; exact
lockfile and reproducible cross-language vectors. **Cons:** larger dependency graph;
RustSec reports two unmaintained warnings (derivative lock-only, paste active) despite
zero vulnerable packages in the audit. No advisories are suppressed. **Alternative:**
newer cached Alloy requires a newer compiler; a toolchain-wide upgrade was not needed
for this path and would enlarge the regression scope. Reassess versions before release.

## D44 — Reserve signed nonces durably and serialize unresolved wallet operations

**Decision:** atomically persist the independently verified signed bundle, nonce slots,
wallet guard, `signed` state and successor job. One unresolved Honey operation per
proven wallet; no TTL on signed nonce reservations. Exact retries recover existing
identifiers. A signed EVM authorization outlives an off-chain quote expiration.
**Pros:** no duplicate nonce allocation inside Honey, restart recovery, clear separation
between stored and sent, parallelism across wallets. **Cons:** external wallets can still
race the account; partial outcomes can block later Honey operations until reconciliation;
fee replacements require a separate protocol. **Alternatives:** process/Redis locks or
expiring reservations lose financial coordination under restart/timeout; unrestricted
nonce pipelines require substantially more replacement and cancellation machinery.

## D45 — Encrypt broadcastable authorizations and bind all record metadata

**Decision:** XChaCha20-Poly1305, random 192-bit per-record nonce, versioned associated
data covering operation/plan/step/chain/signer/nonce/hash/key ID. Explicit bounded key
ring, zeroizing owned buffers, no sensitive Debug/Serialize. Independent Noble vector.
**Pros:** database-only exposure does not reveal broadcastable bytes; row substitution
fails; old-key restart recovery supports staged rotation. **Cons:** application compromise
still exposes authorizations; key retention/recovery and audited re-encryption need an
operational design; adds crypto dependencies. **Alternatives:** plaintext in jobs/logs
is unacceptable; relying solely on disk encryption does not protect exported DB data.
This does not introduce server custody of user signing keys. No production key loading
or KMS choice is assumed. See [SIGNED-SUBMISSIONS.md](SIGNED-SUBMISSIONS.md).

## D46 — Commit dispatch intent before releasing bytes and keep acknowledgement uncertain

**Decision:** a live fenced job can journal initial step-zero dispatch and atomically
move to `unknown`; only a committed transaction returns the sensitive dispatch object.
A unique intent refuses blind retries. RPC acknowledgement is immutable evidence,
not inclusion or settlement. Later steps require receipt-aware methods still to be built.
**Pros:** crash/timeout ambiguity is explicit, at-most-one initial journal entry, atomic
queue handoff, rollback/lease races tested. **Cons:** a crash before the actual send can
look like a send; reconciliation must distinguish it without manufacturing success;
database fences cannot revoke bytes a stale process already holds. **Alternative:**
network-first then persistence has an unrecoverable side-effect gap. Exactly-once
network delivery is not claimed. Plan expiry does not revoke an Ethereum signature.

## D47 — Verify canonical receipts and pin finalized checkpoint continuity

**Decision:** reconstruct context from encrypted signed bytes; validate exact receipt
identity, canonical block/index, ordering, gas and signed EIP-1559 fee arithmetic.
Recheck source blocks and the previous finalized checkpoint. Only verified internal
reports can enter persistence. No fallback from `finalized` to a guessed block count.
**Pros:** malformed, wrong-chain, reorged and contradictory reports fail closed; exact
known transaction hashes govern recovery. **Cons:** up to 30 RPC reads for eight steps;
RPC is still trusted infrastructure, not a light client or Byzantine quorum. Provider
support/quotas and independent finality monitoring remain operational requirements.
**Alternative:** treating an RPC acknowledgement, explorer link or elapsed timer as
success cannot establish inclusion or settlement.

## D48 — Retain meaningful receipt history and refresh bounded current proofs

**Decision:** append immutable hashed batches only when receipt/reorg/finality facts
change; refresh a current checkpoint projection for unchanged healthy polls and defer
the same job five seconds. Commit state/outbox/guard release under the worker fence.
**Pros:** avoids unbounded history growth from unchanged polling; fresh proof gates
later steps; rollback and stale-worker behavior reuse the durable queue model.
**Cons:** not every poll has immutable historical checkpoint detail; healthy polling
still writes coordination state and needs load testing; provider faults need backoff
and alerts. **Alternative:** one permanent row per poll scales with waiting time rather
than meaningful financial changes. Redis alone cannot own durable receipt history.

## D49 — Use inclusion for sequential progress and full finality for guard release

**Decision:** successful canonical predecessors allow the next signed step while the
plan remains valid; all known signed slots must have finalized receipts before terminal
success/failure and wallet-guard release. Reorg/missing receipts preserve uncertainty.
**Pros:** approvals can progress within the quote lifetime; no timer frees broadcastable
nonces; reverted approval blocks action. **Cons:** unresolved replacements/unused signed
slots can hold a Honey operation until explicit reconciliation/cancellation; intermediate
reorgs remain possible and require fresh simulation before send. Residual allowances
need separate review/revoke UX. **Alternative:** finality after every approval exceeds
short plan expiry; releasing guards on any partial failure creates competing signatures.
Actual-contract, database and shared-client evidence: [RECEIPT-RECONCILIATION.md](RECEIPT-RECONCILIATION.md).

## D50 — Persist exact signing terms in the preparation transaction

**Decision:** store nonce, per-call gas, max fee and priority fee with the complete plan
in an immutable, hashed signing-request row installed atomically with preparation.
The submission API requires the exact terms, even when another gas/fee combination
would fit the aggregate budget. **Pros:** restart-stable review, deterministic replay,
no hidden re-quotation after approval, and a direct frontend contract. **Cons:** changing
fees or nonce requires a new operation; more immutable evidence is retained; legacy
plans cannot be retrofitted automatically. **Alternative:** reconstructing terms from
latest RPC data can change the transaction after the user reviewed its operation.
Details and migration: [AAVE-API.md](AAVE-API.md).

## D51 — Run typed durable Aave work with a local-only activation boundary

**Decision:** HTTP creates/stages durable work; a supervised bounded worker prepares,
re-simulates the remaining suffix, journals each initial send, and reconciles receipts.
Activation accepts only an explicitly configured literal-loopback fork and application
DEK file; the transport rechecks chain 31337 before send. **Pros:** tests exercise the
actual API/worker architecture and server restarts; HTTP cancellation cannot erase
accepted work; unverified proxy/fee/provider policy cannot silently enable mainnet.
**Cons:** this does not ship production Aave; the serial local worker and local RPC
semaphore need measured shared quotas and execution-worker scaling. Unknown sends are
not retried, so commit-to-send crashes require explicit reconciliation/recovery work.
**Alternative:** broadcasting from an HTTP handler couples the side effect to a timeout;
blind retries cannot distinguish lost acknowledgement from absent transmission.

## D52 — Independent client economics validation before device confirmation

**Decision:** typed shared-client guards validate shapes/bounds and reconstruct exact
Aave ABI calls against the user's request and explicit registry. Native signing then
requires device confirmation and rechecks wallet/session/lifecycle context after awaits.
**Pros:** calldata, recipient, unlimited-approval and fee changes cannot silently pass
through a generic sign button; tests cover cancellation before and during signing.
**Cons:** provider-specific client validation must evolve with the server adapter;
current UI is a gated local test flow, with durable app operation discovery and final
tray UX still open. JS strings containing signatures cannot be securely zeroized.
**Alternative:** displaying a provider's human-readable label while blindly signing its
calldata does not independently bind what the wallet authorizes.

## D53 — Wallet-scoped keyset history with full database timestamp precision

**Decision:** discover operations using a bounded summary page ordered by immutable
creation time and UUID; resolve UUID cursors inside the authenticated principal and
wallet scope. Fetch one extra row instead of counting all rows. **Pros:** no offset
cost growth, no rounded timestamp gaps, no cross-wallet cursor authority, no per-row
receipt joins. **Cons:** no random page numbers or stable multi-page snapshot; two queries
for subsequent pages; users refresh to see newer insertions. A 100,001-row interleaved
wallet fixture confirms the index path, not concurrent-user capacity.
[Contract and evidence](OPERATION-HISTORY.md).

## D54 — Recover user intent from the server and require a new review

**Decision:** after reauthentication, native/web clients discover IDs from owner-scoped
history rather than persisting tokens or signing bytes. Only the typed Aave endpoint can
supply an unsigned intent for reopening, with current registry/wallet comparison and a
new user/device confirmation. **Pros:** app termination does not lose operation discovery;
provider disablement does not erase receipt access; no automatic financial retry during
page load. **Cons:** offline history is absent; sign-in is required again with current
short-lived sessions; expired requests cannot be silently refreshed. **Alternative:**
a locally remembered ID alone cannot recover a request whose create response was lost.

## D55 — Build the history index concurrently with explicit repair requirements

**Decision:** migration 6 runs outside a transaction and builds the wallet-scoped index
concurrently. Do not add `IF NOT EXISTS` that could mask an invalid or wrong index.
**Pros:** avoids blocking ordinary writes for the full build duration. **Cons:** more I/O,
nonatomic migration bookkeeping, and explicit inspection/repair after interruption;
operators must budget statement time and build load. **Alternative:** normal transactional
index creation is simpler but blocks writes while building a growing operations table.
[Operational procedure and PostgreSQL source](OPERATION-HISTORY.md#index-migration-and-operations).

## D56 — Check proxy implementation addresses and code at the preparation block

**Decision:** require explicit pool/USDC/aToken implementation pins in the approved
execution configuration. Read the family-specific implementation storage slot and
check both the decoded address and runtime-code hash at the same block as reserve
state. Run this again in existing pre-send preparation. Retain proxy code checks.

**Why:** a proxy's runtime bytecode does not identify its delegated implementation.
Aave's admin-only getter is caller-dependent; storage reads avoid that ambiguity.
Circle's USDC proxy uses a different legacy slot, so assuming ERC-1967 everywhere
would silently misidentify the asset. Primary sources and exact slots are recorded
in [RPC-AND-CONTRACT-IDENTITY.md](RPC-AND-CONTRACT-IDENTITY.md).

**Pros:** stops an observed unapproved upgrade before simulation/send, preserves
explicit operator control and leaves old submitted work reconcilable. Tests exercise
changed implementations under unchanged proxy bytecode and malformed storage/code.

**Cons/limits:** six additional RPC reads per preparation; registry maintenance and
independent implementation review are required. This does not prevent upgrades after
observation, prove RPC honesty, inspect every delegated dependency or generalize to
other proxy families. Observed fork pins remain fixtures; production registry approval
and governance incident response are still open. Auto-adopting the current storage
value or relying solely on upgrade-event monitoring was rejected.

## D57 — Coordinate RPC admission by provider account, independently of endpoint

**Decision:** a Redis atomic script grants weighted spacing using Redis time, with
an explicit account scope, base interval and simulation weight. Every replica sharing
that account must use the same namespace/scope/policy. The persistent policy record
rejects mismatches. Missing coordination fails closed; cancelled grants are not refunded.
Non-loopback transport cannot use the uncoordinated fixture constructor.

**Pros:** keys/URLs may rotate without multiplying quota; no idle burst credits or
unbounded local waiter queue; shared long cooldowns and holds stop follow-on calls
across replicas. Transport metrics have bounded labels and omit endpoint/credentials.

**Cons/limits:** extra Redis traffic and availability dependency; no fairness guarantee,
no exact remote concurrency/billing proof, and lost Redis state can allow fresh grants.
The two-cost model requires validation against the selected provider's actual quotas.
A permanently recorded policy complicates rollout but prevents replicas accidentally
choosing whichever rate was written last. Changing scope to bypass a hold is forbidden
operationally, not technically impossible for a trusted deployment operator. Per-process
limits alone and endpoint-derived quota keys were rejected.

## D58 — Reserve broadcast admission before creating the durable dispatch attempt

**Decision:** check local endpoint/chain and obtain a non-cloneable, client-bound
broadcast permit before journaling. Permit consumption sends at most once and requires
journal completion within two seconds of admission. Existing nonce/preflight/drain
checks remain. No second admission wait or chain request occurs after journal commit.

**Pros:** normal quota pressure leaves unattempted work retryable instead of creating
an unknown attempt that locks a wallet unnecessarily. The database still gates access
to signed bytes before any send. Consumed grants never reappear after cancellation.

**Cons/limits:** failed/slow commits waste reserved capacity. Expiry, drain or process
failure after commit is still ambiguous and requires reconciliation; there is no
cross-system atomic send. A cooldown received after the grant cannot recall it. Waiting
for quota after journaling was rejected because it unnecessarily enlarges that gap;
deleting an ambiguous attempt or automatically resending was rejected because absence
of a receipt is not proof of no broadcast. Production broadcasting remains disabled.

## D59 — Share durable Earn processing while retaining protocol-specific review

**Decision:** extract Aave's orchestration into `LocalEarnService<EarnAdapter>`.
The adapter owns request validation, configuration and preparation; the shared
engine owns intent persistence, nonce coordination, signed staging and reconciliation.
Worker claims and signing responses enforce the provider discriminator. Native
signing shares only session fencing/key lifetime; each client adapter independently
reconstructs its protocol's calldata. See [Morpho execution](MORPHO-EXECUTION.md).

**Pros:** both integrations inherit the same crash, lease and ambiguous-send rules;
provider-specific economics remain reviewable. Existing Aave payload hashes survive.
**Cons:** engine changes need both providers' regressions. Migration 7 renames the
signing table/trigger/index and requires draining old binaries; it is not a rolling
upgrade. Duplicating the whole durable pipeline and an arbitrary-call API were rejected.

## D60 — Use VaultBundlesV1 with explicit deposit and redemption semantics

**Decision:** implement exact-asset deposits with a conservatively rounded maximum
share price and exact-share redemptions with explicit acknowledgment of unprotected
token output. Vault V2's constant-zero `max*` methods cannot gate execution. Verify
configuration, simulate exact balance deltas and recheck before dispatch instead.
Pin contract/source revisions and the ordered adapter/liquidity/fee configuration.

**Pros:** deposit limits are enforced on chain; redemption never fabricates a
minimum payout. **Cons:** redemption is exposed to changing share value, and the
chosen path cannot express fixed-asset withdrawal with a maximum share spend.
Simulation can become stale. Fee-on-transfer assets, permission gates, arbitrary
vaults, force withdrawals and automatic allocation are outside the verified scope.
Direct vault deposits without a share floor and relying on indexed APY were rejected.

## D61 — Keep user allowance and provider fee authority narrow

**Decision:** finite exact-amount approval, with a zero reset when needed. Encode
no permits, zero referral percentage and zero referral recipient. Disclose vault
performance and management fees separately; management fee is per-second WAD, with
an explicitly labeled 365-day annualization in review.

**Pros:** no hidden application fee or reusable permit; both server and client check
every authority-bearing ABI word. **Cons:** more approval transactions and residual
allowance if a later action fails. Zero application referral fees do not imply zero
vault fees or investment risk. Revenue activation and allowance revocation need
separate reviewed flows. Unlimited user approval and implicit referral defaults
were rejected.

## D62 — Bind quotes and deadlines to exact user intent

**Decision:** authenticated 30-second preview quotes bind signer, vault, asset,
amount, policy and source block. New requests carry an explicit vault and canonical
decimal-string deadline; the store continues rejecting all JSON numbers in intents.
The deadline is fixed across retries/preflight, not renewed by the worker. Native
review copies public request/context objects before owner confirmation and fences
wallet/session/lifecycle changes throughout signing.

**Pros:** callers cannot silently switch a vault or extend signed authority, and
share quantities retain exact precision up to 36 decimals. **Cons:** short-lived
quotes/preparations require refresh and cannot guarantee later execution. Quote
reads consume RPC quota; local failures must not turn into unbounded retry loops.
Refreshing a deadline inside dispatch or treating a quote as execution admission
was rejected.

## D63 — Separate Uniswap quote reads from signing authority

**Decision:** implement a fixed-origin Trading API boundary for same-chain exact-input
CLASSIC ERC20 quotes, pinned router version, registered intermediate tokens and no
V4 hooks. Strip all provider transaction/permit payloads from the client response;
execution stays unavailable. See [contract and evidence](UNISWAP-QUOTES.md).

**Pros:** clients can review real provider economics once credentials are configured,
without treating provider calldata as trusted signing instructions. **Cons:** this is
not a completed swap journey; curated routes omit otherwise valid liquidity and the
strict parser needs authenticated compatibility evidence. An unaudited raw-transaction
proxy and replacing the intended Trading API with an unrelated direct-pool demo were
rejected. Next work must independently validate router commands and durable execution.

## D64 — Validate net output and explicit fee policy with integer arithmetic

**Decision:** bind gross/net/minimum output, every fee recipient/rate, wallet, pair,
amount and policy revision. Support whole bps only, maximum four recipients/500 bps,
no unexpected partner fee, finite exact Permit2 amount below its unlimited sentinel.
Quotes expire after 30 seconds. Clients independently check economic conservation.

**Pros:** no gross-output display masquerading as wallet receive, hidden partner fees
or floating-point token rounding. **Cons:** stricter than the provider's full API;
rounding and optional-field interpretation need captured authenticated responses.
Short validity requires explicit refresh. Quote gas excludes approvals; previews do
not guarantee balances, nonce freshness, execution outcome or total network fees.

## D65 — Bound personalized quote traffic and expose limited availability honestly

**Decision:** authenticated reads use database global/per-wallet admission, Redis shared
account quota/cooldown, four local in-flight slots, fixed transport bounds and no retry,
queue or cache. Web and native invalidate results on session/input/lifecycle changes.
Real-wallet native Swap uses registered quote inputs; demo controls are kept in demo mode.

**Pros:** bounded work, shared provider quota, no cached quote crossing wallet/policy
boundaries, no accidental duplicate requests. **Cons:** 240 global requests/minute and
the documented default 6 provider requests/second cannot support arbitrary 10k-user
quote demand. PostgreSQL auth/rate-limit calls add load; negotiated quota, load tests,
physical-device UX and provider acceptance remain required. A local socket experiment
or synthetic transport fixture cannot establish those properties.

## D66 — Pin router source and decode complete canonical command trees independently

**Decision:** target official Universal Router 2.1.2 commit 802fe4c18f47300e0f183e2a42e9146ec2ea9fc3
and its pinned V4/Permit2 dependencies. Implement independent byte-based Rust and
hex-based wallet decoders for the initial CLASSIC vocabulary, including six-field
V2/V3 and nested V4 exact-input/settlement actions. Enforce canonical ABI offsets,
padding and widths and fixed byte/command/hop bounds. Reject unsupported flags and
commands. See [authority contract and sources](UNISWAP-AUTHORITY.md).

**Pros:** no blind provider-calldata trust or version guessing; independent viem
fixtures catch shared encoding mistakes. **Cons:** stricter than Solidity decoding
and not yet proven compatible with authenticated Trading API builds. Two decoders
must evolve together. Source pins do not attest deployed code. Structural decoding
is only a prerequisite: ordered spending, fees, refund ownership and final output
still need semantic validation before signing. An arbitrary-call passthrough and
reusing old five-field examples were rejected.

## D67 — Reconstruct and verify PermitSingle authority without enabling signing yet

**Decision:** reconstruct the fixed Permit2 domain/types, bind exact token/amount/
spender/owner/chain to reviewed terms, verify standard or compact EOA signatures,
and require finite amount, bounded lifetime and canonical low-S. Embedded permits
must be unique, first and match independently supplied authority. Avoid production
Debug/Serialize on decoded signed calldata; zeroize owned signature buffers.

**Pros:** changed domain, nonce, spender, amount or deadlines cannot retain a valid
proof, and wallet reconstruction avoids untrusted provider type definitions.
**Cons:** permit proof does not bind swap output/fee/recipient, prove fresh nonce,
check delegated-code/contract accounts or protect signature persistence. Those
remain service and transaction-review obligations. Low-S and 30-minute/30-day bounds
are stricter than the underlying contract. No signing API is exposed until the
remaining authority and durable execution layers are complete.

## D68 — Prove token flow conditionally on successful pinned-router execution

**Decision:** independently interpret ordered router commands in Rust and TypeScript
against immutable owner/input/output/deadline authority. Track router balance bounds,
V4 debt/credit, aggregate user debit and minimum owner receive. Require cleanup for
possible V3 router leftovers. Use V4's verified zero-delta unlock invariant rather
than pretending pool-manager debt is an ordinary router balance. See
[Uniswap economic proof](UNISWAP-ECONOMICS.md).

**Pros:** covers split and mixed V2/V3/V4 routes, partial fills, exact prepayments and
open-debt settlement without trusting provider transaction bytes. Extra spending,
weakened receive floors and diverted refunds reject. **Cons:** conservative proofs
reject some feasible routes; direct V2 pair prepayment needs a separate identity
proof. This is conditional safety, not transaction-success evidence. Actual deployments,
approved token behavior, signatures/nonces, simulation and durable admission remain
independent gates. A quote estimate or one successful simulation cannot replace them.

## D69 — Make fee basis, order and rounding explicit authority

**Decision:** approve percentages against actual settlement balance, not estimated
quote amounts. Allow up to four uniquely paid recipients after route swaps finish,
from one fee context; reject new credits into that context after fees start. Track
remaining-balance percentage/error bounds with exact rational arithmetic. A rounding
allowance is explicitly zero or one output-token base unit per recipient, never
silently granted. Public authority copied from the reviewed quote stores every
numeric field as a canonical decimal string.

**Pros:** adjusted later fee rates cannot conceal excess effective fees, and fixed
fees must fit the guaranteed balance. Full-width arithmetic avoids floating-point
rounding. **Cons:** one base unit can matter for low-decimal assets and must be shown
in future consent; interleaved/multiple-context fee flows require additional proof.
The checker permits less than the approved fee ceiling and does not enforce provider
revenue collection. It is not a ledger of actual paid fees. Treating each sequential
percentage as a percentage of the original gross output was rejected.

## D70 — Verify actual router execution separately from provider compatibility

**Decision:** run independent Rust/wallet authority checks against locally signed
transactions on a pinned disposable Ethereum fork before adding durable swap
execution. Derive fixture output from actual pool quoters, encode against the
version-specific ABI and measure owner, fee and allowance deltas after receipts.
Keep Trading API acceptance a separate gate. Evidence and reproduction:
[UNISWAP-CONTRACT-ACCEPTANCE.md](UNISWAP-CONTRACT-ACCEPTANCE.md).

**Pros:** exposes contract/encoding discrepancies without public-chain transactions
or provider credentials; covers mixed protocol splits, sequential fees, bounded
approvals, replay and failures. **Cons:** archive access is required; fixture routes
do not prove provider output compatibility, deployed compiler equivalence, actual
partial fills or the future durable HTTP/worker path. Observed code hashes stay
test provenance. A green fork test cannot authorize production activation. Before
integrating signed Permit2 builds, replace plaintext preparation storage for those
builds with encrypted handling; existing Earn calldata is not a model for storing
a still-live transferable permit signature.

## D71 — Encrypt complete built swap preparations before transaction signing

**Decision:** persist Uniswap `PreparedEvm` as authenticated ciphertext in the same
atomic operation/job transition, with separate non-signable recovery metadata.
Bind operation, principal, wallet, plan/request/summary hashes and key ID in a
distinct AEAD domain. Reuse application encryption keys and require old keys for
recovery. Reject Uniswap through plaintext preparation storage and loading.

**Pros:** protects embedded Permit2 signatures before an Ethereum transaction
exists; retains exact signing terms across restart and composes with existing
submission/reconciliation. Owner recovery remains available without keys.
**Cons:** key retention is essential; ciphertext is larger and not compressible
like ordinary JSON. Keyless summary checksums are not authenticated authority;
execution must open and verify the sealed record. Existing Earn data is preserved
without rewrite, but old binaries must drain before sealed writes. Details:
[SEALED-SWAP-PREPARATIONS.md](SEALED-SWAP-PREPARATIONS.md).

## D72 — Carry router size bounds through storage and signed-envelope validation

**Decision:** allow 64 KiB only for a Uniswap action's calldata, 192 KiB for its
canonical plan, 256 KiB for its full signing request, and 65 KiB for its signed
EIP-1559 envelope. Keep existing approval and non-swap limits. Redact call debug
output and wipe owned calldata/canonical/decryption buffers when dropped.

**Pros:** validated mixed routes no longer hit an unrelated 4 KiB storage limit;
all stages remain bounded and Earn's accepted vocabulary is not broadened.
**Cons:** maximum-size records cost more memory, encryption time and I/O; parser
and runtime copies cannot all be guaranteed wiped. The limits are admission
bounds, not proof of successful execution or a capacity result. HTTP body limits
and future native signing review must explicitly support these sizes before activation.

## D73 — Persist public swap authority before accepting a transferable permit

**Decision:** add immutable pre-build reviews, encrypted raw provider quotes and
separately encrypted PermitSingle signatures. Bind each ciphertext to principal,
wallet, operation, intent, review and content hashes in distinct AEAD domains.
Use `awaiting_permit` and `building_swap` states with transactional jobs; exact
signature retries acknowledge existing evidence without replacing or renewing it.
Authenticate the ciphertext even when loading only public terms for signing.

**Pros:** a restart cannot silently substitute user-approved economics or lose the
accepted signature; a public metadata checksum cannot masquerade as authenticated
signing authority. Queue/state/evidence commit together. **Cons:** recovery requires
retained keys, new states require coordinated rollout, and longer review lifetimes
can make provider quotes unusable. Expired quotes must fail or receive a new review;
there is no automatic re-quote. This is repository infrastructure, not a completed
provider or frontend signing flow. See [SWAP-PERMIT-LIFECYCLE.md](SWAP-PERMIT-LIFECYCLE.md).

## D74 — Reserve Permit2 nonce scope until chain finality passes signature expiry

**Decision:** serialize accepted signatures by chain/Permit2/owner/token/spender/nonce.
Keep immutable admission history while allowing guard reuse only after server time
and a verified finalized chain timestamp both pass the inclusive signature deadline,
and a fresh matching nonce observation proves the current nonce. Recheck observation
age and review expiry after lock waits; retain guards after failed builds.

**Pros:** competing operations cannot admit the same live authority; unused expired
permits do not block that nonce forever. Chain time prevents premature release due
to server-clock advance. **Cons:** finality lag delays retries, and the service must
supply verified RPC evidence rather than trusting client timestamps. External wallet
activity and reorgs still require nonce/allowance checks before preparation and
submission. Database fencing cannot cancel a permit already sent to a provider.
Permanent nonce uniqueness and release on application failure were rejected because
they respectively strand unused nonces or permit competing live signatures.

## D75 — Preserve validated quote artifacts and reconstruct only the fixed permit schema

**Decision:** keep the exact normalized provider quote artifact privately alongside
its raw canonical bytes and configured policy snapshot. Build only from authenticated
persisted authority, reconstruct the fixed PermitSingle schema and forward the exact
stored signature. Revalidate current registry/fee configuration and reviewed minimum
before sending; a changed policy requires a new review.

**Pros:** provider construction cannot silently widen approved terms, refresh the
quote or request a different permit. Checksummed provider addresses remain compatible
without altering quote hashes. **Cons:** stricter signing-time lifetime rules may
reject displayable quotes; policy updates can invalidate outstanding reviews. The
artifact does not prove chain state or replace the service's intent binding. Details:
[UNISWAP-BUILDS.md](UNISWAP-BUILDS.md).

## D76 — Treat provider calldata and gas as untrusted construction output

**Decision:** share fixed-origin quote/build transport and account quota, bound builds
by review expiry, require the pinned response router version and independently verify
calldata economics plus the exact embedded signature. Keep EIP-1559 hints separate
from local simulation/nonce admission. Disable provider single-call simulation because
first-use approvals must be validated with the action in a local sequence; a build
is never signing admission. Omit optional SAFE native sweeps in the current
ERC20-only vocabulary; enforce zero native value and reject native routes independently.

**Pros:** redirects, quota bypass, changed terms and excessive fee hints cannot reach
signing preparation. The typed build result exposes immutable verified call data,
with bounded diagnostics and no sensitive Debug/Serialize. **Cons:** missing provider
headers, unsupported refund instructions or schema changes fail closed; actual API
acceptance is still required. Native swaps need additional value/refund accounting.
Provider simulation alone and silently relaxing the economic verifier were rejected.

## D77 — Bind swap preparation to explicit registry and fresh chain evidence

**Decision:** pin router, Permit2, constructor dependencies and the whole approved
token vocabulary at one source block. Require explicit direct/EIP-1967/USDC token
identity, EOA code, matching pending nonce, both allowance layers, source freshness
and finalized-chain evidence. Recheck canonical hashes and export a short-lived
review-bound Permit2 observation. Limit the first preparer to Ethereum/local forks.

**Pros:** provider quote metadata cannot substitute a spender, token implementation,
nonce or chain watermark. Finalized expiry evidence supports reusable permit guards.
**Cons:** registry approval must establish dependency closure/constructor bindings;
all-token/proxy checking costs RPC capacity. Code/nonce state can still change before
inclusion, other chains and account kinds remain unfinished, and pre-send checks are
mandatory. No production policy was approved by observing hashes. Details:
[UNISWAP-PREPARATION.md](UNISWAP-PREPARATION.md).

## D78 — Simulate approvals and swap with observable economic postconditions

**Decision:** create only finite approvals (reset if needed), locally simulate the
ordered sequence, measure owner/fee/router balances and final Permit2 state, and
bind exact nonce/gas/fee terms to the original review expiry. Treat fee amounts in
preparation as simulated estimates; immutable percentages/rounding remain consent
bounds. Provider gas/simulation hints never substitute for this step.

**Pros:** first-use approvals can be assessed without mining them; a successful
simulation status alone cannot conceal balance, fee, allowance or residual failures.
**Cons:** simulation is not inclusion, validation-false requires explicit nonce/gas/
balance checks, and extra state reads increase cost. Standard-token/proxy assumptions
must be reviewed. This path currently has mock evidence only; actual-contract fork
acceptance and durable/frontend integration are still required before activation.


## D79 — Bind the reviewed build transition inside the encrypted preparation

**Decision:** accept the preparer's private result for `building_swap → awaiting_signature`
under the current job/operation fence. Encrypt the review hash and provider request ID
with the full preparation in a version-2 envelope. Authenticate persisted review,
quote and signature and recheck their semantic relationship on write and keyed read.
Commit preparation/state/job/successor atomically; recheck expiry, simulation age and
lease after possible waits. Preserve legacy encrypted decoding only for operations
without reviews. Return review and preparation together to the future signing service.

**Pros:** immutable consent and exact admitted permit survive retries/restart without
plaintext transferable signatures or a separate mutable provenance record. The existing
submission/reconciliation loader enforces the same link. No new schema is required.
**Cons:** keyed reads need more database/decryption work; all referenced old DEKs must
remain available. Drain old readers before enabling version-2 writers. The plan hash
alone is insufficient authority; consumers need authenticated full evidence. Simulated
fees remain estimates. A separate provenance table and weakening the old `created`
transition to accept either state were rejected. This is an internal durability
milestone with mock/isolated-database evidence; full user-flow acceptance remains open.


## D80 — Separate local swap acceptance from production Trading API configuration

**Decision:** introduce an explicit loopback/31337 execution mode with a synthetic
quote/build endpoint and mandatory nonsecret sentinel API key. Keep production quote
origin/allowlist unchanged and reject simultaneous configuration. Require a bounded
192 KiB HTTP body budget for supported signed router calldata. Production broadcast
remains unavailable. Match quote and execution token/router/revision registries.

**Pros:** the complete lifecycle can be exercised without real funds or credentials;
chain-31337 signatures are never passed off as Ethereum signatures. Live API keys
cannot be forwarded through this local constructor. **Cons:** synthetic provider
responses do not prove live Trading API acceptance, and local-fork evidence must be
collected separately. A chain-remapping proxy and unrestricted configurable provider
origin were rejected. Details: [UNISWAP-SERVICE.md](UNISWAP-SERVICE.md).

## D81 — Connect reviewed swap commands, durable execution and native consent

**Decision:** keep an immutable typed swap intent through quote, permit, build and
transaction-signing stages. Supervise a service-owned bounded worker; preflight the
same stored call and remaining transaction suffix before journaled local dispatch.
Reuse nonce guards, encrypted submissions, receipt/finality accounting and native
owner/session/key-lifetime primitives. Independently validate swap economics in the
shared client. Recover admitted Permit2 signatures offline on the device rather
than persisting them locally or signing automatically after restart.

**Pros:** HTTP/worker/recovery share the persisted consent and exact signed terms;
restart and ambiguity do not silently obtain new authority. Native cancellation and
session changes stop key use/submission. **Cons:** Uniswap needs a separate orchestration
path for its permit/build states; some bounded worker/dispatch plumbing parallels
Earn until the lifecycle stabilizes. Simulation/identity RPC cost remains material.
The new service has HTTP-to-signed-admission evidence with synthetic provider/RPC,
but actual-contract dispatch/finality and physical-device behavior remain unverified.
Failing an unprepared build preserves the live permit and its reservation.


## D82 — Exercise the same swap service against real contracts and an ambiguous send

**Decision:** use a bounded disposable fork harness with the real SIWE/HTTP/worker,
shared client and keyring. Construct synthetic provider responses from actual quoter
reads under chain 31337. Preserve production origin/chain restrictions. Inject one
lost response after the local node accepts a transaction; require receipt recovery
and exactly one send per signed hash. Include two fee recipients and an unfillable
minimum that must fail actual simulation before signing.

**Pros:** tests the integration that isolated decoders and mock-RPC tests cannot
prove, including remaining-step preflight, encrypted restart recovery and real token
balance/allowance effects. No application finality or retry rule is bypassed.
**Cons:** requires an archive source and separate local services; fixture code and
observed pins are not live Trading API or production deployment approval. Local
mining is simulated finality and this V3 coverage does not establish every route,
reorg or device flow. Replacing the provider transport or relabeling live-chain
Permit2 signatures was rejected. Evidence: [UNISWAP-SERVICE-ACCEPTANCE.md](UNISWAP-SERVICE-ACCEPTANCE.md).

## D83 — Keep bridge provider reports separate from settlement authority

**Decision:** normalize Relay/Across status into bounded advisory observations and
candidate transactions. Bind reads to immutable route terms and a persisted source
transaction; validate provider identities, chains and aliases. Expose
`verificationRequired: true` and distinguish source finality, reported fill, pending
refund and verified credit. No provider report advances financial operation state.
Across's post-source deposit ID remains a lookup hint until source-event verification
exists; neither it nor the source hash is required in the pre-signing intent.

**Pros:** delayed indexing, provider mistakes, expiry and source success cannot be
mistaken for funds delivered. Recovery does not grant another signature or deposit.
**Cons:** users see an intermediate result, and separate source/destination/refund
verifiers are still necessary. Restricting to single-deposit EVM routes excludes
multi-deposit, embedded-action and non-EVM results. Trusting a provider's terminal
label and requiring the not-yet-created source hash before signing were rejected.
Details and current API evidence: [BRIDGE-RECOVERY.md](BRIDGE-RECOVERY.md).

## D84 — Poll bridge observations durably outside interactive requests

**Decision:** use a PostgreSQL watch keyed by operation with immutable bindings,
expiring claims and version/token fencing. A bounded worker calls fixed provider
origins through shared Redis account quotas/cooldowns and persists the latest
observation. Authenticated history reads only stored data; missing/stale data stays
unknown. Keep polling configuration separate from historical recovery availability.

**Pros:** reconnects and replica restarts recover without duplicate deposits or
per-viewer provider traffic. Stale workers cannot replace newer observations;
provider outages preserve earlier evidence. **Cons:** migration 10 and another
worker lifecycle add operational work; polling costs and backlog need measurement.
The current sequential loop and read quotas are not 10k-user capacity evidence.
A verified terminal-proof stop/archival mechanism is still required before scale
activation. Stopping on a provider success label, storing watches only in Redis,
and making browser reads synchronously call providers were rejected. No public
bridge-execution handoff exists yet; tests use synthetic relational fixtures.

## D85 — Verify direct Across delivery from both chains and exact payment terms

**Decision:** accept a bounded direct ERC20 deposit shape first, with canonical
calldata matching immutable consent. Derive its ID and resolved exclusivity from
the pinned source contract event. Require finalized canonical receipts, historical
proxy/token identity, full original and actual fill terms, and exact standard-token
transfer evidence on the destination. Refresh both chains and recheck source
anchors after destination reads. Proof types have no public constructor/deserializer.

**Pros:** a matching status ID, event name or source success cannot hide changed
recipient/amount, missing payment or an observed reorg. Independent viem fixtures
and actual Ethereum/Base contract forks exercise the parser against external ABI
encoding and runtime behavior. **Cons:** historical RPC reads and identity checks
cost capacity; trusted RPC and reviewed token semantics remain assumptions, not
light-client consensus. The bounded shape excludes periphery callbacks, native
unwraps, multi-fill transactions and changed speed-up terms until independently
supported. It does not prove refunds or production L2 finality. Broadening the
existing single-chain receipt success into bridge success was rejected. Details:
[ACROSS-EVIDENCE.md](ACROSS-EVIDENCE.md).

## D86 — Require source proof before registering an Across status watch

**Decision:** generic watch attachment accepts Relay only; Across uses a separate
handoff taking the private verified source result. Derive its reference/hash/chains,
compare all financial terms against immutable intent, verify the persisted signer
and last signed source transaction, and check proof age after possible database
waits. Continue to expose provider observations as advisory. Recompute chain proofs
for the future outcome writer rather than making stored provider status authoritative.

**Pros:** eliminates caller-picked Across deposit IDs at registration and links
tracking to the original financial operation without a new schema. Existing
historical reads remain unchanged. **Cons:** no public preparation service produces
this handoff yet; durable verified outcomes and their historical anchor policy
still need implementation. The existing watch does not store a settlement proof,
and recovering it cannot by itself claim destination payment. Automatically marking
the operation successful or changing history UI labels merely because a proof
primitive exists was rejected.

## D87 — Across quotes expose checked economics without signing authority

**Decision:** add a protected, operator-reviewed direct same-asset ERC20 route
registry and authenticated exact-input quote endpoint. Bind the owner from the
session, independently decode the deposit, check all displayed amounts against
calldata, cap fees/deadlines and return no signable transaction. Registry review
must establish asset equivalence; matching symbols cannot. Reject unsupported
swap/callback/periphery routes. Share Redis account admission with status reads.
**Pros:** complete client-visible quote contract, bounded provider usage and no
unreviewed provider transaction reaching a signer. **Cons:** narrow coverage and
operator registry maintenance; changes in live response shape can reject useful
quotes. **Alternatives:** generic forwarding or accepting arbitrary token pairs
would make displayed economics and authority dependent on provider metadata.
**Revisit:** authenticated live response evidence plus dedicated decoders and
simulation for additional route families. **Status:** local synthetic transport,
API and client validation; real API credentials/registration acceptance remains
open. Source, configuration and remaining lifecycle: [ACROSS-QUOTES.md](ACROSS-QUOTES.md).

## D88 — Bind exact Swap API attribution bytes, without inferring revenue

**Decision:** immutable direct-deposit terms optionally bind the two-byte
integrator ID. Tagged quotes accept only the exact eight-byte SDK Swap API suffix;
legacy untagged terms retain their exact 420-byte call. No generic trailing bytes
are accepted. Collect no app fee in this initial path. **Pros:** attribution is
preserved through quote decoding and finalized transaction proof; previous
untagged evidence remains valid. **Cons:** provider variants need explicit review;
attribution does not itself monetize the flow. **Alternatives:** stripping the
suffix breaks attribution, while accepting arbitrary suffixes weakens exact
transaction binding. **Revisit:** registered integrator/fee terms and separately
verified destination fee callbacks and settlement. **Status:** exact/mutated
suffix unit tests and actual-contract two-fork tagged deposit/fill evidence.
The test ID is synthetic and proves no registration or fee entitlement.
See [tagged fork proof](evidence/across-direct-tagged-local-fork-2026-10-18.json).

## D89 — Rotate device-bound refresh credentials as a family

**Decision:** add random opaque 30-day refresh families bound to a random device ID;
store only token hashes, atomically mark each token spent, and serialize rotation on
the family row. Reuse revokes the family and every access session issued from it.
Access tokens remain 15 minutes and refresh never grants transaction authority.
**Pros:** short access exposure, cross-replica revocation in PostgreSQL, and a replay
signal that cannot silently mint another credential. **Cons:** concurrent refresh or
lost responses can be classified as replay and force a new SIWE sign-in; database
availability is required. The device ID is an identifier, not proof of hardware.
Mobile now stores the refresh family through the secure-store adapter and rotates it
while foregrounded; background/lock suspends access and resume requires owner
confirmation plus a protected-profile check. The extension uses the same exact-message
SIWE flow but receives only a 15-minute access token in the foreground popup; it requires
a dedicated backend origin configuration and manual re-sign-in. User-visible device
revocation remains open. Origin-bearing requests receive no refresh credential; this is
origin gating, not device attestation. **Alternative:** repeat SIWE every 15
minutes avoids refresh-secret lifecycle complexity but harms durable native sessions.
**Revisit:** physical-device and packaged-extension acceptance, device revocation,
lost-ack recovery, and browser response isolation. See
[IDENTITY-AND-DURABILITY.md](IDENTITY-AND-DURABILITY.md).

## D90 — Keep mobile refresh secrets in secure storage and suspend access on lock

**Decision:** persist only the rotating refresh token, family device ID, expiry and
verified wallet identity through the existing secure-store adapter; keep the short
access token in memory. Rotate one minute before access expiry while foregrounded.
Background or app lock clears access/profile but retains the encrypted refresh record;
resuming requires local owner confirmation, the same active wallet/configuration,
fresh rotation, and an authenticated profile read. A family is deleted on explicit
sign-out or wallet switch. **Pros:** one foreground session can outlive repeated
15-minute access tokens without storing an access bearer; app background does not
silently perform network work. **Cons:** a lost rotation response may consume the old
token and force SIWE recovery; mobile platforms and native networking still require
physical-device verification. The web adapter stores through the password-locked vault;
extension refresh is not enabled because Origin-bearing requests are denied refresh.
**Revisit:** device revocation UI, extension persistent-session policy, and iOS/Android
locked/background acceptance. The extension currently uses access-only foreground
sessions. No transaction-signing authority is persisted by this session feature.

## D91 — Jitter financial-worker retries without dead-lettering ambiguity

**Decision:** Earn and swap workers retain their reconciliation-first,
non-dead-letter policy for ambiguous financial work, but preserve a bounded attempt
counter and schedule retries with capped exponential full jitter (1–256 seconds).
**Pros:** sustained provider/database failures do not synchronize every worker to
the same fixed 15-second retry boundary, while a crash or timeout still returns work
to a durable queue. **Cons:** retries can take longer and are not FIFO; this does not
prove external submission safety, which remains governed by operation state and
reconciliation. **Alternative:** dead-letter after a fixed retry count would strand
potentially valid financial operations and was rejected.

## D92 — Keep extension auth access-only under the browser Origin boundary

**Decision:** extension refresh remains unavailable because the server rejects
Origin-bearing refresh requests. This is a security boundary, not evidence that the
extension currently has a backend sign-in flow: the current extension UI is vault-only
and does not wire the reviewed SIWE client. **Pros:** avoids implying an integration
that is absent and preserves the server's explicit refresh policy. **Cons:** extension
backend identity, access-token lifetime and revocation UX remain unimplemented; the
earlier proposal to keep a popup-only token has not been accepted as shipped behavior.
**Alternative:** persist browser credentials or loosen refresh Origin checks without a
cookie/CSRF design was rejected. **Revisit:** when extension auth is implemented and
tested against a packaged extension ID. See [IDENTITY-AND-DURABILITY.md](IDENTITY-AND-DURABILITY.md).

## D93 — Timestamp price samples when a validated response is published

**Decision:** set `sampledAtMs` from Redis `TIME` inside the fenced publication
operation, after the complete upstream response has been validated. Do not stamp at
poll admission. **Pros:** advertised freshness includes the request latency and the
same shared clock used by Redis coordination; a slow response cannot appear younger
than it is. **Cons:** this measures when Honey accepted the response, not the venue's
exchange/event timestamp, so an upstream endpoint can return an old price in a new
response. The feed remains descriptive mid/last data and not an execution oracle.
**Revisit:** adopt provider event timestamps only if the source exposes trustworthy,
validated per-instrument event times and the public contract can distinguish them.

## D94 — Bind Hyperliquid private reads to the SIWE-proven wallet

**Decision:** expose a read-only clearinghouse snapshot for the authenticated EOA
wallet only; never accept a caller-selected Hyperliquid address. Keep provider
decimal values as validated strings, cap response bytes and position count, and
return an explicit upstream sample time. **Pros:** avoids arbitrary-account reads
through a stolen bearer and provides actual venue position state without Honey
custody or signing. **Cons:** this does not prove the EOA has a Hyperliquid account,
does not cover separately linked accounts/subaccounts, and each read costs a provider
request. No result should be treated as a tradeability or liquidation guarantee.
**Alternative:** central order signing was not enabled because there is no verified
user-owned signer, nonce scope, builder-fee consent or reconciliation path. See
[HYPERLIQUID-PERPS.md](HYPERLIQUID-PERPS.md).

## D95 — Keep Relay and Hyperliquid account UI informational

**Decision:** expose Relay only as an authenticated quote-step preview and
Hyperliquid only as a manually refreshed read of the SIWE-bound EOA. Clear results
when inputs, session, wallet, or page visibility change; reject an account response
whose address differs from the active wallet. **Pros:** users can inspect real
provider route shape and account state while transaction/signature payloads stay out
of the UI and no stale response crosses a wallet/session switch. **Cons:** Relay
economics/fees and Hyperliquid position freshness remain incomplete, and the account
read is user-triggered rather than streamed. **Alternative:** wire either panel into
the existing demo trade/order flow was rejected until provider eligibility, verified
fee terms, signer support and submit-time reconciliation are evidenced. Mobile
Hyperliquid account display is implemented but needs device acceptance; live provider
acceptance remains open. See
[RELAY-QUOTE-PREVIEW.md](RELAY-QUOTE-PREVIEW.md) and
[HYPERLIQUID-PERPS.md](HYPERLIQUID-PERPS.md).

## D96 — Keep authenticated load-generator credentials local and attributable

**Decision:** the external capacity client may create up to 15 short-lived sessions
with deterministic public test keys through the normal SIWE endpoints, then call only
an exact loopback `/api/v1/me` target; redirects are disabled, tokens stay in memory,
responses are checked against each wallet, and requests are distributed round-robin.
The bound respects the configured 30 proof attempts/minute/IP when each login needs a
challenge and verification. **Pros:** exercises distinct PostgreSQL-backed principals
without a test-only auth bypass or caller-supplied secret and emits per-principal load
counts. **Cons:** this does not create thousands of identities, test a login burst,
simulate realistic client IP distribution or establish financial-workload capacity.
Profile-only mode validates auth distribution without a price publisher, but does not
measure WebSocket or mixed-workload capacity. Public test keys must never hold funds. See
[CAPACITY-LOCAL.md](CAPACITY-LOCAL.md).

## D97 — Keep unimplemented perps and prediction orders preview-only

**Decision:** mobile Perps and Predict screens may show preview values, but their
order controls stay disabled and cannot create local success, position, or purchase
state while the backend capabilities remain unimplemented. Copy identifies sample
markets/balances and unavailable settlement. **Pros:** avoids presenting a local
simulation as an order sent to Hyperliquid or Polymarket, while retaining market
preview UI for later contract integration. **Cons:** users cannot complete these
flows until authenticated execution, signing, reconciliation, and provider
acceptance are implemented. A backend capability becoming available alone must
not restore the old demo handler; the mobile route needs a real execution adapter
first. See [IMPLEMENTATION.md](IMPLEMENTATION.md).

## D98 — Require a wallet-owned raw EVM signer before web Earn execution

**Decision:** keep web Aave/Morpho catalogs and operation recovery read-only until a
wallet integration can return the exact raw signed EIP-1559 transaction bytes that the
server verifies and durably broadcasts. Current web EIP-1193 use is limited to SIWE
`personal_sign`; `eth_sendTransaction` returns a hash and cannot satisfy the
`signedTransactions` API contract. Do not substitute the hash, bypass server
verification, or broadcast directly from the UI. **Pros:** keeps the existing immutable
review, recovered-envelope validation, idempotent dispatch and operation-recovery
boundary intact. **Cons:** web users cannot execute Aave/Morpho until a signer adapter
and its consent UX are implemented. **Alternative:** adding generic
`eth_signTransaction` assumptions without provider compatibility evidence was
rejected. **Revisit:** after selecting a supported wallet capability, validating
chain/account/nonce/fee/calldata against the reviewed preparation, and testing signed
bytes through the existing submission endpoint. See [AAVE-API.md](AAVE-API.md) and
[MORPHO-EXECUTION.md](MORPHO-EXECUTION.md).

## D99 — Suspend private account display and public stream in hidden web tabs

**Decision:** on `visibilitychange` to hidden, abort the in-flight Hyperliquid account
read, clear account values, stop the public price WebSocket and mark its last snapshot
stale. Reconnecting the price stream is automatic when visible; private account data
requires explicit user refresh. **Pros:** limits background exposure of balances and
positions and avoids spending socket/provider capacity for an inactive tab. **Cons:**
users must manually reload account state after returning, and price reconnect has a
brief fresh-data gap. **Alternative:** retain background account data or leave the
stream open was rejected because neither improves correctness while the UI is hidden.
The behavior is covered by web component tests; it does not replace browser runtime
acceptance. See [IMPLEMENTATION.md](IMPLEMENTATION.md).

## D101 — Report configured service scope separately from production availability

**Decision:** capability schema version 3 reports separate action and read-only
feature IDs (for example `swap`/`swap_quotes`, `earn`/`earn_catalog`, and
`predictions`/`prediction_markets`). `providers` lists planned integrations while
`configuredProviders` lists adapters constructed at runtime. Execution remains
unavailable or `local_testnet`; read-only quotes, catalogs and authenticated account
reads use `read_only`. No service is labeled production from configuration alone.
**Pros:** the frontend can represent mixed configurations accurately, such as a
working catalog alongside local-fork execution, and can distinguish a planned bridge
provider from one actually configured. **Cons:** v1/v2 clients must upgrade; the extra
feature IDs require UI consumers to select the intended operation; scope reports
constructed configuration rather than upstream health except for price freshness.
**Alternative:** one blended feature per product or infer availability from environment
flags was rejected because it conflates discovery with money movement and cannot
represent mixed provider state. **Revisit:** add `production` scope only after provider
eligibility, signer compatibility, fees, reconciliation and operational acceptance are
evidenced. See
[IMPLEMENTATION.md](IMPLEMENTATION.md).

## D102 — Enforce access-only sessions in the extension client

**Decision:** the extension build refuses a sign-in response containing either
refresh field, revokes the returned access session with a bounded request, and
never offers the native refresh/resume path. It also removes any local refresh
record if the extension lifecycle checks for resume availability. The server
continues to enforce the primary boundary: Origin-bearing browser requests receive
no refresh credential and cannot call refresh. **Pros:** a server regression cannot
silently turn a popup session into a persistent browser credential, and user-visible
extension policy matches client behavior. **Cons:** a server that accidentally
returns refresh fields will cause sign-in to fail; revocation is best effort when
the API is unreachable. **Alternative:** relying only on the server Origin check
was rejected because the documented extension guarantee should also be enforced at
the client boundary. Tests simulate this contract violation and verify revocation
and absence of local persistence. Packaged Chrome acceptance remains open. See
[IMPLEMENTATION.md](IMPLEMENTATION.md) and
[IDENTITY-AND-DURABILITY.md](IDENTITY-AND-DURABILITY.md).

## D103 — Allow exact additional browser origins for SIWE

**Decision:** keep `AUTH_ORIGIN` as the primary SIWE origin and allow up to seven
additional exact origins through `AUTH_ADDITIONAL_ORIGINS`. Every configured origin
must also be explicitly present in `CORS_ALLOWED_ORIGINS`. Challenges sign the
selected origin; verification requires the same exact request Origin. Requests with
no Origin remain native and use the primary origin. Origin-bearing sessions remain
access-only and refresh is rejected. **Pros:** web and a packaged extension can share
one deployment without weakening the origin boundary or granting a browser durable
credentials. **Cons:** deployments must provision the installed extension ID exactly,
and origin changes require configuration rollout. **Alternative:** wildcard/subdomain
matching or selecting one origin implicitly was rejected because it weakens SIWE
audience binding and makes browser/native policy ambiguous. Config and route-level
acceptance tests cover allowlisted, disallowed, cross-origin verification and access-only
extension behavior; live PostgreSQL acceptance and packaged extension validation remain
environment-dependent. See `IDENTITY-AND-DURABILITY.md`.

## D104 — Link wallets only with a fresh proof under an existing session

**Decision:** `/me/wallets` lists EOA memberships for the authenticated user.
Adding one requires a separate five-minute SIWE challenge with a link-specific
statement, bound to the exact configured origin, chain, session digest and user.
The submit transaction locks the live session, consumes the proof once, and takes
an address-scoped advisory lock before enforcing the global `(chain_id,address)`
ownership constraint. Membership is capped at 64 wallets per principal. A wallet
owned by another principal returns conflict; users
are never merged implicitly. **Pros:** existing wallet login remains distinct from
account linking, and replay, cross-session proof use and concurrent claims fail
closed across replicas. **Cons:** this first cut is same-chain EOA-only and does
not support unlink, watch-only addresses, smart accounts or multi-chain recovery;
active sessions continue to reference memberships. **Alternative:** reusing the
login challenge was rejected because it would create/resolve principals rather than
prove explicit link intent. The separate table is forward-only and pruned after expiry.
PostgreSQL race/replay coverage is in the ignored durability suite and needs the
disposable database service to execute. See `IDENTITY-AND-DURABILITY.md` and
`ARCHITECTURE.md`.

## D105 — Bound identity reads and keep metrics on loopback

**Decision:** `/me` and `/me/wallets` apply global and per-principal fixed-window
limits; wallet-link address quotas are charged only after authenticating the live
principal and are scoped to that principal. Metrics remains optional and binds only
to an IPv4/IPv6 loopback address because its scrape route is unauthenticated and
contains operational data. Across and the other operation-creation handlers share
one parser that rejects duplicate, empty, non-graphic or over-128-byte idempotency
keys. **Pros:** bearer-driven profile load is bounded, unauthenticated callers cannot
starve a victim's link quota, and metrics cannot be exposed by accidentally binding
to a public interface. Canonical keys keep cross-provider idempotency semantics
consistent. **Cons:** remote Prometheus must use a local proxy/sidecar; profile reads
above the configured limits receive 429; deployment operators must proxy loopback
metrics intentionally. **Alternative:** rely only on private-network policy was
rejected because the process configuration could silently bind publicly. Unit tests
cover external bind rejection and key parsing. See `OBSERVABILITY.md`.

## D106 — Expose bounded queue health through private metrics only

**Decision:** sample due-ready, leased, expired-lease and dead-job counts plus oldest
relevant ages every 30 seconds. Each count stops at 10,001; that value means “at
least 10,001.” The probe is indexed and bounded, emits fixed state labels only, and
publishes a last-success timestamp and refresh outcome. Metrics remain on loopback;
there is no public queue endpoint because SIWE users have no operator role. **Pros:**
operators can detect backlog and dead letters without exposing job IDs, wallet data,
intents or error codes, and each probe has a fixed upper bound. **Cons:** counts are
saturated rather than exact at high volume, metrics repeat the same shared-DB values
on every replica, and this does not provide per-worker visibility or replay control.
Use max rather than sum across replicas. Worker retry policies also differ, so dead
counts do not represent all retrying work. **Alternative:** adding an admin token or
treating a wallet as an administrator was rejected because neither trust primitive
has an audited lifecycle. An additive partial index supports the dead-job age probe.
PostgreSQL integration tests cover states and ages. The new index uses a
nontransactional concurrent build to avoid blocking queue inserts during rollout;
operators must inspect invalid-index state after interruption. See
`OBSERVABILITY.md` and `OPERATION-HISTORY.md`.

## D107 — Build the queue metrics index concurrently

**Decision:** create `jobs_dead_created` with `CREATE INDEX CONCURRENTLY` and mark
the embedded SQLx migration `no_tx=true`. Queue health instrumentation must not
pause durable job writes while indexing an existing database. **Pros:** normal
inserts and worker updates remain available during index construction. **Cons:** the
build consumes additional I/O, cannot be wrapped in a transaction, and may leave an
invalid index or completed index without matching migration bookkeeping after a
process interruption. Operators must inspect `pg_index.indisvalid` and reconcile
before retrying. **Alternative:** ordinary transactional `CREATE INDEX` was rejected
because it can block writes while scanning a populated jobs table. See
`OBSERVABILITY.md` and `OPERATION-HISTORY.md`.

## D108 — Rate-limit native refresh through the shared proof boundary

**Decision:** keep `/auth/refresh` inside the same identity proof route layer as
challenge, verification, and wallet-link proof endpoints. It uses the existing
1,200-per-minute global backstop and 30-per-minute canonicalized-IP bucket before
refresh-token parsing or database work. The handler continues to reject every
`Origin` header, so only originless native clients can rotate refresh families.
**Pros:** malformed or random bearer-shaped input cannot trigger unbounded indexed
lookups and transactions, while the existing mobile native flow remains supported;
the shared limiter also keeps its global cardinality guard. **Cons:** refresh shares
the proof IP quota, so a client behind a heavily shared NAT can receive 429 during a
burst; deployments must monitor this before raising limits. **Alternative:** a
separate unauthenticated refresh quota was not added because it would create another
policy and storage namespace without evidence that the existing per-IP budget is
insufficient. An ignored PostgreSQL route test checks native rotation and the 31st
same-IP request returning 429; execute it with the disposable `TEST_DATABASE_URL`.
See `IDENTITY-AND-DURABILITY.md`.

## D109 — Simulate distinct proxy clients only in loopback load tests

**Decision:** the independent capacity generator may set `X-Forwarded-For` only
when its HTTP and WebSocket targets are loopback URLs and the supplied test IP is
also loopback. This lets the coordinated authenticated-profile test model five
source-IP quota buckets while the local server trusts one proxy header; the server
itself must bind only to loopback during the run. Five 20-RPS shards respect the
current 1,200/minute authenticated profile IP quota; four 25-RPS shards do not.
**Pros:** the test can drive the documented aggregate 100 RPS without disabling
real quota middleware or changing production code, and the harness prevents
forwarding synthetic identities to public targets. **Cons:** it does not test a
real proxy chain, trusted-proxy network enforcement or production NAT behavior;
misconfigured reachable deployments must not reuse this test setup. **Alternative:**
raising the profile quota or turning off the limiter for the test was rejected
because it would mask production admission behavior. Unit tests assert local URL
constraints and WebSocket header construction; the coordinated acceptance run must
still be captured with current binaries. See `CAPACITY-LOCAL.md`.

## D110 — Report bounded WebSocket connection failure classes

**Decision:** the external load generator reports handshake timeouts, HTTP 4xx,
HTTP 5xx, transport I/O and other failures as fixed counters; it never records
raw errors, response bodies, headers or URLs. **Pros:** a failed capacity gate can
separate admission responses from transport/resource failures without leaking
request details or creating unbounded labels. **Cons:** broad classes still need
server-side logs or metrics for root cause, and one run cannot identify a transient
host limit. **Alternative:** treating every failure as only a closed socket was
rejected because it prevents diagnosing a failed 10k gate. The schema-v4 report
field is covered by unit tests; the optimized rerun remains pending. See
`CAPACITY-LOCAL.md`.

## D111 — Count bounded server-side admission reasons

**Decision:** add fixed-reason counters for price WebSocket handshake rejection
(`price_socket_handshake_rejections`) and global HTTP admission rejection
(`http_admission_rejections`). Keep the existing normalized request status-class
metric; these counters add attribution without exposing request, wallet, IP, Redis
error, or provider text. **Pros:** the 10k harness can distinguish local socket
capacity, drain/snapshot, Redis lease transport/capacity and global HTTP admission
rejections on the same process. **Cons:** counters identify a branch, not the
underlying OS/Redis cause; all replicas still need a shared scrape/aggregation path.
Feed-unavailable routes without a MarketHub have no stream metric registry, though
global admission is still counted. **Alternative:** exact status/body labels or raw
error logs were rejected because they risk cardinality and sensitive data leakage.
The label allowlist and HTTP admission saturation path have tests; a release-mode
10k rerun remains pending. See `CAPACITY-LOCAL.md`.

## D112 — Keep provider quote admission out of the identity database

**Decision:** use an atomic Redis fixed-window pair (provider-global and wallet)
for authenticated provider quote routes; keep SIWE proof/session quotas and durable
operation controls on PostgreSQL. Use Redis server time and one Lua evaluation so a
denied second bucket does not partially consume the first. Key material is hashed,
namespaced, and colocated by Redis hash tag. Morpho quotes use the read-class budget;
operation creation/submission retain mutation limits. **Pros:** quote bursts no
longer perform two serialized PostgreSQL upserts per request, per-provider budgets
are isolated, and replicas share exact counters. **Cons:** quote admission becomes
Redis-availability dependent and Redis failure must fail closed; Lua/script rollout
and cluster slot behavior need real-Redis tests; global provider limits still require
product traffic sizing and provider concurrency budgets. **Alternative:** keep
PostgreSQL counters was rejected for hot quote traffic because the schema reserves
them for low-volume identity routes. Initial limits remain conservative (240
provider-global/minute, 10 wallet/minute; Morpho read class 600/60). See
`CAPACITY-LOCAL.md`.

## D113 — Trust forwarded client IPs only from configured proxy networks

**Decision:** when `TRUST_PROXY_HEADERS=true`, use the rightmost appended
X-Forwarded-For address only if the actual TCP peer matches an explicit
`TRUSTED_PROXY_CIDRS` entry. Otherwise key quotas by the socket peer. Apply this to
auth proof/profile limits, pairing mailbox limits and price WebSocket leases; reject
startup when forwarded trust is enabled without a bounded CIDR allowlist. **Pros:**
a direct client cannot rotate arbitrary forwarded values to evade IP quotas, while
valid static/private proxy ranges remain supported. **Cons:** the operator must keep
CIDRs synchronized with proxy address pools; incorrect ranges silently make all
clients share or use their peer bucket; this does not verify the proxy sanitizes the
header chain or prevent direct network access. **Alternative:** trusting the bool
alone was rejected because deployments can accidentally expose the origin. Tests
cover IPv4/IPv6 range matching and forged headers from an untrusted peer. See
`IDENTITY-AND-DURABILITY.md` and `.env.example`.

## D114 — Commit terminal worker failure with its job acknowledgement

**Decision:** when a worker rejects an unprepared operation, atomically update the
operation to failed, mark the fenced source job done, and insert the `operation.changed`
outbox job in one PostgreSQL transaction. Remove the later best-effort `complete`
call from the worker path. **Pros:** a crash or lease expiry cannot strand an expired
job for an already-terminal operation, consume retries, or inflate expired-lease
backlog; an acknowledgement failure rolls back the operation/outbox too. **Cons:**
the source-job acknowledgement is now part of the terminal transition transaction
and may make the entire result conflict if the lease expires while waiting for locks.
**Alternative:** periodic stale-job cleanup was rejected because it repairs the
symptom after a crash and risks hiding unrelated fencing defects. A PostgreSQL test
injects a source-job completion constraint failure and asserts the operation, source
job and outbox all roll back. Run it with isolated `TEST_DATABASE_URL`. See
`PREPARATION-AND-RECOVERY.md`.

## D115 — Bound pairing payload memory by protocol slot and aggregate bytes

**Decision:** validate protocol-specific slot lengths in both the route and store,
retain the existing 10,000-global/24-per-subject reservation limits, and atomically
cap reserved pairing payload bytes at 32 MiB in Redis Lua. During rollout, count
legacy reservations at the maximum 16 KiB until their normal expiry. **Pros:** the
payload portion of Redis memory has a deterministic aggregate ceiling across API
replicas; malformed large commit/nonce/reveal values are rejected before Redis
allocation; concurrent sends cannot oversubscribe the byte quota. **Cons:** the
32 MiB figure excludes Redis key, hash and sorted-set overhead; migration may
temporarily deny new pairings; Redis Lua isolates operations but does not roll back
earlier writes after runtime errors, so an allocation failure can conservatively
hold capacity until expiry. **Alternative:** rely only on the 10,000-slot count was
rejected because 10,000 maximum-size payloads could reserve roughly 156 MiB before
Redis overhead. See `REDIS-AND-PRICES.md`; live Redis tests remain an acceptance gate.

## D116 — Bound aggregate HTTP request-body buffering

**Decision:** retain the per-request body ceiling and request-count semaphore, and
add a per-process 16 MiB aggregate payload budget reserved in 1 KiB quanta before
copying request data. Reserve a valid Content-Length before allocating the body
buffer; for chunked traffic, reserve additional quanta as frames arrive. Reject
admission with 503 rather than queueing more buffered bodies. **Pros:** independent
configuration maxima can no longer multiply into 10 GiB of buffered payloads;
memory pressure becomes explicit bounded backpressure. **Cons:** the budget is per
replica and covers payload bytes, not allocator, frame, parsed-object or other
process overhead; oversized concurrent workloads may see 503s and still require
proxy limits and deployment headroom. **Alternative:** only validating the product
of two environment values was rejected because a fixed runtime budget also protects
when operators raise both limits. See `IMPLEMENTATION.md`.

## D117 — Fail closed on dApp transaction effects the wallet cannot review

**Decision:** use one review function at both approval rendering and immediately
before private-key retrieval. Decode the supported EVM transfer/approval selectors
and complete EIP-712 domain; block unknown or ambiguous calldata and malformed or
unrenderable signed fields. For Solana, allow only structurally parsed direct
System Program SOL transfers and compute-budget limit/price instructions; block
address lookups and all other instructions. **Pros:** the action shown to the user
is derived from the exact payload that will be signed, and UI gaps cannot bypass
the signer gate. **Cons:** token amounts remain raw units without verified token
decimals or bytecode semantics; most Solana programs and complex EVM calls are
unavailable. **Alternative:** show a generic “unknown call” and permit confirmation
was rejected because it leaves asset effects opaque. See the mobile signing and
keyring tests.

## D118 — Bound dApp read-only extension RPC work

**Decision:** bound requests at content ingress and background routing by payload
size, per-origin/global rolling rate and concurrency, and bound provider reads by
request size, `eth_getLogs` range, 15-second deadline and 1 MiB streamed response.
Return a standard busy/invalid provider error on admission failure. **Pros:** a
connected or unconnected page cannot create unbounded queued or response-buffering
work in the extension worker. **Cons:** quotas are local to the running browser
profile and reset on worker/browser restart; legitimate high-polling sites can be
throttled, while public RPC provider quotas remain separate. **Alternative:** rely
on upstream RPC throttling was rejected because request and response buffering
already consumes client resources. See extension RPC tests.

## D119 — Bound Hyperliquid account reads per server process

**Decision:** admit at most eight concurrent Hyperliquid clearinghouse reads per
server process with a non-waiting semaphore; return the normal busy response when
all slots are occupied. Emit only fixed provider/operation/outcome labels and
elapsed milliseconds. **Pros:** provider latency cannot accumulate an unbounded
local wait queue, and operators can distinguish failed account reads without
logging wallet identifiers, provider bodies or request URLs. **Cons:** the limit is
per process, so aggregate concurrency scales with replica count; shared identity
quotas still need Redis in distributed deployments. **Alternative:** a waiting
semaphore was rejected because queued authenticated reads would consume request
capacity and amplify provider recovery spikes. Live-provider acceptance remains
open. See `hyperliquid_perps.rs`.

## D120 — Expire the global price-socket lease index

**Decision:** refresh a 60-second TTL on the shared global socket-lease sorted set
after every successful acquire or renewal. This matches the lease window and lets
Redis reclaim the index after the final client disconnects even if no later
handshake runs. **Pros:** avoids stale per-process key accumulation without a
separate cleanup worker; active clients preserve the key by renewing. **Cons:** a
Redis outage or missed renewal can expire the whole index and cause existing
connections to fail their next renewal; clients must reconnect under the existing
fail-closed policy. The TTL bounds key lifetime, not memory while many leases are
active. **Alternative:** periodic cleanup worker was rejected because it adds
another lifecycle and scheduling dependency for a key already governed by leases.
The Redis PTTL assertion compiles, but requires `TEST_REDIS_URL` for runtime
acceptance. See `REDIS-AND-PRICES.md`.

## D121 — Run bounded auth retention under a cross-replica advisory lock

**Decision:** run expired-auth cleanup from the supervised dependency
monitor only when authentication is configured and the required schema is ready.
Each invocation takes a PostgreSQL transaction advisory lock with try semantics,
deletes bounded batches, and removes a refresh family only after its
sessions and spent-token replay records are gone. Keep the one-shot `prune-auth`
command for maintenance. **Pros:** cleanup is automatic across replicas without a
new scheduler; a second replica skips instead of duplicating work; active sessions
and replay history remain protected through multi-batch deletion. **Cons:** old
records remain through the expiry grace and bounded backlog-drain time; runtime SQL
has not yet been exercised because no isolated Postgres is available. **Alternative:**
run an uncoordinated cleanup loop in every replica was rejected because it creates
avoidable write contention and can race on family retention. See `database.rs`,
`runtime.rs`, and auth-cleanup integration coverage.

## D122 — Inspect dead letters with a bounded read-only CLI

**Decision:** provide `honey-server dead-letters [limit] [before-job-id]` as a
one-shot operator command, with a 1–100 page size and keyset pagination. Return job
and operation identifiers, fixed error code, attempts, topic, and timestamps only;
never return persisted intent, signed material, provider bodies or credentials. Do
not expose the query through the public API. **Pros:** operators can diagnose
dead-letter backlog without direct SQL or a new remotely reachable admin surface.
**Cons:** CLI access still requires trusted host/database access and is not a
dashboard or auditable role system. Replay stays unavailable because lease fencing
does not prove an external financial side effect did not occur. **Alternative:**
provide a generic replay command was rejected until each provider has an explicit
reconciliation/idempotency policy. The isolated Postgres test is compile-checked,
not executed in this environment. See `work.rs` and durability integration tests.

## D123 — Keep auth quotas ephemeral and make durable cleanup converge

**Decision:** when Redis is configured, use Redis-time fixed-minute Lua quotas with
TTL for proof/profile global+IP admission and per-address/per-user limits. Require
`REQUIRE_INFRASTRUCTURE=true` in production so missing Redis prevents startup; Redis
errors fail closed and never fall back to PostgreSQL. Direct `Identity` fixtures may
use the atomic PostgreSQL compatibility limiter, with pair denials rolled back. Keep
sessions, challenges, refresh rotation, and replay-protection records durable in
PostgreSQL. Run cross-replica cleanup every minute: 50,000 expired rate rows, at
least 5,000 expired challenge rows, and 20,000 session/token/family records per
table per run, with a 10-second maintenance deadline. **Pros:** public request churn no longer
leaves persistent limiter subjects; Redis failure cannot silently weaken admission;
the compatibility path and retained historical rows drain faster than configured
maximum ingress. **Cons:** public auth now depends on Redis availability and its TTL
keys consume transient memory; cleanup batches can create periodic database write
work. **Alternative:** keep all per-subject counters in PostgreSQL was rejected
because worst-case distinct-subject ingress exceeded hourly cleanup by orders of
magnitude. Redis failover can lose recent quota state, so Redis persistence/HA and
edge protections remain deployment concerns. Tests cover Redis quota semantics/TTL
and ignored disposable-Postgres parity/backlog drain cases; runtime acceptance
requires isolated Redis/PostgreSQL. This supersedes the DB-counter portion of D22
and updates the D121 cleanup cadence. See `identity.rs`, `redis_store.rs`,
`database.rs`, and `runtime.rs`.

## D124 — Admit per-wallet request quotas atomically through Redis

**Decision:** use the existing atomic global+subject quota primitive for every
active route that has both shared and per-wallet limits (Aave, Morpho, swap
execution, Across create/submit, bridge status and Hyperliquid account reads).
Use Redis-backed subject quotas for operation recovery and Across intent/signing
reads. Keep the PostgreSQL compatibility implementation for isolated Identity
fixtures. Route quota domains are fixed, bounded lowercase identifiers accepted by
Redis validation. **Pros:** a wallet that has exhausted its own quota cannot burn
shared capacity with rejected requests; configured runtime quotas avoid writing a
PostgreSQL minute row per request; Redis decisions remain cross-replica. **Cons:**
these routes now depend on Redis for quota admission and fail closed on Redis
failure; per-wallet quota state is ephemeral and can reset after Redis state loss.
**Alternative:** separate sequential global and subject increments was rejected
because a single authenticated wallet could consume the global allowance entirely
with requests rejected by its own limit. Tests already assert this invariant for
Redis and disposable-Postgres pair admission; runtime execution requires isolated
services. See `identity.rs`, `redis_store.rs`, route handlers and quota tests.

## D125 — Zeroize pairing byte buffers and retire session keys at lifecycle boundaries

**Decision:** overwrite owned mutable buffers for one-time X25519 private keys,
nonces after their final transcript use, X25519 shared secrets, HKDF inputs/outputs
that are intermediate, payload plaintext bytes, and pairing session keys. Pairing
helpers use `finally` so errors and aborts take the same cleanup path. Mobile and
extension flows clear offer/answer secrets when the handshake ends, and clear
session keys after payload transfer, cancellation, timeout, error, restart or view
disposal; the key remains available through code comparison and payload encryption
or decryption. The QR/mailbox wire format is unchanged. **Pros:** reduces the time
that reusable byte buffers hold wallet-transfer secrets and makes cleanup auditable
at ownership boundaries. **Cons:** JavaScript engines do not promise secure erasure;
strings such as the JSON-serialized mnemonic, decoded mnemonic, React state, runtime
copies, garbage-collected copies and crypto-library internals cannot be reliably
zeroized. This is best-effort memory hygiene, not a guarantee against process dumps,
compromised runtimes, swap or platform memory snapshots. **Alternative:** relying
on garbage collection was rejected because owned `Uint8Array` buffers can be
overwritten deterministically. Pairing tests verify the cleanup helpers overwrite
their referenced arrays while end-to-end key agreement and payload tests preserve
the existing protocol behavior. See `packages/keyring/src/pairing.ts`, mobile
`pair-offer.ts` / `pair-phone.ts`, extension `pair.ts`, and their UI owners.

## D126 — Never represent demo deposits as real balance changes

**Decision:** remove the timed fake receive that marked onboarding as funded and
announced “$25 arrived.” Keep local savings and cash-purchase walkthroughs only on
demo wallets, label balances as examples, and state on simulated outcomes that no
funds or transactions occurred and no real-wallet balance changed. Demo funding state
uses `markDemoFunded`, and demo earn no longer creates multisig proposals. **Pros:**
opening Receive cannot fabricate a funded state; unavailable cash rails cannot mutate
a real wallet; users see explicit disclosures before and after local simulations.
**Cons:** the first-deposit walkthrough no longer auto-populates a demo balance; demo
wallet screens still contain illustrative amounts. **Alternative:** retaining the
timed transfer with a demo toast was rejected because the onboarding funded flag also
changes wallet presentation and success copy could be mistaken for a real deposit.
This is UX disclosure, not chain or provider acceptance. See mobile savings, receive,
cash-purchase screens and `demo-money-copy.ts`.

## D127 — Apply shared peer admission before bearer-session lookups

**Decision:** when runtime identity and Redis are both configured, place one
Redis-backed IP admission layer before authenticated operation, quote and account
handlers. It applies a shared 300,000-request/minute global budget and a
6,000-request/minute per-peer budget (IPv6 grouped by `/64`), using the existing
trusted-proxy allowlist and last-appended `X-Forwarded-For` parsing. Auth proof and
profile routes are excluded because they already have stricter dedicated IP
quotas. The per-wallet route quota remains in place after authentication. **Pros:**
syntactically valid random bearer tokens can no longer force unbounded PostgreSQL
session lookups without first consuming shared peer/global admission; Redis keeps
limits consistent across API replicas and fails closed on transport errors.
**Cons:** each protected request adds one Redis Lua round trip; shared NATs share
the peer budget; Redis failover may reset recent counts. The chosen ceiling is a
starting policy, not capacity evidence, and must be revisited with representative
10k-user traffic. **Alternative:** relying only on wallet quotas was rejected
because those counters are reached only after the session query. See
`routes/identity.rs`, `lib.rs`, and its Redis-backed admission test.

## D128 — Fence Polymarket cache writes with bounded refresh leases

**Decision:** both catalog and order-book refreshes write Redis cache entries only
through a Lua script that verifies the refresh-lock owner in the same atomic
operation. The old order-book lease was five seconds despite an admission/fetch path
that could run longer; the catalog lease was ten seconds while dependency timeouts
can be configured up to ten seconds. Catalog locks now last 30 seconds; order-book
locks last 60 seconds. Their tested bounds include the configured maximum Redis
timeouts, retry wait, four-second upstream request, and a safety margin. **Pros:** a
late worker cannot overwrite a newer replica's observation after lease takeover, and
leases cover normal bounded work. **Cons:** after a crashed owner, peers may wait up
to the longer TTL before refreshing; a runtime pause can exceed any finite lease, but
the atomic owner check prevents stale cache mutation. **Alternative:** increasing TTL
alone was rejected because expiry can race a late cache write. Redis integration
coverage verifies current-owner publication, stale-owner rejection after takeover,
and rejection after lock deletion; a pure bound test checks configured timeout limits.
See `routes/polymarket.rs` and `scripts/polymarket_cache_publish.lua`.

## D129 — Spread price socket lease renewals across a burst

**Decision:** derive each public price socket's first distributed lease renewal
phase from its random connection UUID, spreading the first renewal over 10–20
seconds after admission; subsequent renewals remain 20 seconds apart. The Redis
socket lease lasts 60 seconds. **Pros:** a burst of connections is less likely to
submit thousands of renewal commands at one instant and exceed the bounded Redis
command pool, causing synchronized disconnects. **Cons:** UUID-derived timing only
smooths renewal load; Redis saturation or outage still closes sockets, as required
for accurate distributed connection caps. This is not a measured 10k guarantee.
The target soak must track lease-related close reasons and Redis busy outcomes.
**Alternative:** queue or batch all renewal writes in a central scheduler; defer
that added coordination until the jittered cadence is measured under the configured
topology. See `routes/prices.rs` and its lease scheduling test.

## D130 — Apply shared admission to public Polymarket reads

**Decision:** apply a Redis-backed pre-handler IP/global quota to the public
Polymarket catalog and order-book GET routes, including deployments with wallet
authentication disabled. Use the shared 300,000/minute global and 6,000/minute
peer ceilings, trusted-proxy allowlisting, and IPv6 `/64` bucketing. **Pros:**
unauthenticated cache hits and refresh misses cannot monopolize process admission
or Redis/provider read capacity without consuming a shared budget; Redis failures
fail closed before the catalog or book handler. **Cons:** public clients behind
one NAT share the peer budget, and each request adds a Redis round trip. The
ceilings are initial policy values and require workload measurement. **Alternative:**
relying on the process-local HTTP semaphore alone was rejected because it does not
isolate public market traffic from other routes or coordinate limits across replicas.
See `routes/identity.rs`, `lib.rs`, and the isolated Redis admission test.

## D131 — Make dApp approval an explicit owner-confirmed boundary

**Decision:** require owner re-authentication before granting a dApp connection,
signing or sending, then atomically claim the pending approval before any signing,
proposal creation, or connection side effect. Disconnect synchronously rejects
unclaimed requests for that origin. If owner confirmation and claim win the race,
the already-approved request may finish. Claim is idempotent while a request stays
pending, so a resumed approval window can re-authenticate and retry after a transient
signing failure. Empty-calldata calls to a contract remain
available only after a separate acknowledgement that fallback code is unreviewed;
all other unreviewable transaction shapes remain blocked by the existing shared
review function. **Pros:** a stale approval window cannot act on a request revoked
by disconnect, and an address is not granted to a site without explicit owner
confirmation. **Cons:** one more authentication prompt adds friction, and claimed
requests intentionally have a clear linearization point rather than being cancelled
by a later disconnect. The fallback checkbox acknowledges uncertainty; it does not
simulate or decode arbitrary fallback behavior. **Alternative:** letting every
unrecognized call through with a warning was rejected because warning-only review
does not establish affirmative consent. Router race tests cover both orderings; UI
still requires release validation on native and extension runtimes. See the
extension router, approval screen, and `dapp-sign.ts`.

## D132 — Bound WalletConnect JSON-RPC response memory and time

**Decision:** impose a 15-second end-to-end fetch/body deadline and a 1 MiB maximum
response size, checking declared content length and streamed byte counts before JSON
parsing. Cancel the body on timeout or overflow and retain the normal JSON-RPC result
and provider-error contract. **Pros:** a slow or oversized configured RPC endpoint
cannot hold a wallet request indefinitely or allocate an unbounded response before
parsing. **Cons:** large legitimate historical reads may exceed the cap; those should
use a fit-for-purpose endpoint or narrower query, rather than relaxing a wallet-wide
memory bound. Web uses streamed Fetch; React Native uses XHR with a timeout and
response-text byte checks on progress because the native Fetch implementation does
not expose a readable stream. The native networking stack may buffer data before a
progress callback, so XHR enforces a prompt application cap but is not proof of a
strict pre-allocation memory bound. Unit tests cover both transport paths, but
shipped-device acceptance remains a release gate. See
`apps/mobile/src/lib/json-rpc.ts` and `apps/mobile/src/lib/walletconnect.ts`.

## D133 — Keep legacy API route stubs registered but fail closed

**Decision:** retain the documented `/accounts`, `/session-signatures`, `/relay`,
and `/monitoring/triggers` route shapes for compatibility, but return the
standard `not_implemented` error until their ownership, persistence, adapter and
authentication contracts are implemented. Do not add placeholder success responses
or route them to generic handlers. **Pros:** existing clients receive a stable,
explicit unavailable response, and unfinished financial/security behavior cannot be
mistaken for a working endpoint. **Cons:** registration can be misread as feature
support by clients that only inspect paths; capability responses and API docs must
continue to mark these features unavailable, and the stubs should be removed when
compatibility is no longer needed. **Alternative:** delete the routes immediately;
that avoids misleading discovery but breaks legacy clients with a less specific 404.
These stubs contain no read or write implementation; they remain subject to the
same HTTP envelope/body limits as other API routes. See `routes/v1.rs` and the
`accounts.rs`, `session_signatures.rs`, `relay.rs`, and `monitoring.rs` handlers.

## D134 — Return accepted status for Across operation staging

**Decision:** Across operation creation and signed-operation submission use HTTP 202,
matching Aave, Morpho, and Uniswap asynchronous operation endpoints. Exact idempotent
replays retain 202 because the response remains the accepted operation's current
recovery snapshot. Quote reads remain 200. **Pros:** API consumers can apply one
submission contract across providers and distinguish accepted work from completed
reads. **Cons:** clients must still inspect the operation state; 202 does not promise
that bridge settlement or destination delivery has completed. **Alternative:** use
200 for synchronous PostgreSQL staging; rejected to avoid a provider-specific status
contract. The Across HTTP acceptance test asserts create and replay behavior.

## D135 — Bound Polymarket Gamma catalog pagination

**Decision:** ingest Gamma `/markets/keyset` pages serially using its documented
`after_cursor`/`next_cursor` contract, with a maximum of 10 pages, 1,000 retained
markets, and 4 MiB total upstream response bytes. Each page is separately capped at
100 markets and 1 MiB; display text is capped per field to keep the cached projection
small. Repeated cursors, malformed cursors, oversized pages, or a
cursor attached to a short page fail the refresh; the existing stale-cache fallback
may serve the last complete snapshot, and partial refreshes are never published.
Market IDs are deduplicated in first-seen order. The client API paginates over the
cached bounded snapshot with a numeric cursor and reports `sourceTruncated` when
Gamma still advertises another page at the configured bound. **Pros:** discovery
extends beyond the first page while upstream work, memory, cache size, and refresh
lease duration remain bounded (including both cache-publish and lease-release Redis
timeouts); a cursor cycle cannot cause an infinite walk.
**Cons:** markets beyond the 1,000-item bound are omitted and the local numeric
cursor can refer to a refreshed snapshot if a user pauses across the 30-second cache
freshness window. Clients should restart browsing after a refresh. The backend
continues to expose public metadata and books only; this does not enable prediction
orders. Fixture tests cover multiple pages, ID deduplication, repeated cursors, and
the configured page/market caps. No live Gamma traversal has been used as release
evidence; provider contract correctness is based on the official
[keyset pagination documentation](https://docs.polymarket.com/api-reference/markets/list-markets-keyset-pagination).

## D136 — Sign the EVM transaction whose fee cap the user reviewed

**Decision:** prepare the nonce, gas limit and fee caps before approval, display the
exact maximum fee from that prepared transaction, and pass the same immutable
preparation to the signing boundary. Refuse signing if the request no longer matches
the reviewed chain, destination, value, calldata, or caller-specified gas limit.
Do not refresh provider fees after consent. **Pros:** the user's fee approval is
bound to the transaction actually signed, and fee volatility cannot silently raise
the maximum spend; key material is not loaded when the binding fails. **Cons:** a
prepared fee cap or nonce can become stale while the screen is open, so the
transaction may fail and require the user to reopen and review it. Silently
repreparing was rejected because it could exceed the disclosed fee. A shared-wallet
proposal remains a separate flow and states that network fees are paid when the
proposal executes. Tests cover missing preparation, request mutation, and a provider
fee change after review; the same prepared transaction is signed and broadcast.

## D137 — Apply pre-auth admission at the private route-group boundary

**Decision:** mount bearer-authenticated operation, bridge, Across, Relay quote,
Aave, Morpho, Hyperliquid account and swap handlers in one private subrouter and
apply shared peer/global admission to that entire group before handler execution.
Mount public Polymarket catalog reads in their own group with a separate shared
peer/global limiter. Keep identity proof/profile routes outside both groups with
their existing tighter quotas, and keep wallet-specific limits in domain handlers
because quote, read and mutation costs differ. **Pros:** adding a handler to either
protected group cannot silently miss its pre-handler budget due to a stale method/
path matcher; public and private workloads retain independent budgets. **Cons:** a
new sensitive route can still be misclassified if mounted outside the private
group, so router composition and the integration regression covering a newly
introduced private path remain review points. Configuration routes colocated with
private handlers also receive the generous private peer budget. This is a structural
guardrail, not a substitute for route inventory review.

## D138 — Disabled 501 stubs do not parse request payloads

**Decision:** keep the legacy account, session-signature and relay routes returning
the existing typed 501 error, but remove JSON extraction from handlers that do no
work. These routes are not authenticated because they do not implement an action;
before adding behavior, introduce authentication, ownership, operation-specific
quota, strict input validation and replay/idempotency controls. **Pros:** a caller
cannot make a disabled stub deserialize attacker-controlled JSON or mistake a
successful parse for implemented behavior; endpoint paths remain stable for
clients that use capability discovery. **Cons:** malformed requests to these
stubs now receive 501 instead of extractor-level 400/422 responses, and the
unauthenticated paths remain routable. Removing them from `/api/v1` was deferred
because route compatibility may matter; capabilities continue to report the
features as unavailable. An integration test asserts a malformed body still gets
the deliberate `not_implemented` response.

## D139 — Grant package write only to the image-publishing workflow job

**Decision:** split pull-request image validation from push/tag publication. The
PR job builds both architectures with `contents: read` only; the publish job gets
`packages: write`, registry login, and image push only for push events. **Pros:**
same-repository pull requests no longer receive a token that can publish container
packages, while branch/tag release behavior remains. **Cons:** build steps and
metadata configuration exist in both jobs and must stay aligned; a shared local
action would reduce duplication but adds another workflow abstraction. Workflow
YAML parsing and permission assertions were checked locally; GitHub-hosted event
execution has not been observed from this worktree.

## D140 — Keep local fixes and regression tests for advisories without upstream releases

**Decision:** retain the `braces@3.0.3` and `node-forge@1.4.0` patches and consumer-
resolved regression tests while upstream publishes no fixed version; do not suppress
these advisories from `pnpm audit`. **Pros:** the exact reported recursion-depth and
RSA DigestInfo-validation cases are guarded, and tests resolve the packages through
Expo/Metro consumers rather than a disconnected direct import. **Cons:** registry
audit continues to report two high advisories, so maintainers must review upstream
releases and patch applicability on every update; the local patch is not an upstream
release or independent exploit certification. A current `pnpm audit --prod` reports
both GHSA records, while tests cover nested braces/ASTs and extra DigestAlgorithm
elements. Cargo audit with a refreshed 1,338-advisory database found no vulnerable
crate, with two unmaintained-crate warnings (`derivative` and `paste`).

## D141 — Bound authenticated pairing mailbox polls

**Decision:** Redis-backed pairing receives use a shared `pairing_poll` dual quota
of 120 requests per minute per hashed channel-and-client subject and 30,000 per
minute globally, applied after token authorization and before the Redis mailbox
script. The client bucket follows the same trusted-proxy rules as pairing sends.
**Pros:** a holder of a valid pairing token cannot drive unbounded Redis polling;
separate channels and peers do not consume each other's subject budget, and the
shared global ceiling bounds aggregate poll load across replicas. **Cons:** clients
that poll faster than twice per second can receive 429 and must back off; this is
Redis-backed, so the in-memory development fallback does not provide distributed
poll quotas. A valid token can still read only its own token-derived channel.

## D142 — Publish Aave withdrawal rounding policy to signing clients

**Decision:** include `maximumAtokenRoundingRaw` in the public Aave execution
configuration and require client review to derive its withdrawal spend ceiling from
that returned value. **Pros:** an operator can tune reserve-specific raw-unit dust
without causing valid operations to fail the client's independent signing check;
the client still refuses a spend that exceeds the exact advertised policy. **Cons:**
the public configuration response gains a required field, so older clients that
strictly validate the prior response shape must be upgraded together. Regression
coverage verifies a three-unit policy accepts only the matching three-unit spend.

## D143 — Pin server image build inputs

**Decision:** pin the `xx`, Rust builder and distroless runtime multi-architecture
manifest digests, and install compiler and cross-compiler packages from the
timestamped Debian snapshot selected by `DEBIAN_SNAPSHOT`. Keep the PR image job
read-only and reserve registry write permission for push/tag builds. **Pros:**
the same source revision selects stable base-image and package inputs across
architectures, and an untrusted PR cannot publish an image. **Cons:** snapshots
can accumulate known vulnerabilities and do not receive package updates until
the timestamp/digests are deliberately refreshed; maintainers must periodically
review advisories, rebuild both architectures, and validate the resulting
runtime. These pins improve input repeatability but do not by themselves provide
provenance, signatures, image scanning or a fully reproducible binary.

## D144 — Keep the first extension provider slice read-only and popup-scoped

**Decision:** after exact-origin SIWE sign-in, expose only a user-triggered
Hyperliquid account read using an access token held in popup module memory; bind
the returned account to the signed-in wallet, abort the read on unmount, and
submit no order or transaction. **Pros:** the extension now exercises the real
authenticated API and wallet ownership boundary without exporting signing power
or persisting provider/account data. **Cons:** closing the popup loses the local
session and loaded view, while the server access token can remain valid until
its 15-minute expiry if revocation cannot be attempted; users must sign in again
to refresh account data. Keep remote revocation errors visible for explicit
sign-out and account switches. Other provider reads and every financial action
remain separate reviewed slices.

## D145 — Apply global and per-wallet quotas to Across recovery reads

**Decision:** Across intent recovery uses a 600-request global and 60-request
per-wallet minute quota; signing-request reads use 120 global and 20 per-wallet.
**Pros:** aggregate database/recovery load remains bounded as the number of
wallets grows, matching the dual-quota pattern used by other provider reads.
**Cons:** a shared global budget can throttle legitimate users during a burst or
provider incident; revisit these values against measured traffic and expose quota
rejections in operational metrics. The previous subject-only limits scaled with
wallet count and did not provide a service-wide ceiling.

## D146 — Reject future-dated Polymarket catalog cache entries

**Decision:** Treat a catalog `fetchedAtMs` later than the serving replica's
current wall clock as older than the stale window. Do not use saturating
subtraction to classify that entry as age zero. **Pros:** replica clock skew
cannot make an old shared catalog appear fresh or eligible for stale fallback;
the service attempts a bounded refresh instead. **Cons:** during clock skew, a
valid cache entry may be discarded and the upstream queried earlier, increasing
provider load. Keep replica clock synchronization monitored and retain the normal
request and refresh bounds.

## D147 — Preserve expired submission recovery without reopening execution

**Decision:** verify immutable envelope bytes at the stored simulation timestamp
before checking for an identical persisted submission. A matching retry returns
recovery even after plan expiry. New staging requires current application time
and database expiry checks, including after lock waits; dispatch has its own
expiry checks. **Pros:** a lost response remains recoverable after the signing
window closes without permitting a new expired submission. **Cons:** envelope
verification alone is not permission to stage or broadcast; callers must retain
the orchestration and database checks. Replacing the historical timestamp with
current time before the replay branch would incorrectly reject valid recovery.

## D148 — Separate API mirrors from worker collection and execution

**Decision:** add explicit `SERVER_ROLE=combined|api|worker`, defaulting to
combined. API processes keep Redis-to-local price/Earn mirrors and product
routes; workers run collection, financial processing, bridge reconciliation and
periodic auth retention, with only health/readiness HTTP routes. Both keep
infrastructure probes, queue metrics, supervision and bounded shutdown. Split
roles require Redis; configured pool limits apply to every process.

**Pros:** API replica count no longer multiplies provider polling, financial
worker loops or retention scans; worker pressure and failures can be isolated
from user-facing processes while existing deployments retain their behavior.
**Cons:** operators must deploy and monitor both roles and align namespace and
configuration. Dependency readiness does not detect missing remote workers.
Configured adapters are still constructed in both roles, so credentials are not
yet separated by privilege. Streams remain part of the API role, and this change
does not establish 10k-user capacity, N-1 behavior or production readiness.

## D149 — Quarantine restored state before reopening a deployment

A backup can resurrect revoked authentication and omit transactions already sent
outside PostgreSQL. A green readiness probe cannot detect either condition. Use an
offline auth-invalidation transaction, fenced old processes, a new Redis namespace
with reconciled policy controls, retained historical encryption keys and externally
reconciled financial journals before reopening. The checked-in SQL retains replay
and ownership evidence; it does not delete financial state or rewrite immutable
intent. See [recovery procedure](RECOVERY-RESTORE.md).

**Benefits:** deterministic auth reset, reproducible real logical-restore test,
fail-closed key recovery, and explicit treatment of the backup-loss window. The test
restores into a separate database and exercises owner checks and dispatch uniqueness.
**Costs:** all users reauthenticate/re-pair, historical keys need controlled retention,
external reconciliation can extend downtime, and operator fencing is essential.
**Alternatives:** blindly restarting workers risks replay from incomplete history;
a separate revocation/dispatch epoch could automate some gates but introduces a
second durable recovery authority and still cannot reconstruct missing transactions.
We do not claim this runbook provides that automation or proves production RTO/RPO.

## D150 — Keep accepted prices while aging a rolled-back Redis sequence

A lower same-epoch sequence remains inadmissible as a replacement price snapshot,
but it no longer prevents aging the last accepted WebSocket frame. This preserves
monotonic sequence display and propagates `stale=true` while a restored collector
catches up. Coalescing still suppresses identical notifications. A regression checks
the serialized WS payload, preserved price/sequence, stale gauge and later recovery.
The tradeoff is continued display of the last accepted price explicitly marked stale;
resetting the sequence would instead permit older prices to look like new updates.

## D151 — Share immutable Across intent interpretation across settlement readers

The service stores a strict typed `across_local_v1` intent with `terms`, while the
older proof-store fixtures use `acrossDirectDeposit` plus `bridgeTracking`. Requiring
only the old keys prevents service-created operations from attaching or settling.
A shared interpretation now accepts the explicit supported typed schema and the
existing legacy proof schema without rewriting either canonical intent or its hash.
Typed consent binds saved calldata, amount/minimum, recipient, chain route, revision
syntax and original quote/deadline bounds; a service discriminator never falls back
to legacy parsing. Mixed/unknown service shapes fail closed.

**Benefits:** create, attachment, settlement and readback agree on immutable consent;
existing records keep their exact hashes; historical expired evidence remains usable
for reconciliation. Signed-source, canonical receipt, wallet, lease and delivery
checks remain mandatory. **Costs:** two explicitly supported historical formats and
a dependency on versioned fee/registry configuration remain. A migration that rewrote
consent would invalidate signing evidence; removing legacy support would strand its
records. Neither is justified for this compatibility fix. Current registry mismatch
still stops the Across worker; retain historical configuration until reconciliation.
