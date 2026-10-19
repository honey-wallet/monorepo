# Durable signed submissions and the initial dispatch journal

Status: internal repository implementation, migration 3 and owner-scoped recovery
metadata. A subsequent phase adds receipt reconciliation, later-step dispatch and
evidence-aware terminal guard release: [RECEIPT-RECONCILIATION.md](RECEIPT-RECONCILIATION.md).
This is **not a public submit API or running transaction worker**. Aave's
contract path is separately proven in [AAVE-EXECUTION.md](AAVE-EXECUTION.md). The full
backend and frontend execution milestone remains unfinished. Date: 2026-10-18.

## State and transaction boundaries

An operation progresses through these implemented boundaries:

```text
created -> awaiting_signature -> signed -> unknown
            immutable plan      stored     dispatch intent committed
                                           before returning bytes for RPC
```

`signed` means independently verified bytes were durably stored; it does not mean
sent. `unknown` conservatively covers a committed dispatch intent whose network
outcome may be missing, rejected, acknowledged or interrupted by a crash. Neither
state implies inclusion. RPC acknowledgement records an observation only. Receipt
verification and finality must independently produce later business transitions.

`WorkStore::stage_signed` accepts the existing unforgeable verified-bundle wrapper,
principal/wallet/operation IDs, expected version and a trusted recent nonce observation.
The caller must authenticate the session and revalidate the provider/account/nonce
against RPC. `NonceObservation` is an internal type, not public deserializable input.
Its ten-second maximum age is an explicit initial policy, checked with database time.
It does not turn caller-supplied data into proof of chain state.

Acceptance commits all of these together:

- Binding to the existing immutable plan hash and proven membership/chain/signer.
- One submission record and one encrypted transaction per ordered step.
- A wallet guard and unique `(chain, signer, nonce)` reservations.
- Operation `signed` and version increment, acknowledgement of the old notification
  job, and a successor outbox job.

No RPC call occurs under the database locks. The wallet row serializes competing
operations; within an operation the lock order remains job then operation, matching
the existing queue/preparation methods. A completed notification job may be superseded;
a currently leased job is not stolen. The final plan-expiry and observation-age checks
occur after lock waits and encryption. Any insert, uniqueness, deadline or outbox
failure rolls back the entire transaction.

A duplicate with the same immutable plan and ordered transaction hashes returns the
existing summary, including after its state changes. A changed bundle conflicts.
The eventual HTTP handler must recognize a persisted exact-byte retry before applying
fresh-signature expiry rules: an expired plan cannot authorize a new transaction,
but its known transaction identifiers remain recoverable.

## Nonce ownership and partial outcomes

The initial policy allows **one unresolved Honey submission per proven wallet**.
Different wallets do not share a global lock. Numeric(20,0) preserves every supported
EVM nonce without a JavaScript number or signed-bigint truncation. Database uniqueness
is the final guard against assigning a nonce twice within Honey.

There is deliberately no time-based expiry of a wallet guard or signed nonce slot.
An ordinary signed Ethereum transaction does not inherit the Honey plan's expiration.
Deleting a reservation because a quote expired could allow a previously signed
transaction and a replacement operation to compete. External wallets/devices can
still consume the same nonce; the guard is coordination within Honey, not exclusive
ownership of the on-chain account.

The later reconciliation phase releases a guard only when every known signed slot
has a finalized receipt. Replacement and cancellation still need an explicit user-signed
protocol; missing receipts or expired plans do not release a guard. Do not manually delete rows as routine recovery. If approval succeeds but
an action does not, allowance and remaining signed nonces still need reconciliation.
An operation cannot be declared harmlessly failed just because the worker timed out.

This conservative policy costs throughput per account and can leave a Honey operation
blocked pending resolution. It is preferable to overlapping financial authorization.
Parallel-wallet support remains available; multi-operation nonce pipelines are deferred.

## Encryption and sensitive data

`SubmissionKeys` accepts an operator-provided active key ID and up to four 256-bit
application data-encryption keys. These are **not wallet private keys**. No environment
variable, default key, implicit generated production key or KMS integration is activated
by this change. The server still cannot sign a user transaction.

Signed bytes use RustCrypto XChaCha20-Poly1305 with an OS-generated 192-bit nonce per
record. A versioned associated-data encoding binds operation, preparation hash, step,
chain, signer, exact nonce, transaction hash and key ID. Swapping rows/fields, modifying
ciphertext or using the wrong key fails authentication. The independent Noble fixture
pins byte-for-byte interoperability and a nonce above JavaScript's safe integer limit.

