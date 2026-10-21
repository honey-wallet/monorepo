# Local price-stream capacity result — 2026-10-18

**Observed: 10,000 simultaneous WebSockets remained connected for a 60-second soak,
with zero unexpected disconnects and zero HTTP errors. This is not certification
of 10,000 concurrent financial users in production.**

Raw machine-readable output: [price-load-10000-local-2026-10-18.json](results/price-load-10000-local-2026-10-18.json).
Reproducible source: [price_load.rs](../../apps/server/examples/price_load.rs).
Protocol/design: [REDIS-AND-PRICES.md](REDIS-AND-PRICES.md).

| Measurement | Observed |
|---|---:|
| Target / connected at end | 10,000 / 10,000 |
| Ramp | 21.769 seconds |
| Soak | 60 seconds |
| Price frames during soak | 600,000 |
| Unexpected disconnects | 0 |
| HTTP successes / errors | 5,782 / 0 |
| Actual HTTP read throughput during soak | ~96.4 requests/second |
| HTTP p95 / p99 | 2.111 / 30.064 ms |
| Frame-lag p95 / p99 histogram upper bounds, ramp + soak | 250 / 500 ms |
| Largest occupied frame-lag bucket | 500–1,000 ms |
| Combined server + load-generator peak RSS | 1,461,501,952 bytes (~1.36 GiB) |
| Whole process wall / user CPU / system CPU time | 84.33 / 9.90 / 24.93 seconds |

Environment: Apple M4 Max, 16 logical CPUs, 48 GiB memory, macOS 26.2,
Rust release profile (thin LTO, one codegen unit), loopback TCP, disposable Redis
7.4 via Docker compose. File-descriptor soft limit 1,048,575. No TLS/load balancer.
The generator is inside the server process and its own WebSocket read buffers
contribute to RSS; this number is **not server-only memory per connection**.
Redis process/container memory is excluded from that RSS.

The experiment used the actual production router/middleware and Redis admission,
per-IP/global leases, renewals, heartbeat and graceful drain. The one allowed IP
was explicitly configured for 10,000 clients for this controlled local run. The
production default remains 64/IP (IPv6 /64). Synthetic complete snapshots arrived
once/second directly at the in-process hub; provider network and Redis snapshot
mirror were not in the timing path. Actual ingress is verified separately.

HTTP generation is closed-loop, one request at a time targeting a ten-millisecond
interval, so stalls reduce achieved RPS. It does not establish an open-loop SLO at
100 or 2,000 RPS. Latency histogram boundaries are not precise percentile samples.
The load's request mix is public snapshot reads only: no proof verification,
PostgreSQL profile queries, transaction execution, queue work or portfolio fanout.

## What is still required for a production capacity claim

- Independent generators, deployed TLS/proxy, production VM/container limits and
  measured server-only RSS/CPU/FD/egress/Redis/DB metrics.
- The architecture's agreed open-loop mixed workload, active-user ratios, per-user
  subscriptions and auth/quote bursts; realistic NAT distribution.
- Longer soak, reconnect storm, slow readers, malformed clients and edge quotas.
- Multiple replicas with one lost, Redis failover/outage, dependency latency and
  graceful rolling deployment, with enough remaining headroom for the target load.
- Provider agreements/quotas measured across the full egress workload; private
  account stream constraints; explicitly approved financial launch configuration.
- Database restore/PITR and job/provider reconciliation under fault injection.

Configuration defaults are candidate operational limits. This result establishes
one useful local envelope; it does not remove the staging release gates.

## Instrumented repeat: private metrics + 10% OTLP head sampling

After adding per-request/Redis/socket instrumentation, the same local harness ran
with the actual OTLP collector and Jaeger containers on this host.
[Raw result](results/price-load-10000-observed-2026-10-18.json).

