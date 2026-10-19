# RPC account admission and Aave implementation identity

Implemented 2026-10-18. This closes two code gaps in local Aave execution and provides
primitives needed for production: coordinated RPC admission and explicit implementation
pins. **Production execution remains disabled.** An observed address/hash on a fork is
not an approved deployment registry, provider contract, or proof of safe governance.

## Evidence behind the checks

A proxy can keep identical runtime bytecode while delegating to a new implementation.
The [Aave proxy implementation](https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/dependencies/openzeppelin/upgradeability/BaseUpgradeabilityProxy.sol)
uses the [ERC-1967 implementation slot](https://eips.ethereum.org/EIPS/eip-1967):
`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`.
Its [immutable-admin proxy](https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/misc/aave-upgradeability/BaseImmutableAdminUpgradeabilityProxy.sol)
restricts its implementation getter to the admin, so an unauthenticated getter call
cannot be treated as authoritative introspection. Direct storage reads avoid that
caller-dependent behavior.

The [Circle FiatToken proxy implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/upgradeability/UpgradeabilityProxy.sol)
uses a different, legacy slot:
`0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3`.
The adapter therefore uses the Aave slot for pool/aToken and the Circle slot for USDC.
It does not discover arbitrary proxy families, beacons, diamonds or nested delegation.
The current adapter's supported contract family is specifically Ethereum Aave V3/USDC.
Sources inspected 2026-10-18; these mutable upstream source links explain the layout,
not the provenance/approval of an eventual production implementation.

## Registry and preparation contract

The execution file now requires all three implementation objects:

```json
{
  "poolImplementation": { "address": "0x…", "codeHash": "0x…" },
  "assetImplementation": { "address": "0x…", "codeHash": "0x…" },
  "aTokenImplementation": { "address": "0x…", "codeHash": "0x…" }
}
```

Each address is a nonzero 20-byte EVM address and each hash a nonzero 32-byte Keccak
runtime-code hash, excluding the empty-code hash. Existing proxy code hashes remain
required. There are no default pins and no optional bypass for the active service.

Preparation reads proxy code, implementation storage and implementation code at the
same numbered source block as reserve state. Storage must be exactly 32 bytes with
zero high 12 bytes; the decoded address must equal its registry pin. Implementation
code must be nonempty and match its independent code hash. All three checks precede
simulation. The existing final source-block hash recheck detects a changed canonical
block during preparation. Pre-send validation reruns preparation, so an upgrade
observed after signing stops a new send even if the proxy code is unchanged.

These are observations, not an on-chain condition embedded in a transaction. Governance
can upgrade after preflight or while the signed transaction is pending. State reads
by block number plus final canonical recheck also do not prove honesty of the RPC
provider or prevent an ABA reorg. Public launch still requires independently approved
implementation provenance and delegated dependencies, admin/governance risk policy,
upgrade monitoring and incident handling; stricter block-hash reads/provider validation
should be evaluated against the chosen production RPC. The application does not
silently adopt a newly observed implementation. A pin mismatch stops preparation or
pre-send progress; already submitted transactions continue receipt reconciliation.

## Shared RPC account budget

`EvmReadRpc::with_budget` requires Redis and an explicit `RpcBudgetConfig`:

```json
{
  "rpcBudget": {
    "scope": "ethereum-primary-account",
    "intervalMs": 100,
    "simulationCost": 10
  }
}
```

This is an **illustrative budget, not a provider entitlement or production default**.
The real values must come from the selected account's quota contract and measurements.
Allowed interval: 1–60,000 ms; simulation cost: 1–1,000 units. Scope: 1–64 lowercase
letters, digits or hyphens. A plain RPC call costs one unit; `eth_simulateV1` costs the
configured simulation units, regardless of its bounded call count. If a vendor has
additional method weights or per-chain/per-IP/monthly budgets, account for them with
a conservative base unit or extend the cost model before activation. This implementation
does not claim to model all vendors' billing units.

All replicas and all endpoints/keys sharing one provider quota must use the **same
Redis namespace and scope**. Scope deliberately is not derived from the endpoint:
rotating an API key or using two URLs must not create extra account capacity. It is
operator configuration, never a request field. Different environments/accounts may
use distinct scopes only when their actual quotas are independent.

The Redis script atomically checks:

1. An immutable `v1:interval:simulationCost` policy record. A mismatched replica fails
   closed; it cannot overwrite the existing policy with a larger allowance.
2. Shared cooldown/hold state.
3. The earliest next grant, using Redis server time.
4. On success, reserves `interval × cost` milliseconds before the next grant.

This is weighted grant spacing with no accumulated idle credits. It bounds admission
rate, not exact wire arrival times or the number of requests still executing remotely.
Heavy calls may create a large gap after their grant. A caller waits at most two seconds
for admission; it does not reserve a future queue slot. Four local slots bound executing
or admission-waiting calls per transport instance; excess callers fail immediately.
There is no fairness guarantee between waiting workers, so sustained pressure must be
observed and sized against queue age. A cancelled/failed call never refunds units:
Redis may have granted it even if the reply was lost. Local clone/restart does not
reset account state.

The optional uncoordinated constructor now accepts only literal loopback fixture
endpoints. Non-loopback reads require the coordinated constructor. Aave service startup
requires `REDIS_URL`, including its local acceptance environment; no outage fallback
silently switches it to local counters. Redis transport remains bounded and redacted.
Keys share the account hash tag; policy is persistent, next-grant expires after its
reservation, cooldown follows the upstream deadline or persists for a manual hold.

## HTTP failures and backpressure

No request retry or endpoint fallback is hidden in the transport. HTTP 429 and 5xx
publish the shared `Retry-After`, preserving long delays. Missing headers use ten
seconds; malformed/unrepresentable headers create an indefinite hold. Smaller/older
failures cannot shorten a larger cooldown or clear a hold. Network/body-read failures
request a ten-second cooldown. JSON-RPC `-32005` also pauses the account for ten seconds:
[EIP-1474](https://eips.ethereum.org/EIPS/eip-1474) describes that limit error, but vendors
may use other codes, so provider-specific classification remains a launch check.

Cooldown prevents subsequent grants; it cannot recall requests already admitted or
already received upstream. The transport retains its 2-second connection/12-second
HTTP deadline, no redirects and 256-KiB response bound. Envelope IDs/version are checked;
responses containing both result and error or malformed error shapes are rejected.
Errors do not include the endpoint, credentials, response body, wallet, or signed bytes.
Private metrics use fixed provider `evm_rpc`, operation read/simulate/receipt/broadcast,
and bounded outcome labels. Spans skip method parameters and endpoint information.
Cancelled futures may omit completion metrics, so request counts are not billing records.

## Dispatch ordering

The worker checks local endpoint/chain and reserves a single-use broadcast permit
**before** writing a durable dispatch attempt. Busy/cooling-down/Redis failures here
leave the job eligible for a later attempt; they do not manufacture an unknown send.
The permit holds a local slot, is bound to its exact client, and cannot be cloned.
After journal commit, it can send once within two seconds of admission. It does not
wait for another quota grant or make another chain RPC in the commit-to-send gap.
Nonce/preflight freshness and the drain check still apply independently.

A crash, stalled database commit, permit expiry or drain after commit still creates
an ambiguous attempt. The worker records Unknown and reconciles; it does not refund
quota, delete the journal, resend, or release the wallet guard just because no receipt
has arrived. The cross-system commit/send gap remains a documented limitation. A
shared cooldown arriving after the permit grant cannot recall that grant. Production
broadcast, replacement/cancellation and manual recovery policy remain separate work.

## Operations and rollout

Use persistent, private Redis with `noeviction` and monitor quota failures alongside
queue age. Failover that loses admitted reservations can permit a fresh burst; Redis
is not a contractual exactly-once quota ledger. Budget below the provider ceiling and
test provider-side enforcement, failover and overload before any capacity claim.

For a budget change, drain every producer using that account, let all prior grants
and in-flight requests expire, inspect existing cooldown/hold state, then coordinate
one reviewed policy-record change and restart all producers with identical values.
Do not change scope or delete cooldown to bypass a provider restriction. Clear a hold
only after its cause and provider permission to resume are understood. No production
Redis keys or deployment configuration were changed by this implementation.

## Verification and remaining evidence

`tests/rpc_budget.rs` covers independent clients sharing admission, weighted simulation
spacing, conflicting policies, long/persistent/JSON-RPC cooldowns, cancellation without
refund, Redis failure with zero outbound requests, bounded local concurrency, redirects,
oversized responses and malformed envelopes. Its Redis keys use unique test namespaces.
`tests/aave_preparation.rs` covers each implementation address changing under unchanged
proxy code, malformed storage words, changed/empty implementation code, and repeated
preparation after an upgrade. Existing economics/state/simulation/freshness tests remain.
The HTTP/fork harness observes implementation pins only for its disposable fixture,
runs the actual API/worker with Redis, restarts it, and exercises supply and withdrawal.
It clears its own RPC budget keys, drops its test database and reverts the fork.

Reproduce targeted service tests with isolated `TEST_REDIS_URL`/`TEST_DATABASE_URL`:

```sh
cargo test -p honey-server --test rpc_budget -- --include-ignored
cargo test -p honey-server --test aave_preparation
cargo test -p honey-server --test preparations --test submissions --test durability --test infrastructure -- --ignored
```

Full workspace gates remain `pnpm lint`, `pnpm typecheck`, `pnpm test`.
The fork command is in [AAVE-API.md](AAVE-API.md). Successful local verification does
not establish provider account throughput, production upgrades policy, full frontend
execution UX, replacement/recovery behavior, or 10k mixed-user capacity. Those remain
on the full [architecture roadmap](ARCHITECTURE.md).

Captured acceptance evidence: [Aave RPC/implementation fork run](evidence/aave-rpc-implementation-pins-local-fork-2026-10-18.json).
The final run passed approval plus supply, withdrawal, preparation/staging restarts,
and history recovery after disabling execution. All three implementation pins and
the test-only quota are recorded without keys/URLs/signatures. Workspace gates passed,
as did 37 disposable-service regressions and six preparation tests. One initial
harness startup failed because its generated namespace exceeded the existing 48-character
limit; the namespace and already-exited-child cleanup were corrected, the owned
empty database/config were removed and fork snapshot reverted before the successful run.
The acceptance fork was stopped after cleanup; no public transactions were sent.