Private key containers, verified signed transactions and decrypted dispatch buffers
use zeroizing storage where owned here. Sensitive types lack Debug/Serialize. Public
recovery contains transaction hashes only. Instrumented methods skip all arguments;
SQL statement/bind logging is disabled by the shared pool. This reduces accidental
exposure; it is not protection against process compromise, crash dumps or a compromised
application key plus database access. The HTTP input layer must also avoid logging and
minimize plaintext copies once submission is exposed.

Rotation selects a new active writer key while retaining old decryption keys. Restart
recovery with an old key is tested. Immutable evidence currently cannot be re-encrypted
in place. A KMS-backed key-distribution/retention/backup/rotation runbook and an audited
re-encryption design remain launch requirements; losing a key does not release nonces.
The crypto dependency adds eight packages to the resolved lockfile. RustSec audit:
0 vulnerable packages, 2 pre-existing unmaintained warnings (derivative and paste).

## Dispatch intent and ambiguous outcomes

`begin_initial_dispatch` requires a current versioned job lease, fresh matching nonce,
unexpired plan and an intact wallet guard. It decrypts and hash-checks **step zero only**.
It then atomically inserts a unique dispatch intent, advances the operation to `unknown`,
acknowledges the lease and creates the reconciliation notification. Only after commit
does it return an `InitialDispatch` containing bytes and the expected transaction hash.

A crash before commit exposes no returned dispatch object and rolls back the journal.
A crash after commit but before the RPC call is indistinguishable from a lost response
until chain/provider evidence is examined. The unique initial intent prevents a generic
queue retry from dispatching it again. `observe_dispatch` records either acknowledged
or unknown, idempotently; contradictory repeated observations conflict. It never marks
success or releases a guard. Rejected RPC responses or mismatched returned hashes must
be treated as unknown, not proof that the network never received the transaction.

This is durable intent recording, **not exactly-once network delivery**. A stale process
can still possess bytes after its database lease expires. Future dispatch orchestration
must check fresh eligibility immediately before send, and must reconcile by exact hash.
A permit returned here is not a substitute for the provider/account/fee/simulation checks.

The initial entry point remains step zero. The later `begin_dispatch_step` method
requires fresh canonical successful predecessor evidence before releasing the next step.
Waiting for finality before every approval would exceed the current two-minute plan:
intermediate canonical inclusion and final business settlement need distinct states,
with reorg handling for every step. No confirmation count has been silently approved.

## API/client integration and migrations

GET `/api/v1/operations/{id}` retains principal and wallet scoping and execution=false.
It now returns `submission: null | { operationId, transactionHashes }`, ordered by step,
and accepts the distinct `signed` state. The shared client validates operation identity,
hash shape, uniqueness, step count and compatible state; it does not treat hashes as
receipts. No signatures, ciphertext, key IDs or arbitrary intent fields enter this response.

Apply `202610180003_submissions.sql` only through the explicit migration command.
It is additive except for extending the operations-state check constraint. Existing
operations receive no fabricated submission evidence. Authenticated readiness now
requires migration 3. No API-startup migrations run; tests migrate unique disposable
databases only. Coordinate this response/schema change with client rollout.

## Verification and next work

Six real PostgreSQL regressions cover concurrent acceptance, restart and key rotation,
owner scope, overlapping nonce/wallet rejection, stale nonce, complete rollback on
outbox failure, missing/wrong key, immutable rows, expired/fenced leases and a lease
expiring during an operation-row lock wait. Two crypto tests cover an independent
Noble vector, random nonces, every associated-data field and ciphertext/nonce tampering.
The shared client tests signed-state recovery and malformed/mismatched transaction IDs.

Next, implement canonical receipt observations and reorg/finality handling, then
release later steps only with validated predecessor evidence. Wire typed authenticated
Aave intent/prepare/submit endpoints, fresh chain checks, dispatch/reconciliation workers
and explicit frontend fee/call review, signing and status recovery. Exercise that path
against the disposable Aave fork through the real API and database. Add provider quota,
per-step metrics, secrets runbooks and failure/restart tests before any production switch.
All other provider execution and the 10k mixed-user workload remain in the full roadmap.

References: [RustCrypto XChaCha20-Poly1305](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/),
[PostgreSQL row locking](https://www.postgresql.org/docs/17/explicit-locking.html).

Final verification: `pnpm lint && pnpm typecheck && pnpm test` passed; 23 explicit real-service tests passed (6 submission, 8 preparation, 7 durability, 2 infrastructure). The six submission tests were rerun after the recovery integrity guard changed and passed. Shared-client suite: 33 passing tests. No existing database was migrated and no external transaction was sent.
