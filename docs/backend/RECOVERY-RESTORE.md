# Deployment recovery and restore

This runbook concerns server state. It does not restore wallet signing keys. Local
logical-restore evidence is separate from production PITR, failover and RTO/RPO
acceptance. Never use `/ready` as permission to reopen a restored deployment.

## Recovery invariants

1. Exactly one deployment generation may write. Fence old API and worker processes
   at the infrastructure/network/credential boundary before restoring or resetting
   coordination. SIGTERM alone is not proof that every old process stopped.
2. Restored database state is historical evidence, not authoritative knowledge of
   external transactions after the backup point. Never automatically replay or
   delete unknown operations, dispatch attempts, nonce reservations or wallet guards.
3. A restored credential may have been revoked after backup. Invalidate every
   restored auth session/refresh family and consume outstanding proofs offline.
4. Retain every historical submission-encryption key ID required by the backup.
   The active write key alone is insufficient. Missing/wrong keys fail closed;
   never replace encrypted envelopes with newly signed transactions to bypass this.
5. Redis contains coordination and policy, not only cache. Start an isolated new
   namespace after fencing old processes; deliberately reconcile provider budgets,
   policy fingerprints and cooldown holds before resuming collectors or execution.

## Ordered operator procedure

| Step | Action and evidence required |
| --- | --- |
| Contain | Close ingress, pause signing/submission workflows, drain sockets, stop/fence all old API and worker replicas. Preserve logs, deployment digest, incident time and external transaction evidence. Confirm old replicas cannot reconnect to either store. |
| Select recovery point | Record backup/WAL provenance, checksum, encryption-key retention, source PostgreSQL version and schema, last durable timestamp, and the expected loss window. Keep the original database/backup immutable for investigation. |
| Restore isolated | Restore into a new private database with no application writers. Use the deployment's approved PostgreSQL tooling and secret injection. Validate backup authentication/decryption and restore errors. Do not overwrite the incident database. |
| Verify schema | Compare `_sqlx_migrations` versions/checksums with the selected binary. If forward migration is needed, use the explicit migration job. Inspect `pg_index.indisvalid`/`indisready`, especially concurrent-index migrations; record constraints and row counts. A failed/nontransactional migration needs repair, not a readiness bypass. |
| Invalidate auth | With every app process stopped, execute `scripts/backend/recovery-invalidate-auth.sql` using `psql -X -v ON_ERROR_STOP=1 -f …`. The transaction revokes sessions and refresh families, consumes both challenge tables, and retains ownership/audit/replay rows. Verify no unrevoked/unconsumed rows remain before reopening. Users must sign in with a fresh proof. |
| Rebuild Redis | Use a new `REDIS_NAMESPACE` consistently across all new replicas. Do not restore pairing messages/read-once tombstones, worker leases or socket reservations into live coordination. Reconcile RPC policy and provider cooldown holds from approved policy/incident evidence; when uncertain keep upstream calls disabled. Re-pair devices and reconnect sockets after reopening. |
| Reconcile financial state | Using read-only canonical RPC/provider evidence, compare every nonterminal operation, signed hash, receipt/finality, nonce and bridge deposit/fill against the restored journal. Include activity in the backup-loss window and external logs/client-held hashes. Record unresolved or missing operations and retain execution quarantine until resolved. A nonce/hash protects identical EVM transactions against double execution, but does not recover missing operation/idempotency history or guarantee only one broadcast. |
| Validate isolated API | Use `SERVER_ROLE=api`, with all Aave/Morpho/Uniswap execution configuration files unset and public ingress still closed. Ensure old auth is rejected, new proof works, users only see their own operations, encrypted journals decrypt with retained keys and unknown outcomes remain unknown. This mode is an operational quarantine, not a new automatic recovery authorization mechanism. |
| Validate collectors/workers | After policy and financial reconciliation approval, start selected compatible workers in isolation. Check queue age, fenced leases, market/catalog freshness and stale behavior, canonical receipt processing, and no unintended broadcasts. Readiness only tests dependencies/schema; API readiness does not prove workers are alive. |
| Reopen gradually | Reconnect clients with fresh auth/pairing, canary traffic, observe errors/latency/queue age/unknown operations and provider budgets, then expand. Record actual recovery duration and observed data loss against preselected RTO/RPO. Roll back traffic on failed criteria without reconnecting old writers. |

Do not clear financial rows or fabricate terminal status to unblock recovery.

Historical signed-envelope verification permits inspection of expired accepted
operations; it does not authorize sending an expired plan. Financial reconciliation
may need a reviewed operator repair for activity absent from backup; this repository
does not provide a general automated ledger-reconstruction tool.

## Repeatable local checks

Use only an explicitly disposable PostgreSQL service. Each test creates randomly
named databases; the database named in `TEST_DATABASE_URL` is not migrated or
restored over. Failed tests may leave their random databases behind; dispose of the
owned fixture service afterward. PostgreSQL client tools must be on PATH.

```sh
cargo test -p honey-server --test submissions logical_backup_restores -- --ignored
cargo test -p honey-server --test recovery_auth -- --ignored
cargo test -p honey-server --lib markets::tests::restored_lower_sequence
```

The logical-backup test runs `pg_dump` and `pg_restore` into a distinct empty
repository fixture database. It preserves an unknown dispatch, exact signed hashes,
AEAD decryptability, owner scope, wallet guard, idempotent resubmission and dispatch
uniqueness. Wrong/missing keys fail. A post-backup marker is deliberately absent
from restored state, proving that this drill does not hide the loss window. The dump
uses a private temporary file removed on completion; no RPC or broadcast is used.

The auth test executes the actual offline SQL, rejects restored browser/native
access and spent/current refresh credentials and outstanding login proof, checks
wallet-link proof consumption and retained ownership/replay records, reruns the
script idempotently, then confirms a fresh login can succeed.

The market regression feeds an older same-epoch Redis snapshot to a replica with a
newer accepted sequence. It retains newer prices while updating serialized WS
staleness, then accepts a newer sequence normally. This is deterministic source
logic evidence, not a managed Redis failover exercise.

## Remaining deployment evidence

Production backup encryption/access/retention, WAL/PITR continuity, restoration from
actual storage, HA failover, multi-replica fencing, Redis restart/policy restoration,
DNS/TLS/secret-manager recovery, external transaction reconciliation, paging and
measured RTO/RPO require the chosen deployment environment. These are open gates;
local fixture timings are not a production recovery objective or security clearance.
