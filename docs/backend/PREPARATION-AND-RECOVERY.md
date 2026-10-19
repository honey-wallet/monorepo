# Immutable preparation and restart recovery

Implemented 2026-10-18. This closes a persistence gap: an intent hash alone cannot
reconstruct an approved transaction after a restart. This document describes the
persistence phase. Subsequent work adds Aave preparation/signature verification
([AAVE-EXECUTION.md](AAVE-EXECUTION.md)) and encrypted submissions/initial dispatch
journaling ([SIGNED-SUBMISSIONS.md](SIGNED-SUBMISSIONS.md)); no broadcaster or receipt
worker is running. No financial feature is enabled. See [ARCHITECTURE.md](ARCHITECTURE.md) for
the complete roadmap and [DECISIONS.md](DECISIONS.md), D38–D40, for alternatives.

## Evidence and code map

| Concern | Implementation |
| --- | --- |
| Immutable intent and plan tables | `apps/server/migrations/202610180002_preparations.sql` |
| Explicit embedded migration / schema readiness | `apps/server/src/database.rs`, `runtime.rs` |
| Intent + operation + initial job transaction | `apps/server/src/work.rs` |
| Typed EVM plan, validation, hash binding, persistence, recovery | `apps/server/src/preparation.rs` |
| Authenticated recovery route | `apps/server/src/routes/operations.rs` |
| Shared runtime-validated client | `packages/api-client/src/operations.ts`, `client.ts`, `types.ts` |
| Independent connection, races, rollback, expiry, corruption and HTTP tests | `apps/server/tests/preparations.rs`, `durability.rs` |

## What is stored, and why

New operations store the canonical intent alongside the existing versioned SHA-256
digest. The envelope remains `(1, wallet_id, action, intent)`. Its exact-byte digest
is unchanged. Intent JSON uses serde_json's recursively ordered default maps, accepts
no JSON numbers, and remains bounded by the original 8 KiB envelope limit. This is
an internal canonical format, not a cross-language JSON signing standard.

The API does not accept generic intent creation. Callers are trusted server code
that must validate product semantics and exclude credentials, signatures, keys and
provider authentication material. Structural bounds are not a sensitive-data
classifier: a future adapter must never put a secret into an arbitrary intent string.
The original intent can contain private economic activity and addresses. It is
stored in PostgreSQL, not Redis, application logs or the recovery response. Production
DB grants, encryption at rest, retention and controlled erasure remain rollout work.

Old digest-only operations have no recoverable intent. The additive migration does
not invent one, accept a caller's replacement, or backfill from an untrusted client.
They remain owner-readable with `intentAvailable: false`; preparation fails closed.
Repeating their old idempotency key still returns the original operation. An operator
and product migration policy is required before changing legacy behavior.

## First plan format: single-chain EVM calls

The schema intentionally represents ordered EVM calls for a proven account on one
chain. The provider discriminator can identify native transfers, Aave V3, Morpho
Vault V2 or Uniswap. These are storage discriminators, **not implemented executable
provider adapters**. Across/Relay destination/refund progress, Hyperliquid exchange
actions, Polymarket orders/fills and non-EVM transactions need their own plan and
reconciliation models. They are not forced into this call format.

A plan binds:

- Schema version 1, provider/action, decimal chain ID, lowercase signer and the exact
  existing intent hash. Persistence checks the wallet membership, not supplied user IDs.
- Approved-registry revision and fee-policy revision. Bounded identifiers record the
  decision source; this repository does not itself verify an approval registry exists.
- An optional provider quote reference (required by this format for Uniswap).
  It is a bounded opaque identifier, never a provider URL or credential.
- Maximum network fee, maximum spend, optional minimum receive and up to eight
  explicit app/provider fee components. Assets and recipients are addresses; `null`
  asset denotes the native asset. All raw values are canonical uint256 decimal strings.
  A maximum fee is a user-review bound, not an actual charged fee or revenue ledger.
- One to eight ordered calls: approvals followed by exactly one action. Each call
  binds purpose, recipient, raw native value and up to 4 KiB of even-length hex data.
  Approval calls cannot carry native value. No deployment/null `to` is supported.