| Measurement | Observed |
| --- | ---: |
| Target / connected at end | 10,000 / 10,000 |
| Ramp / soak | 21.787 / 60 seconds |
| Soak frames / unexpected disconnects | 600,000 / 0 |
| HTTP successes / errors | 5,807 / 0 (~96.8 reads/second) |
| HTTP p95 / p99 | 2.459 / 27.950 ms |
| Frame-lag p95 / p99 bucket upper bounds, ramp + soak | 100 / 500 ms |
| Combined process peak RSS | 1,491,779,584 bytes (~1.39 GiB) |
| Whole process wall / user CPU / system CPU | 84.40 / 15.72 / 24.09 seconds |

Trace exporter was enabled with `TRACE_SAMPLE_PER_MILLE=100` (default), logging
set to `RUST_LOG=warn`. Prometheus/collector/Jaeger remained running. Their memory
and CPU are not included in process measurements. The trace queue is bounded and
may drop spans during the simultaneous connection-close burst; the harness does
not certify export completeness. API/collector correlation is a separate smoke
test in [OBSERVABILITY.md](OBSERVABILITY.md). This single repeat is not a controlled
CPU overhead study; machine noise and shared-process generator costs remain.

```sh
cargo build -p honey-server --example price_load --release
TEST_REDIS_URL=redis://127.0.0.1:26379 \
HONEY_OTLP_TRACES_ENDPOINT=http://127.0.0.1:24318/v1/traces \
RUST_LOG=warn LOAD_USERS=10000 LOAD_SECONDS=60 \
/usr/bin/time -l target/release/examples/price_load
```

The same synthetic-ingress, loopback, no-TLS, public-read-only and single-replica
limitations above apply. No financial execution or database workload was added.

## Independent-generator run status

The separate-process generator was run twice against one loopback API replica
with PostgreSQL and Redis, the real Hyperliquid price publisher, and 10,000
configured connections per IP. Both runs connected all 10,000 sockets, had no
unexpected disconnects or HTTP errors, and sustained the scheduled 100 public
snapshot reads per second. Both **failed** the configured 45-frame-per-client
threshold during the 60-second soak: every client received 42 frames during the
soak (slowest total count 43). This is consistent with a roughly 0.7 Hz delivered
snapshot cadence under this setup, below the intended one-Hz publisher cadence.
The output does not yet distinguish upstream request latency from server/runtime
scheduling under load; inspect fetch-duration metrics and repeat with controlled
upstream latency before calling this a 10k price-freshness pass.

| Measurement | Run 1 | Run 2 |
|---|---:|---:|
| WebSockets connected / unexpected closes | 10,000 / 0 | 10,000 / 0 |
| Ramp | 42.600 s | 42.476 s |
| Soak frames / minimum frames per client | 420,000 / 43 | 420,000 / 43 |
| HTTP issued / completed at deadline | 6,001 / 6,000 | 6,000 / 6,000 |
| HTTP errors / in-flight after drain | 0 / 0 | 0 / 0 |
| HTTP p50 / p95 / p99 | 0.374 / 3.818 / 25.496 ms | 0.371 / 3.503 / 25.694 ms |
| Server RSS / average CPU sample | 155 MiB / 69.4% | 142 MiB / 88.7% |

The server resource fields are single `ps` samples collected at run end; `%CPU`
is process-lifetime average, not an interval measurement. Generator resources are
excluded. The raw reports are [run 1](results/price-load-external-10000-local-2026-10-18.json)
and [run 2](results/price-load-external-10000-local-2026-10-18-repeat.json).
The setup is loopback and has no TLS or load balancer. It proves socket admission
and 100-RPS public reads for this one local replica, but the repeated frame-rate
threshold failure blocks a 10k live-price service claim. The original
same-process synthetic-ingress results above remain a separate experiment.

