# Backend security and release review

**Status: in progress; not a security certification or a production launch approval.**
This review covers the Honey Wallet backend and connected clients at source level.
The completed Codex Security deep scan (ID `3527ae14-d406-415a-a902-81352f62748e`)
examined the then-current checkout snapshot and reported four candidate findings.
Its coverage is partial, so neither it nor this review proves the repository is
free of vulnerabilities.

The later deep scan (ID `8896af5b-10d3-406d-b836-6f87ba0532a3`, report
`/Users/swayam/.codex/state/plugins/codex-security/scans/honey-wallet/7a27ec4741f3b5f7c2f30bf5eb922564c1720a79_20261019T052025Z_id24nfum/report.md`)
reported two low-severity candidates. Its report says repository-wide inventory
generation failed and source coverage is partial, despite a completed scan status;
therefore it is evidence for reviewed files only. The missing-WebSocket-Origin
candidate is an accepted protocol choice for an unauthenticated public display
feed: browsers supply Origin and disallowed supplied origins are rejected, while
native clients may omit it. The image-input candidate led to immutable base-image
digests and a fixed Debian snapshot in `apps/server/Dockerfile`; both AMD64 and
ARM64 builds now pass, and the AMD64 image ran as UID 65532 with its in-container
healthcheck returning HTTP 200. This verifies a local build, not hosted workflow
execution, image scanning, signing or provenance.

The latest deep scan (ID `265322fc-68f8-4a43-911e-fc7a09418a9a`, report at
`/Users/swayam/.codex/state/plugins/codex-security/scans/honey-wallet/7a27ec4741f3b5f7c2f30bf5eb922564c1720a79_20261019T061757Z_cp1kpjuf/report.md`)
returned zero reportable findings, but is not evidence of a clean repository.
Its report describes a selected-source review, says substantial in-scope code
remains unreviewed, and lists 13 reviewed files; `coverage.json` simultaneously
claims `complete` while listing no surfaces, and completion warns that the worktree
changed during scanning. Treat this result as partial pending a complete inventory
and source review; do not use its empty findings list as a release gate.

The changed-worktree diff review (ID `aee43625-64ce-4ed4-b2e5-36473ea0fc54`)
captured 357 changed-file review items at working-tree digest
`codex-security-snapshot/v1:sha256:81a6d4424e4b85f793f6b21dc3c0c73635516d0b6624d20962c69584e9cfc887`.
Parallel focused reviews found no confirmed exploit in the examined wallet
clients, web/API client, or backend route changes. A market-cache review found a
future-dated Polymarket catalog timestamp could be treated as age zero under
replica clock skew; the code now treats future timestamps as beyond the stale
window, with a regression test and D146. The scan snapshot predates that fix and
the full 357-item diff review remains in progress; this is not a completed
security clearance.

## Current recovery-focused backend pass

The 2026-10-19 [backend recovery review](RECOVERY-SECURITY-REVIEW.md) accounts for
99 production Rust/Lua files and all 14 migrations, with a source-hash inventory.
It adds a real logical dump/restore drill, offline auth invalidation, Redis rollback
staleness correction, Across drain alignment, and a shared Across intent reader
for attachment/settlement. Its evidence is scoped to backend production source;
it does not close the older repository-wide diff scan or the deployment gates.
The [restore runbook](RECOVERY-RESTORE.md) requires old-writer fencing, historical
keys/configuration, provider-policy reconstruction and financial reconciliation.

## Scope and evidence

This pass reviewed production Axum route composition, identity and owner scoping,
provider preparation/signing/reconciliation boundaries, Redis/PostgreSQL queues
and caches, price WebSockets, HTTP runtime limits, logs/traces/metrics, deployment
and capacity documents, CI image permissions, license wording, and Aave client/server
contract alignment. Independent read-only endpoint, provider, and infrastructure
reviews were reconciled with current source. The provider review found no confirmed
transaction-authorization or construction flaw in the inspected paths. This was
not a line-by-line review of every client, contract, and dependency source file. A
separate completed Codex Security deep scan found four candidate issues (one medium,
three low), with partial repository coverage; remediation status is summarized below.