- A recorded simulation block number/hash, observation time and SHA-256 digest of
  the exact ordered call bundle. The evidence must be at most 60 seconds old at
  persistence and cannot come from a future DB-clock time.
- An absolute expiry, required to be live and within 15 minutes of DB time. Adapters
  must choose a shorter deadline when their quote, approval or transaction expires sooner.

Total canonical plan size is capped at 32 KiB. Unknown fields are rejected throughout.
The plan digest binds every field, including fee and registry revisions, limits,
simulation record and expiry. Calldata changes invalidate the call-bundle evidence.
Both digests use SHA-256 for internal integrity; **neither is an Ethereum transaction
hash or an EIP-712 signing digest**. Ethereum replay protection and network transaction
hashing must be implemented by the signed-envelope validator, following the chain's
transaction rules; [EIP-155](https://eips.ethereum.org/EIPS/eip-155) describes the
legacy chain-ID replay-protection boundary.

These checks do not establish that calldata matches intent, that a simulation really
succeeded, or that a recipient/contract/fee is approved. Adapters still must verify
code/addresses, supported account type, allowance semantics, units, balances, slippage,
route/quote authenticity, eligibility, chain state, gas and economics. A fabricated
struct from trusted server code can satisfy structural checks. There is deliberately
no HTTP endpoint accepting it, no signing UI consuming it, and no execution permission
in its recovery metadata.

## Transaction and locking algorithm

1. Validate and canonicalize outside the DB transaction; compute the plan hash.
2. Lock the claimed job, checking operation ID, recorded version, token, leased state
   and live deadline. Lock the operation next, matching the existing queue lock order.
3. Join the immutable intent and proven membership. Recompute its digest and check
   created state, version, chain, signer, provider/action, expiry and simulation age.
4. Insert the immutable plan. Advance the operation to `awaiting_signature` and bump
   its version, rechecking lease and expiry at the final domain write after lock waits.
5. Mark the claimed job done and insert the successor `operation.changed` job in the
   same transaction. Commit once. No connection is held while calling a provider.

PostgreSQL row locks serialize competing writers until transaction end; consistent
lock order reduces deadlock risk. This follows the documented
[PostgreSQL 17 row-lock semantics](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS).
The primary key permits one plan per operation. A competing/stale attempt conflicts;
an outbox failure rolls back plan, version and acknowledgement together. A lost commit
response is recovered by reading the operation. Blindly generating a new operation is
not a recovery strategy.

The generic `WorkStore::transition` now only permits rejecting a created, unprepared
intent (`created → failed`). It cannot manufacture `awaiting_signature`, `submitted`
or `succeeded`, nor change any prepared operation. Preparation owns its transition;
future submission/receipt methods must own theirs and require appropriate evidence.
The SQL lease check also matches the actual stored job version. The terminal failure
transition now marks its source job done and inserts the successor outbox row in the
same transaction as the operation state/version change; a worker crash cannot leave
an expired source lease after the terminal state committed.

Evidence tables reject UPDATE and DELETE via triggers. Requote/revision changes need
a new operation and explicit review, never an in-place edit. DB ownership can bypass
triggers, so they are an application invariant, not a defense against a privileged DB
administrator. Read paths verify hashes and fail closed on corruption. An erasure or
retention program needs an audited administrative mechanism rather than an ordinary
application DELETE. No blanket TTL is applied to idempotency or financial evidence.

## Recovery API and frontend contract

`GET /api/v1/operations/{uuid}` requires the existing bearer session. It returns:

```text
operation: { id, walletId, action, state, version: decimal-string }
intentAvailable: boolean
preparation: null | {
  hash, provider, chainId, expiresAtMs, expired, stepCount,
  registryRevision, feePolicyRevision
}
executionAvailable: false
```

Ownership is constrained by both authenticated principal and the specific proven
wallet. Another wallet/user and nonexistent IDs return 404; missing/revoked/expired
authentication returns 401. There is no caller-supplied user or wallet override.
Invalid UUIDs receive the common JSON error envelope. The full production middleware
adds request correlation and no-store headers. Readiness requires migration
`202610180002` when authentication is configured.

Recovery uses one SQL statement snapshot so operation version and preparation cannot
come from different commits. It verifies persisted intent and plan integrity before
returning metadata. Raw intent, calldata, signer, economic amounts, signatures and
job leases are absent. Internal `load_preparation` reconstructs the exact immutable
plan for a future validated execution service, with the same ownership and integrity
checks. Expired evidence remains retrievable; expiry does not imply submission failure
and does not automatically change the operation's state.

The endpoint uses the existing PostgreSQL atomic fixed-window limiter: 60 reads per
proven wallet per minute. This is a low-volume recovery limit; it is not a 10k-user
polling architecture. Each request still authenticates and reads the DB; edge quotas,
load testing and a bounded private event-delivery model remain necessary. No history
scan, automatic polling or private WebSocket has been added in this phase.

The shared client's `operation(token, id, init?)` binds the bearer in the header, omits
cookies, validates runtime fields, preserves bigint versions and verifies the returned
operation ID matches the request. It rejects executable claims and cross-action plan
metadata. It does not retry requests automatically or expose a submit method. Existing
UI flows will consume this contract when actual operation creation/review exists;
there is no fabricated pending-transaction screen or fake success state.

## Migration and verification

Migration 2 is additive and embedded after migration 1; the original migration and
checksums are unchanged. No API startup migration runs. Deployments must explicitly
apply migrations with their approved migration role before routing authenticated
traffic to this build. Only unique disposable test databases were migrated here;
no existing application/production database was changed. Old application writers would
omit intent records during a rolling upgrade: drain mutation workers before enabling
new preparation, and treat such rows as legacy until a rollout policy is approved.

Reproduce with the disposable service from `compose.backend.yaml`:

```sh
TEST_DATABASE_URL=postgres://honey:honey_local_only@127.0.0.1:25432/honey?sslmode=disable \
  cargo test --locked --test preparations --test durability -- --ignored
pnpm lint && pnpm typecheck && pnpm test
```

Tests exercise the actual PostgreSQL engine, independent connections and production
router: competing plans, stored-version/lease checks, lock-wait expiry, outbox rollback,
immutable triggers, corrupted hash rejection, exact restart reconstruction, legacy
records, expired evidence, wrong owner/wallet, revoked sessions, response privacy,
schema-gated readiness and canonical units/call changes. CI includes these real-service
tests explicitly; ordinary cargo test skips them. Shared-client tests cover raw versions,
malformed/cross-action metadata, bearer placement, response-ID substitution and no retry.
Verification passed: full workspace lint/typecheck/test; eight new real-PostgreSQL
preparation tests plus seven existing durability tests; eight existing real-service
infrastructure/Redis/WebSocket/OTLP regressions; 32 shared-client tests. The ordinary
preparation bounds test also passes. No dependency versions changed in this phase.

Synthetic plan fixtures are persistence evidence, **not live Aave or Morpho transaction
validation**. No signature, transaction or provider write was sent.

## Remaining execution work

Subsequent layers now implement the internal Aave preparer, signed-envelope validation
and durable initial attempt identity. The next layer must connect these through an
authenticated service and implement provider-specific reconciliation. A timeout or
missing receipt is not proof of failure: Ethereum's
[transaction receipt RPC](https://ethereum.org/developers/docs/apis/json-rpc/#eth_gettransactionreceipt)
can return no receipt for a pending transaction. Nonce replacement, reorg/finality,
ambiguous commits and approval/action ordering require explicit recovery rules.

The later signed-submissions phase adds a ledger; a running dispatch/receipt worker
still remains to be implemented. Do not interpret the queue's retry support as permission to resend funds.
Approved launch chains/products, fee/builder policy, RPC/provider access, signer/account
compatibility, jurisdiction/eligibility and real-device acceptance remain launch gates.
The independent mixed-workload, TLS, N-1/failover and restore tests for 10,000 concurrent
users remain outstanding across the entire backend roadmap.