After changing the Redis poll script to return the remaining shared-budget delay
and having the collector schedule directly from that deadline, a third run
connected all 10,000 sockets. Its raw report records 590,000 aggregate frames,
5,989 public reads (99.8 RPS), zero HTTP errors, zero in-flight requests at the
deadline, and p50/p95/p99 of 0.359/5.660/29.036 ms. The end-of-run process sample
was 143,296 KiB RSS and 53.8% process-lifetime average CPU; these are not peaks.
The raw result is
[after-poll-fix](results/price-load-external-10000-local-2026-10-18-after-poll-fix.json).

**The third run does not yet prove the 45-frame-per-client soak gate.** The
generator version that produced it calculated the minimum from each client's
whole-run count (including ramp frames), and sampled the aggregate soak count
after the HTTP deadline and result preparation. The reported minimum of 60
therefore cannot establish the minimum specifically inside the 60-second soak.
The report remains evidence of the stated aggregate workload, but the per-client
freshness gate needed a corrected-generator rerun. The corrected generator
timestamps valid frames against the explicit half-open soak interval
`[httpStart, httpDeadline)` and computes the minimum from those per-client counts.
New output uses `schemaVersion: 2` and the explicit
`minimumFramesPerClientDuringSoak` field; deadline HTTP completion/in-flight
fields are derived from completion timestamps after requests drain. `rampMs`
measures client launch scheduling, while `connectedAfterRamp` is the connection
count sampled when that launch ramp ends.

That corrected-frame run connected all 10,000 sockets, had no closes or HTTP
errors, and passed the 45-frame floor with a measured minimum of 59 valid frames
per client during the soak. However, it **failed the HTTP deadline gate**: it
issued 6,001 requests for a 6,000-request 100-RPS/60-second target, with 6,000
completed by the deadline and one still in flight then (zero remained after
drain). The old acceptance predicate checked only post-drain in-flight work, so
it could report this run as passing. The raw report is
[corrected pass 2](results/price-load-external-10000-local-2026-10-18-corrected-pass2.json).

The harness anchors open-loop request deadlines to the soak start, caps scheduled
issuance at `targetRps * soakSeconds`, rejects any issued-count mismatch, and
requires zero in-flight HTTP work at both the deadline and after drain. It no
longer replays delayed Tokio interval ticks in a burst: if a deadline is missed,
that slot is counted as skipped and the next request waits for the next future
deadline. Reports include maximum scheduler lag and skipped-slot count. A run with
skipped requests therefore fails the exact issued-count gate instead of hiding
generator scheduling stalls behind a catch-up burst.

The historical strict pass immediately below predates this no-burst scheduler and
does not contain scheduler-lag or skipped-slot fields. Its exact request count and
server measurements remain historical observations; it is not evidence for how
the revised generator behaves under scheduling stalls. A new run is required to
establish those measurements with this scheduler.

The strict rerun passed on 2026-10-18. It connected all 10,000 sockets, delivered
60 valid frames to the slowest client during the 60-second soak, and issued and
completed exactly 6,000 HTTP reads at 100 RPS with zero errors and zero in-flight
requests at the deadline or after drain. HTTP latency was p50 0.410 ms, p95
5.921 ms, p99 24.485 ms. The single end-of-run `ps` sample was 143,232 KiB RSS;
`%CPU` was 121.6 process-lifetime average, not peak or interval CPU. The raw
schema-v2 report is [strict pass](results/price-load-external-10000-local-2026-10-18-strict-pass.json).

Reproduction used the corrected release generator against one local API process
with real Hyperliquid polling, disposable PostgreSQL/Redis, loopback WebSocket/HTTP,
no TLS/load balancer, and both global and per-IP connection caps set to 10,000.
The independent generator is a separate process. This passes the stated local
price-stream gate only; it does not establish multi-replica, edge/TLS, authenticated,
portfolio, financial-operation, failure, or production-provider capacity. The
process sample is not a peak-resource measurement.

Even with this local gate passed, production capacity for authenticated or
financial workloads remains unverified.

## Revised no-burst scheduler runs with authenticated principals