Verification on 2026-10-19:

- `pnpm lint`, `pnpm typecheck`, and `pnpm test` passed with Node 25.2.1 and loopback
  access. A first sandboxed test attempt failed because four existing Uniswap fixture
  tests could not bind their loopback server; rerunning with loopback permission passed.
  Node 20.20.2 fails web tests before test discovery because the repository requires
  Node >=22.13 and the installed `undici`/`jsdom` combination requires a newer runtime.
- Against a separately started, disposable PostgreSQL/Redis Compose project,
  `cargo test -- --include-ignored` passed the server library and all service-backed
  tests enabled by that command. This included route admission, PostgreSQL auth and
  operation durability, Redis quotas and cache fencing, WebSocket capacity/drain,
  provider fixture execution/reconciliation, and trace export. The new focused
  pairing quota regression and the Aave public configuration integration test were
  then run separately against the same disposable services and passed.
- The load reports in [CAPACITY-LOCAL.md](CAPACITY-LOCAL.md) are local, single-host
  acceptance evidence. They do not demonstrate production traffic, multi-replica
  resilience, or 10,000 authenticated users.
- Focused security regressions passed for mobile signing display and native device
  authentication; the pairing quota identity unit test, Redis-backed limiter test,
  and route-level same-IP/different-channel Redis test passed. Independent reviewers
  found no concrete bypass in those candidate fixes.
- On the current tree, `pnpm lint`, `pnpm typecheck`, and `pnpm test` passed with
  Node 22.22.3; one sandboxed suite attempt denied loopback for four Uniswap fixture
  tests, and the full rerun with loopback access passed. Two additional ignored
  Redis-backed checks passed against a disposable service: stale Hyperliquid lease
  cleanup cannot remove a successor, and the production WebSocket router rejects a
  foreign Origin while accepting an originless native client. The local pinned
  multi-architecture image build passed for AMD64 and ARM64; an AMD64 container ran
  as UID 65532 and passed its in-container `/health` probe.
- The deep-scan report is stored outside the repository at
  `/Users/swayam/.codex/state/plugins/codex-security/scans/honey-wallet/7a27ec4741f3b5f7c2f30bf5eb922564c1720a79_20261019T040714Z_pafof3bh/report.md`.
  It reviewed 984 inventory files and 230 source families across 7,140 paths, with
  290 modified paths in the captured snapshot; coverage status is PARTIAL. Findings
  were one medium and three low. The scan itself did not include the later fixes
  documented below, so this local report records their current verification status.

## Review results

