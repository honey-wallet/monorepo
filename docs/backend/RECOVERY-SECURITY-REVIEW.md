# Backend recovery security review — 2026-10-19

**Status: scoped backend source review complete; production gates remain open.**

This is a scoped current-tree source review of backend production Rust, Redis Lua,
and database migrations, with local restore checks. It is separate from the older
357-item repository diff scan, whose snapshot predates these changes. Completion
of this pass does not complete that broader client/contract/dependency review or
approve production deployment.

## Method and trust boundaries

Three independent reviewers read assigned source areas; the parent inspected
reported defects and integrated fixes and test evidence. The source hash inventory
in `results/recovery-security-source-2026-10-19.json` records the exact current files
covered. Standalone test modules are supporting evidence, not claimed exhaustive
security coverage. Runtime dependencies, deployed contracts and live provider truth
are not covered by source inspection.

The review considered untrusted HTTP/WS inputs, ownership and authentication,
resource bounds, Redis coordination and cache fencing, PostgreSQL transaction/lease
boundaries, immutable user intent, encrypted signing material, external RPC/provider
claims, canonical receipts/finality, telemetry disclosure and restored historical
state. Operators, database/Redis access, configured contract registries and encryption
keys are trusted administrative boundaries. A backup is not assumed current.

## Findings and disposition

| Finding | Impact | Disposition |
| --- | --- | --- |
| Lower Redis price sequence suppresses WS aging | After restore, an existing frame could remain `stale=false` until the collector catches up; HTTP age calculation was unaffected. | Fixed in `markets.rs`: preserve the newest accepted prices but update stale serialization and metrics. Deterministic rollback/recovery regression passes. |
| Restored auth can revive revoked credentials or consumed proofs | PostgreSQL snapshot rollback removes later session/refresh/proof invalidations. | Offline transactional reset SQL, real-identity regression, and mandatory fencing before ingress. This is an operator recovery requirement, not an automatic startup action. |
| Restored financial journal omits post-backup activity | Dispatch/nonce/idempotency guards are database-local; old backups cannot prove no external send occurred. | Explicit quarantine and external reconciliation gate; no automatic replay/row deletion. Real dump/restore test preserves an unknown journal and demonstrates a deliberately missing post-backup marker. |

No confirmed cross-wallet authorization bypass, encryption substitution bypass,
arbitrary-origin provider SSRF, or credential/raw-payload telemetry exposure was
identified in this pass. That is a review result, not proof of absence.

## Assumptions and residual limits

- Redis reset loses socket reservations, read-once pairing state and quota counters.
  Fence old replicas, disconnect sockets and rebuild coordination together. Preserve
  or deliberately reconstruct provider policy fingerprints and cooldown holds.
- Price/catalog freshness assumes sufficiently trustworthy wall clocks. Corrupted
  administrative Redis data is not an authenticated external feed. Tightening all
  cache payload limits before Redis allocation is potential future hardening.
- RPC data is trusted within configured provider policy; this is not a light client.
  Contract governance/state may change after simulation. Local execution activation
  remains limited to explicitly configured fork environments.
- Source pins, fee consent and ABI constraints do not establish deployed provider
  eligibility, production builder-code/fee agreements or external API compatibility.
- Production restore storage, PITR/WAL continuity, credentials, DNS/TLS, multi-replica
  fencing, failover and RTO/RPO must be exercised in the chosen environment.
- This pass excludes complete mobile/web/extension/keyring/contract and dependency
  source review. The older repository-wide security scan remains partial and must
  not be relabeled complete using this backend-only evidence.

## Validation

See `results/recovery-restore-local-2026-10-19.json` and the runnable commands in
[RECOVERY-RESTORE.md](RECOVERY-RESTORE.md). All database activity uses synthetic
fixtures in randomly named databases on an owned disposable service. No production
restore, public traffic reopening or funds movement was performed.

The typed settlement regression uses production intent serialization and real verifier
execution against deterministic RPC receipts, with relational signing rows seeded by
the fixture. The separate HTTP test exercises actual service creation/replay. Together
they cover the schema disconnect; they are not a real network bridge transaction.

Final validation: `pnpm lint`, `pnpm typecheck` and `pnpm test` pass on the
completed fixes (7 test tasks, with cached unchanged frontend results). Thirteen
PostgreSQL-backed auth/submission checks passed separately against the disposable services. Both owned containers were
removed. Hosted CI execution and production acceptance were not performed.

Across was removed on 2026-10-21 (bridging is NEAR Intents); its findings and
checks from this review no longer apply.