The first 2026-10-19 run used one generator for both loads: 10,000 WebSockets,
real Hyperliquid polling, Redis mirroring, 15 distinct SIWE principals and 100
authenticated `/me` reads per second. All sockets stayed open, each client
received at least 59 valid frames during the soak, and 5,995 reads completed with
zero errors or in-flight work. It **failed the exact issue-count gate**: five late
slots were skipped (34.5 ms maximum scheduler lag), rather than emitted in a
catch-up burst. [Raw report](results/price-load-external-10000-authenticated-15-local-2026-10-19.json).

A slower connection ramp with the default 20-connection database pool then
degraded sharply: 2,290 sockets closed, 322 profile reads failed with PostgreSQL
pool-acquisition timeouts, and only 36 frames reached the slowest client. Increasing
the local pool to 80 connections (within the configured limit of 100) removed the
database errors and unexpected socket closes and restored 60 frames per client,
but the one-process generator still skipped five HTTP slots. That result is a
diagnostic failure, not a capacity pass. [Raw report](results/price-load-external-10000-authenticated-15-local-2026-10-19-repeat.json).

Finally, the generators were separated. With the tuned pool, an independent 10k
WebSocket process passed its socket and freshness gates: 10,000 connected, zero
closed, 60 frames per client, zero HTTP errors, and exactly 60 background public
reads at 1 RPS. [WebSocket report](results/price-load-external-10000-websocket-only-local-2026-10-19.json).
During its soak, a separate profile-only process sent 100 authenticated reads/sec
across 15 distinct SIWE principals. It completed 5,988 of 6,000 slots (99.8%),
with zero HTTP errors or deadline backlog; maximum scheduler lag was 67.9 ms and
12 slots were skipped. It therefore **still fails the exact issue-count gate**,
while providing evidence of successful 10k socket plus near-100-RPS authenticated
profile service. [Profile report](results/price-load-external-auth-profile-15-100rps-local-2026-10-19.json).

Across runs, reads were evenly distributed (399–400 per principal), identities
were distinct, and every profile response matched expected user ID, wallet ID and
address. The exact 100-RPS acceptance remains open; skipped slots are visible and
never hidden by catch-up traffic. These tests used loopback without TLS or a load
balancer, and process resource measurements are single end-of-run samples. They do
not prove 10,000 authenticated sockets, multi-replica failover or production
capacity.

## Authenticated one-principal profile for mixed socket/API load

### Coordinated split generators

The external generator supports a common run ID and future UTC epoch so WebSocket
and profile-only processes can run on separate hosts without relying on launch
timing. Authenticated runs require `LOAD_RUN_ID` and `LOAD_START_AT_UNIX_MS`; the
start must be at least one second in the future after sign-in and socket setup.
Each process prints `capacity_ready` after its socket launch ramp and revalidates
the UTC start at that readiness point, then converts it to a monotonic deadline.
If sign-in or the ramp consumes the rendezvous window, that process exits before
the soak instead of silently shortening it. Without a requested UTC epoch, the
soak begins immediately after the local ramp. Use a clock-synchronized,
dedicated API host and generators; archive each JSON report and run the reducer:

```sh
python3 apps/server/examples/aggregate_price_load_reports.py \
  --run-id "$LOAD_RUN_ID" --seconds 60 --http-rps 100 --http-shards 5 \
  --websocket-target 10000 --min-frames 45 ws.json profile-0.json profile-1.json profile-2.json profile-3.json profile-4.json
```