| Area | Result | Evidence and remaining work |
| --- | --- | --- |
| Private endpoint admission and ownership | No confirmed bypass or IDOR in reviewed routes; Across recovery reads now have both global and per-wallet quotas. | Bearer-bearing route families share peer/global Redis admission when authenticated runtime infrastructure is enabled; route-specific wallet quotas and owner-scoped repositories remain in handlers ([router](../../apps/server/src/lib.rs#L199-L233), [identity](../../apps/server/src/routes/identity.rs), [operations](../../apps/server/src/routes/operations.rs)). Across intent/signing reads use 600/60 and 120/20 global/subject quotas; a disposable-PostgreSQL route test verifies per-wallet and aggregate admission. Production non-loopback auth configuration requires Redis. The production composition test passed with disposable Redis. |
| Pairing mailbox | Caller-controlled channel quota evasion fixed in the Redis-backed path. | Token authorization precedes a distributed quota of 120 polls/minute per hashed canonical client bucket and 30,000/minute globally, before the Redis mailbox read ([handler](../../apps/server/src/routes/pairing.rs#L247-L274), [store](../../apps/server/src/pairing_store.rs#L92-L98)). A route-level Redis test confirms valid distinct channels share one resolved-IP quota while a second IP has a separate bucket ([test](../../apps/server/tests/api.rs)). In-memory development mode does not have a distributed poll quota. |
| Mobile native reauthentication | Recovery-phrase/no-device-security bypass fixed. | `confirmOwner` now requires an enrolled device lock by default; only sign-out opts out explicitly. Lifecycle tests verify no-lock denial and sign-out opt-out ([auth](../../apps/mobile/src/lib/auth.ts), [sign-out](../../apps/mobile/src/app/(account)/sign-out.tsx), [tests](../../apps/mobile/tests/auth-lifecycle.test.ts)). |
| Mobile signing review | Bidi and invisible formatting display issue fixed in reviewed paths. | Message and typed-data scalar values, schema paths, primary type, and domain labels visibly escape controls, bidi marks/isolates, variation selectors, and Unicode tag characters without changing the signed payload ([review helper](../../apps/mobile/src/lib/dapp-sign.ts), [approval screen](../../apps/mobile/src/app/(connect)/approve.tsx), [tests](../../apps/mobile/tests/dapp-sign-security.test.ts)). EIP-712 nested structs are walked to scalar fields; arbitrary noncanonical object-as-scalar behavior is not separately tested. |
| Wallet seed recovery | Open protocol blocker remains. | Solana test `known_recovery_target_preemption_blocks_fixed_certificate` documents that an exposed current owner can rotate to a public recovery target commitment and invalidate a fixed recovery certificate ([runtime test](../../contracts/bunk-solana/tests/runtime.rs#L438-L455)). Ordinary owner advancement alone preserves the certificate, but targeted preemption does not. Contract redesign, migration compatibility, and equivalent EVM behavior require dedicated review before production recovery guarantees are claimed. |
| Aave client/server policy | Contract mismatch fixed. | Public configuration now includes `maximumAtokenRoundingRaw`; client review derives its withdrawal spend ceiling from that configured value ([server](../../apps/server/src/aave_service.rs#L55-L68), [shared type](../../packages/api-client/src/types.ts#L456-L468), [validator](../../packages/api-client/src/aave.ts#L17-L109)). Tests accept a three-unit policy only with a matching three-unit ceiling, and the HTTP test checks the returned value while rejecting RPC/key fields. |
| Provider execution | No confirmed authorization or transaction-construction exploit found in reviewed code; live-provider readiness remains unproven. | Aave, Morpho, Uniswap, and Across require explicit local-fork configuration, loopback RPC, and chain 31337. Relay is quote-only; Hyperliquid is authenticated/read-only; Polymarket is read-only. See [deployment gates](DEPLOYMENT-READINESS.md) and provider decisions in this directory. Mainnet signer/provider compatibility, fees, eligibility, contract pins, and settlement acceptance still require independent proof. |
| WebSockets and resource limits | Bounds are present; production capacity is not established. | Price WebSockets validate disallowed origins, bound frames and connection/lease counts, and use Redis shared leases ([prices](../../apps/server/src/routes/prices.rs#L75-L95), [lease coordinator](../../apps/server/src/markets.rs#L108-L128)). Missing `Origin` is accepted for non-browser clients; the feed is public, so this is a hardening choice rather than a demonstrated confidentiality issue. HTTP body, aggregate buffering, inflight and deadline limits are enforced in [http_runtime.rs](../../apps/server/src/http_runtime.rs). |
| Persistence, queues, and cache | Atomicity/fencing paths passed the available disposable-service tests; terminal queue accumulation is fixed and regression-tested. | PostgreSQL outbox/operation transitions, worker leases, Redis quotas, pairing slots, and cache publication fencing have integration coverage. Failed operations and successful Across settlements no longer create unclaimable ready continuation jobs; ignored durability, settlement and swap regressions passed locally against disposable PostgreSQL. A separate local logical-backup restore drill now exercises encrypted unknown operations and offline auth reset; production PITR, failover and multi-region consistency remain unproven. |
| Logs, traces and metrics | Redaction and private metric exposure tests passed. | Request logs use route templates and omit request data; panic payloads are not emitted ([telemetry](../../apps/server/src/telemetry.rs)). The metrics listener is restricted to loopback ([config](../../apps/server/src/config.rs#L430-L435)); local OTLP export/redaction test passed. Production dashboards, retention, paging, and collector-loss SLOs remain deployment tasks. |
| Supply chain | Base images and build-time Debian packages now use immutable inputs; provenance, image scanning/signing and automated dependency-audit gates remain. | PR image builds are read-only and publish credentials are limited to push/tag jobs ([docker workflow](../../.github/workflows/docker.yml)). `apps/server/Dockerfile` pins multi-architecture base indexes and uses a timestamped Debian snapshot; local AMD64 and ARM64 builds passed, and AMD64 runtime health passed as UID 65532. Hosted workflow execution, image scan/signature/provenance remain unverified. D140 records two high npm advisories with local patches because upstream has no fix; `pnpm audit` must continue to report them rather than suppressing them. Cargo audit evidence is recorded in [DECISIONS.md](DECISIONS.md#d140--keep-local-fixes-and-regression-tests-for-advisories-without-upstream-releases). |
| License and public description | Current license is source-available, not open source. | [README](../../README.md#L102-L106) and [LICENSE](../../LICENSE) use PolyForm Noncommercial terms, which prohibit commercial use. If maintainers intend OSI-style open source, a license decision and rights review are release blockers; do not market the current license as open source. |

## Priority release gaps

1. **Do not claim 10,000 production concurrent-user capacity.** Current successful
   runs cover local WebSocket/public-price load and limited authenticated profile
   load on one host. The report explicitly excludes 10,000 authenticated sockets,
   financial mixed traffic, TLS ingress, multi-replica operation, and N-1/failover
   ([capacity evidence](CAPACITY-LOCAL.md#revised-no-burst-scheduler-runs-with-authenticated-principals),
   [deployment checklist](DEPLOYMENT-READINESS.md#production-decision-checklist)).
2. **Qualify the separate API and worker deployment.** Explicit process roles now
   select API mirrors versus collectors, financial workers and auth retention.
   The worker listener exposes only health/readiness probes. Dependency readiness
   does not prove a remote worker is alive; shared namespace, worker availability,
   queue age, credential scope and N-1 acceptance remain deployment requirements.

3. **Budget database and Redis capacity across replicas.** The default PostgreSQL
   pool is 20 per process ([config](../../apps/server/src/config.rs#L215-L223));
   local mixed-load measurements show this pool can fail while a larger local pool
   passes. Redis admits at most 128 simultaneous commands per process and returns
   `Busy` when saturated ([redis store](../../apps/server/src/redis_store.rs#L45-L58),
   [overload path](../../apps/server/src/redis_store.rs#L137-L149)). Production
   connection budgets, failover, command rates and retry behavior need measured
   multi-replica acceptance.
4. **Prove deployment recovery.** Production ingress, secret rotation, PostgreSQL
   backup/PITR and restore, Redis persistence/failover, migration recovery, rolling
   drain and N-1 tests are still specified as operator work in
   [DEPLOYMENT-READINESS.md](DEPLOYMENT-READINESS.md#production-decision-checklist).
   The development Compose services are intentionally ephemeral and are not a
   production topology.
5. **Resolve licensing before calling the repository open source.** The existing
   noncommercial license is incompatible with that description.
6. **Maintain patched advisory exceptions until upstream fixes exist.** Re-audit
   both local npm patches whenever Expo/Metro dependencies change; do not remove
   the tests or hide the advisories.

## Hardening and cleanup backlog

- Decide whether auth-enabled loopback development without Redis remains supported.
  It falls back to PostgreSQL quotas and has no shared pre-auth peer admission; keep
  it loopback-only and document tunnel risk, or require Redis for any auth-enabled
  listener.
- Consider rejecting absent WebSocket `Origin` only for browser deployments if the
  client contract can distinguish browser-only access without breaking native or
  diagnostic clients.
- Remove or formally deprecate mounted legacy 501 account, relay and monitoring
  stubs only after checking client compatibility; they currently parse no request
  body and do not mutate state.
- Add the security review to a repeatable release gate: current dependency audit,
  pinned build inputs, image scan/signature verification, migration/restore tests,
  provider staging acceptance, and raw multi-generator capacity evidence.
- Run a new repository-wide security scan after the remaining security fixes and
  protocol decisions are reconciled; keep its partial-coverage limitations visible.
