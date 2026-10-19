# Backend deployment readiness and operator gates

Status: repository deployment guidance only. No cloud account, production
environment, DNS, TLS edge, database, Redis deployment, secrets, or live provider
configuration was supplied or changed. This document records what the current
artifacts support and what must be decided and proven before a production rollout.

## What exists today

`compose.yaml` builds and runs one `honey-server` container on a developer host.
It publishes the API on loopback, optionally reads the ignored local
`apps/server/.env`, uses a read-only root filesystem, and restarts the container.
Its new 25-second `stop_grace_period` exceeds the default 15-second HTTP drain,
two-second pool-close bound and four-second trace-export wait in
`apps/server/src/main.rs` and `telemetry.rs`. If an operator raises
`SHUTDOWN_TIMEOUT_SECS`, the container stop grace must also be raised to exceed
that setting plus cleanup time.

`compose.backend.yaml` is only a disposable local fixture: PostgreSQL has
ephemeral `tmpfs` storage, Redis has persistence disabled and fixed local-only
credentials, and both ports bind to loopback. It is not a service topology to
copy into production. `compose.observability.yaml` is similarly a loopback-only
local collector, Jaeger and short-retention Prometheus fixture.

The image build pins its multi-architecture Rust, `xx` and distroless base-image
manifest digests. Compiler packages come from the `DEBIAN_SNAPSHOT` timestamped
Debian archive (default pinned in the Dockerfile), avoiding moving `apt` indexes.
To update inputs, select a current archive timestamp, inspect and record each
multi-architecture digest, build both target architectures, scan the resulting
image, and review the resulting binary/runtime compatibility before changing the
pins. The image is a nonroot distroless runtime with a read-only-compatible binary,
`SIGTERM`, a `/health` Docker healthcheck and a documented multi-architecture
build. These properties do not configure an orchestrator, immutable release
promotion, signed images, deployment probes, external secret delivery or rollback.

`SERVER_ROLE=combined` (the default) starts the API and configured background
work together. `SERVER_ROLE=api` serves product routes and runs Redis-to-local
price/Earn mirrors, dependency probes and queue metrics, but does not collect
prices/Earn data, execute financial jobs, reconcile bridges or prune expired auth.
`SERVER_ROLE=worker` runs those collectors and workers plus auth retention, and
exposes only `/health` and `/ready` on the normal listener. Split roles require
Redis. Explicit migration, retention and dead-letter inspection commands remain
one-shot operator commands.

Deploy API and worker processes with the same environment namespace, database,
Redis and compatible provider configuration. All selected background tasks remain
supervised; unexpected exit drains the process. `/ready` proves local dependency
and schema health, not that a separate worker deployment is alive or keeping up.
Scrape both roles and monitor worker availability, queue age and market freshness.
API processes still construct configured adapters needed for quoting, preparation,
signing and submission; this split is not separate credential isolation. A
stream-only role and production multi-replica/N-1 acceptance remain unimplemented.

## Production decisions and evidence still required