Launch a WebSocket-only process with `LOAD_HTTP_ENABLED=false`, the common run ID
and epoch, and `LOAD_USERS=10000`. Launch five profile-only processes with
`LOAD_USERS=0`, authenticated profile mode, `LOAD_HTTP_SHARD_COUNT=5`, and shard
indexes 0–4. The aggregate 100 RPS is evenly divided into 20 RPS shards whose
first slots are phased by 0/10/20/30/40 ms. This stays at the configured
1,200-requests/minute per-IP profile quota; four 25-RPS shards exceed it. Assign
each profile process a distinct loopback identity (`LOAD_TEST_CLIENT_IP=127.0.0.2`
through `127.0.0.6`) and principal offsets 0, 3, 6, 9 and 12, with three principals
per process. The server must bind only to `127.0.0.1` and set
`TRUST_PROXY_HEADERS=true` and `TRUSTED_PROXY_CIDRS=127.0.0.1/32` so only the local
test proxy's socket peer may set the synthetic client identities. The generator refuses non-loopback test IPs and non-loopback
URLs with this option. Do not use this simulation on a reachable deployment or as
evidence for the deployed edge's forwarded-header policy. The reducer rejects
mismatched run IDs/epochs, incomplete or duplicate shards, start skew greater than
one aggregate slot, HTTP skips/errors/backlog, socket freshness or connection
failures, and a WebSocket report whose recorded soak duration differs from the
requested duration. A passing reducer is still a local workload acceptance result; it does
not certify TLS, production limits, database failover, or financial execution
capacity.

### Coordinated 100-RPS acceptance (2026-10-19)

The current-source external generator and reducer passed one local coordinated
run (run ID `2f1d0620-c253-426e-a091-7b410b861dee`): 10,000 price WebSockets,
zero closes, at least 60 frames per socket during the 60-second soak, and exactly
6,000 authenticated `/me` reads completed by deadline at 100 aggregate RPS. The
profile work used 15 distinct SIWE principals across five loopback XFF identities;
each shard completed 1,200 reads with zero errors, skips or deadline backlog. The
API ran in development mode with an 80-connection PostgreSQL pool, disposable
local PostgreSQL/Redis, loopback transport and no TLS. API resource sampling was
not enabled for this run. Raw shard reports and reducer output are
[archived here](results/price-load-coordinated-10000-debug-2026-10-19-aggregate.json).

An optimized release-mode repeat used a 120-second socket ramp, a unique Redis
namespace and the same five-shard authenticated profile workload (run ID
`98409035-be6d-4771-b627-2725a3214b19`). All 6,000 authenticated reads passed,
but the socket gate failed: only 9,981 of 10,000 connections were established by
the ramp sample. The generator classified the 19 failed handshakes as HTTP 5xx;
it saw no 4xx, I/O or timeout failures. The single end-of-run `ps` sample was
11.5% process-lifetime CPU and 141,328 KiB RSS; it is not a peak or interval
measurement. The reducer output and raw reports are
[archived here](results/price-load-coordinated-10000-release-failed-2026-10-19-aggregate.json).
At that point this was the latest optimized result and the combined local gate
failed. The corrected release-mode rerun documented below later passed the same
local predicate; both outcomes remain archived. The bounded failure-category
report rules out client-side I/O and handshake timeouts for this failed attempt,
but the server's 5xx path was not isolated to a root cause. Neither release run
represents 10,000 authenticated sockets, portfolio/operation/provider traffic,
TLS, or multi-replica production capacity.

The external generator also supports exercising the real authenticated profile
read while 10,000 price WebSockets are open. Set `LOAD_AUTHENTICATED_PROFILE=true`;
the HTTP target must be exactly the local `http://127.0.0.1:<port>/api/v1/me` or
`http://localhost:<port>/api/v1/me` route. The generator uses the repository's
public SIWE test key (integer 1) to request and verify a normal short-lived session,
checks the returned profile wallet, disables redirects, and never emits the token.
Use only the disposable local database and API configured for this test; this
public test key must never hold funds.

Run against a disposable local API. Start isolated services:

```sh
HONEY_POSTGRES_PORT=25450 HONEY_REDIS_PORT=26399 \
docker compose -p honey-auth-capacity -f compose.backend.yaml up -d --wait
```

Apply migrations to that disposable database:

```sh
DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:25450/honey?sslmode=disable' \
REDIS_URL=redis://127.0.0.1:26399 REQUIRE_INFRASTRUCTURE=true \
AUTH_ORIGIN=http://localhost:5173 AUTH_CHAIN_ID=1 \
cargo run -p honey-server -- migrate
```

In one terminal, start the local API:

```sh
DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:25450/honey?sslmode=disable' \
REDIS_URL=redis://127.0.0.1:26399 REQUIRE_INFRASTRUCTURE=true \
AUTH_ORIGIN=http://localhost:5173 AUTH_CHAIN_ID=1 PRICES_ENABLED=true \
PRICE_MAX_CONNECTIONS=10000 PRICE_MAX_CONNECTIONS_PER_IP=10000 \
HOST=127.0.0.1 PORT=18080 LOG_FORMAT=json RUST_LOG=warn \
cargo run -p honey-server
```

In another terminal, build the independent generator once, then run the soak. It
obtains the short-lived test-wallet session itself through SIWE:

```sh
cargo build --release -p honey-server --example price_load_client
LOAD_WS_URL=ws://127.0.0.1:18080/api/v1/stream/prices \
LOAD_HTTP_URL=http://127.0.0.1:18080/api/v1/me \
LOAD_AUTHENTICATED_PROFILE=true \
LOAD_AUTHENTICATED_PRINCIPALS=15 \
LOAD_USERS=10000 LOAD_SECONDS=60 LOAD_HTTP_RPS=100 \
LOAD_MIN_FRAMES_PER_CLIENT=0 \
target/release/examples/price_load_client
```

`LOAD_AUTHENTICATED_PRINCIPALS` defaults to 1 and accepts 1–15. The generator signs
in through the real local SIWE routes using deterministic private keys 1 through N,
keeps each short-lived token in memory, asserts that sign-ins return distinct `userId`
and wallet `id` values, checks each `/me` response against the matching user ID, wallet
ID, and address, and distributes requests round-robin. The result records the principal count
and per-principal request counts, never tokens or addresses. Fifteen is the bounded
maximum because each login uses a challenge and verify request against the configured
30-attempt/minute per-IP proof quota; larger identity populations need controlled,
quota-aware seeding in a separate setup phase. Authenticated soaks are limited to less
than 14 minutes to avoid silently measuring expired access tokens. These public test
keys must never hold funds. This exercises distinct principals during steady-state
profile traffic, not a 10,000-user concurrent login burst.

For a profile-only auth smoke test without a configured price publisher, omit
`LOAD_WS_URL` and set `LOAD_USERS=0`:

```sh
LOAD_HTTP_URL=http://127.0.0.1:18080/api/v1/me \
LOAD_AUTHENTICATED_PROFILE=true LOAD_AUTHENTICATED_PRINCIPALS=4 \
LOAD_USERS=0 LOAD_SECONDS=10 LOAD_HTTP_RPS=2 \
cargo run -p honey-server --example price_load_client
```

This produces `profileOnly: true` with zero target WebSockets and retains the same
exact-schedule, wallet-binding, error and deadline checks for `/me` traffic. A local
smoke run on 2026-10-18 used four distinct SIWE identities for 10 seconds at 2 RPS:
20 requests completed by the deadline, five per principal, with zero errors or
in-flight work. This validates the multi-principal generator/server/database path;
it is not a capacity result. That captured run predates the runtime assertion for
unique user and wallet IDs, so those identity-cardinality checks have unit-test
evidence only and still need a fresh local smoke.

Stop the API, then remove only the disposable test project:

```sh
HONEY_POSTGRES_PORT=25450 HONEY_REDIS_PORT=26399 \
docker compose -p honey-auth-capacity -f compose.backend.yaml down
```

The 2026-10-18 local run passed this mixed profile (run ID
`3d2e7f54-c450-4373-9d1d-1ff4457e1d22`): 10,000 sockets connected after a 42.7s
ramp, stayed open for the 60s soak, and received at least 60 frames each; 6,000
authenticated `/me` reads completed at 100 RPS with zero HTTP errors. HTTP latency
was p50 1.76ms, p95 10.69ms, p99 45.79ms (max 132.67ms). The API readiness check
reported PostgreSQL and Redis up. TLS was disabled and no API process resource
sample was captured.