| Area | Current contract | Required operator decision or proof |
| --- | --- | --- |
| Process topology | Combined, API and worker roles are explicit; default Compose remains one combined replica. | Deploy and monitor both roles when splitting. Budget their pools together, verify shared namespace/configuration, and test each task under N and N-1 replicas. Separate stream-only capacity is not implemented. |
| Public ingress | Container port is loopback-published in Compose; no production ingress exists. | Select the host/orchestrator, TLS termination, private network path, WebSocket idle/upgrade behavior, request/connection limits, and health/readiness probes. Keep `/health` for liveness and use `/ready` for traffic admission. |
| Proxy identity | Forwarded client IP is trusted only when `TRUST_PROXY_HEADERS=true` and the TCP peer matches `TRUSTED_PROXY_CIDRS`. | Supply the actual proxy source CIDRs; strip attacker-supplied forwarding headers and append the client address at the trusted edge. Do not copy example CIDRs. Prevent direct backend access where feasible. |
| PostgreSQL | Pool maximum is per process (default 20); authenticated readiness requires the code's latest migration. No production database or backup policy is present. | Choose managed/self-hosted service, TLS verification, private access, total connection budget across max replicas plus migration/operations reserve, HA, backup/PITR retention, restore objective and tested restore. |
| Schema rollout | API startup does not migrate. `honey-server migrate` is an explicit one-shot command. | Run one migration job using an approved migration identity before routing code that requires the new schema. Review nontransactional/concurrent indexes, migration lock/timeout, backup and rollback/forward-repair procedure for every release. Verify `/ready` after migration. |
| Redis | Shared coordination and quotas assume all replicas of one environment share the same namespace. Pairing and socket lease data require `noeviction`; local Redis has no persistence. | Select TLS, private networking, ACLs, memory ceiling, `noeviction`, persistence/failover and recovery semantics. Decide which state may be lost (including active pairing) and test outage/failover with real deployment settings. Isolate environment namespaces. |
| Secrets | `.env.example` documents names and local settings; the repo has no production secret mount or rotation system. | Choose a secret manager, workload identity, access policy and rotation/reload process. Do not place DSNs, Redis credentials, RPC/API keys or execution configuration in image layers, source control, logs or public Compose files. |
| Auth and provider switches | Auth and provider adapters enable only when their required configuration is present; local-fork execution modes reject public listeners. | Set the real origins/chain and exact CORS allowlist. For every provider, prove credentials, eligibility, fee policy, chain/contract pins, signer compatibility and production-safe mode independently. Local-fork evidence does not authorize production money movement. |
| Periodic maintenance | Expired auth state is pruned every minute inside supervised combined/worker processes when auth and the required schema are enabled; a PostgreSQL advisory lock coordinates replicas. Each bounded pass has a 10-second deadline and removes up to 50,000 expired quota rows, 5,000 expired challenge rows per table, and 20,000 session/token/family rows per table. `honey-server prune-auth` remains available as a one-shot command. | Monitor classified cleanup-failure logs and retention backlog; verify the advisory-lock/batch behavior against isolated PostgreSQL. The cadence and batch sizes are configured policy, not a proven retention SLO. |
| Observability | Private metrics listener and optional OTLP endpoint are configurable; local compose examples are loopback-only. | Provision private scraping/export, dashboard and paging ownership, retention, SLOs, cardinality limits and trace-loss alerts. Never publish the metrics listener through public ingress. |
| Capacity and resilience | Local results are single-replica synthetic/socket tests, not production mixed-load acceptance. | Run the documented authenticated mixed workload from independent generators over the real TLS edge, include provider simulators/approved staging limits, N-1, rolling drain, DB/Redis failover, reconnect storms and restore. Record image digest, hardware, limits, raw result and pass criteria. |

## Safe initial rollout sequence (once an environment is chosen)

1. Pin a reviewed image by immutable digest and record source revision, build
   provenance, dependency/security scan results and runtime architecture. Keep
   the source Dockerfile's base-image digests and Debian package snapshot pinned;
   an immutable output image alone does not make its build inputs reproducible.
2. Provision PostgreSQL and Redis privately with the selected TLS, ACL, backup,
   memory and failover policy. Confirm database connection and Redis memory
   budgets against the maximum simultaneously running processes.
3. Mount the production configuration through the approved secret mechanism.
   Set `REQUIRE_INFRASTRUCTURE=true`; verify the auth origin, CORS origins,
   chain, trusted proxy list and all optional feature switches are intentional.
4. Run exactly one reviewed `honey-server migrate` job. Confirm migration
   history and required schema. Do not rely on API startup to repair the schema.
5. Start the chosen server topology with external liveness `/health`, readiness
   `/ready`, SIGTERM delivery and a stop grace longer than configured drain,
   pool close and telemetry flush. Verify readiness fails closed during a
   dependency outage and returns after recovery.
6. Run read-only smoke tests, auth lifecycle tests and the deployment's staged
   capacity/failure plan before enabling any provider execution config. Monitor
   one controlled rollout and exercise rollback or forward repair.
7. Schedule `honey-server prune-auth`, validate its identity and backlog alert,
   and test a backup restore before admitting real users or funds.

The sequence is a checklist, not a production deployment recipe: exact resource
sizes, replica counts, regions, network policy, retention and provider settings
remain intentionally unspecified until the target runtime and workload are
selected. See [CAPACITY-LOCAL.md](CAPACITY-LOCAL.md) for the boundary of current
load evidence and [IMPLEMENTATION.md](IMPLEMENTATION.md) for implemented versus
unfinished backend behavior.

## Recovery acceptance

[Recovery/restore procedure](RECOVERY-RESTORE.md) specifies offline auth invalidation,
old-process fencing, Redis policy reconstruction, historical-key retention and
financial reconciliation. The local logical dump/restore and auth-reset tests pass;
production PITR, failover, external transaction reconciliation and measured RTO/RPO
remain deployment gates. A successful readiness probe does not discharge them.