### Coordinated release-mode rerun with exact HTTP status metrics (2026-10-19)

A second, independently generated, release-mode run passed the same local acceptance
predicate (run ID `c56ad8f7-4375-486b-9b1d-9b1d46b2d4a5`). It connected 10,000
price sockets, had no unexpected closes or connection failures, delivered at least
60 valid frames per socket during the 60-second soak, and completed exactly 6,000
authenticated `/me` reads by deadline across 15 SIWE principals and five phased
profile shards. The reducer reports `passed: true`, 10,000 WebSockets, and all
6,000 reads completed by deadline. The raw generator reports, per shard, 1,200
issued/completed reads, 400 per principal, zero HTTP errors, skipped slots, or
deadline backlog. Exact 500/502/503/504/other status counters were zero for the
WebSocket generator. The same-process private metrics scrape showed 20,000
successful price-stream upgrades and 12,000 successful `/me` reads across the two
corrected runs on that server process, with no route 4xx/5xx observations. These
metric totals are cumulative across both runs, not deltas for this run.

The API was a single local release binary with a disposable PostgreSQL and Redis,
loopback HTTP/WebSocket, real Hyperliquid price ingestion, trust-proxy enabled only
for the loopback peer, and an 80-connection PostgreSQL pool. The socket generator
used the loopback-only XFF simulation (`127.0.0.2`) because trusted proxy headers
were enabled; this is not evidence for any deployed proxy policy. There was no TLS,
load balancer, replica failover, provider execution, or server-only CPU/RSS/FD/egress
sample. Raw per-process reports, reducer output, and the cumulative metrics scrape
are [archived here](results/price-load-coordinated-10000-release-pass-2026-10-19-aggregate.json)
([WebSocket report](results/price-load-coordinated-10000-release-pass-2026-10-19-ws.json),
[profile shard 0](results/price-load-coordinated-10000-release-pass-2026-10-19-profile-0.json),
[shard 1](results/price-load-coordinated-10000-release-pass-2026-10-19-profile-1.json),
[shard 2](results/price-load-coordinated-10000-release-pass-2026-10-19-profile-2.json),
[shard 3](results/price-load-coordinated-10000-release-pass-2026-10-19-profile-3.json),
[shard 4](results/price-load-coordinated-10000-release-pass-2026-10-19-profile-4.json),
[metrics scrape](results/price-load-coordinated-10000-release-pass-2026-10-19-metrics.jsonl)).
This strengthens the local mixed-workload evidence and shows the prior handshake
5xxs did not recur on this corrected run; it does not certify authenticated sockets,
production or HA capacity, nor financial-operation capacity.

This historical run used one short-lived session and wallet, so it does not measure
identity cardinality, per-user quota distribution, login proof bursts, or distinct-user
database locality. The later coordinated debug and release runs above used 15 distinct
principals alongside 10,000 public price sockets. The first release attempt remains
a documented failure by 19 connections; the corrected rerun above passed the local
gate. Even this mixed mode tests 10,000 public price sockets plus 100 authenticated
profile reads/second, not 10,000 authenticated sockets or provider execution, and
cannot support a claim of handling 10,000 distinct authenticated users.

## Two-replica local N-1 diagnostic

`apps/server/examples/run_price_n1.py` starts two local `honey-server` processes
on distinct loopback ports against the same disposable PostgreSQL and Redis
namespace. The independent `price_load_client` process distributes half the
socket load to each replica. At the configured offset, the runner either
SIGKILLs replica 1 (default, crash behavior) or sends SIGTERM (graceful drain),
then probes fresh admission on replica 2 immediately and after the Redis
60-second socket-lease TTL. The immediate probe is bounded by `--probe-clients`
(default 100, max 1,000, capped at half the total client target), so it starts
within a few seconds even in 10k mode; the post-TTL probe targets the full
failed shard. Both target counts and actual admitted counts are in the summary.
The client now reports per-client frame-gap
percentiles, including the interval from its last valid frame to socket close.
The summary records each shard's connection/close/frame results, probe admission
classification, and global Redis lease counts when `redis-cli` is available.

This runner intentionally does **not** auto-reconnect existing clients or claim
an N-1 pass. Fresh probes test whether the surviving replica can admit the
disconnected shard; compare the immediate and post-TTL outcomes. A graceful
SIGTERM should release socket leases, while SIGKILL leaves crash leases until
expiry. The tested client sockets are public and unauthenticated. The test uses
real Hyperliquid read-only price ingestion, loopback `ws://`, no proxy/TLS, and
one host; upstream availability affects readiness. It does not simulate
production routing, replica placement/failure domains, or authenticated
financial traffic. Never point this at a shared or production database/Redis.

Build both release binaries and start disposable local dependencies as described
above, then apply the schema once. Run a modest diagnostic (100 sockets total):

```sh
cargo build --locked --release -p honey-server --bin honey-server --example price_load_client
DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:25450/honey?sslmode=disable' \
REDIS_URL=redis://127.0.0.1:26399 REDIS_NAMESPACE=honey-n1-local \
REQUIRE_INFRASTRUCTURE=true PRICES_ENABLED=true RUST_LOG=warn \
python3 apps/server/examples/run_price_n1.py \
  --clients 100 --seconds 90 --fail-after 10 --ramp-ms 10000 \
  --probe-clients 100 \
  --output-dir /tmp/honey-price-n1-small
```

For the explicit 10,000-socket local experiment, opt in and allow enough ramp
and soak time for lease expiry and the two survivor probes:

```sh
DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:25450/honey?sslmode=disable' \
REDIS_URL=redis://127.0.0.1:26399 REDIS_NAMESPACE=honey-n1-10k-local \
REQUIRE_INFRASTRUCTURE=true PRICES_ENABLED=true RUST_LOG=warn \
python3 apps/server/examples/run_price_n1.py \
  --clients 10000 --allow-10000 --seconds 150 --fail-after 10 \
  --ramp-ms 120000 --probe-clients 100 \
  --output-dir /tmp/honey-price-n1-10000
```

The process exits zero when the experiment orchestration completes; it does not
mean the failed-replica shard or either admission probe passed. Inspect
`n1-summary.json`, the raw per-replica client JSON and server logs. This runner
does not itself launch Docker, migrate PostgreSQL, or assert that Redis uses
production persistence/HA settings. Its outcomes are local diagnostic evidence,
not a release gate or production-capacity result.


### Handshake failure attribution

The corrected release run's generator records exact HTTP handshake status classes,
all zero, and the private metrics scrape showed no route-level 4xx/5xx samples.
Those observations establish that the prior 19 failures did not recur in this run;
the archive does not preserve per-run counter deltas for the fixed-reason
`honey_price_socket_handshake_rejections_total` or
`honey_http_admission_rejections_total` metrics, so it cannot attribute the earlier
failure to a specific server path. A future investigation of that historical failure
must capture before/after same-instance rejection-counter deltas. Such counters do
not establish OS descriptor limits, Redis health, or TLS-edge capacity. The
coordinated report reducer requires schema v4 and validates bounded failure counters
before allowing a pass.

### Provider quote admission

Authenticated Uniswap, Relay and Morpho quote requests use provider-scoped
Redis fixed-window admission with one global and one wallet bucket evaluated
atomically. Identity proof/session quotas and durable mutation limits continue to use
PostgreSQL. Limits are policy values, not measured provider capacity; provider
concurrency/cooldown budgets remain independent. The quote path fails closed when
Redis is configured but unavailable. Validate cross-replica counters and the denial
boundary against disposable real Redis before deployment.
