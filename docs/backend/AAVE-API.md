# Aave authenticated execution service

Status: implemented for an explicitly configured local Anvil fork, chain 31337.
Production activation remains disabled in code. This is the first path through the
actual authenticated API and supervised worker, rather than only internal repository
calls. The broader backend roadmap remains incomplete.

## Request and state flow

1. Authenticate with the existing server-issued SIWE EOA challenge. The session's
   wallet membership supplies the signer and chain; the request cannot override them.
2. `POST /api/v1/earn/aave/operations` with bearer, `Idempotency-Key`, and
   `{action:"supply"|"withdraw",amountRaw:"…",maximumNetworkFeeRaw:"…"}` returns
   HTTP 202 and the normal `OperationRecovery`. Amounts are canonical decimal
   strings. Unknown fields, recipient overrides and JSON numeric amounts are rejected.
3. The supervised worker claims a current `aave_v1` operation job with PostgreSQL
   `SKIP LOCKED`. It constructs the typed provider request, checks the current registry,
   and invokes the existing reserve/balance/allowance/code/simulation preparer.
4. A single transaction installs the immutable plan **and** immutable signing terms,
   advances to `awaiting_signature`, acknowledges preparation and writes its successor.
5. `GET /api/v1/operations/{id}/signing-request` returns the owner-scoped operation
   version, plan hash, complete plan, first nonce, individual gas limits, max fee and
   priority fee. A restart returns the same terms; it does not regenerate fees/nonces.
6. The client independently checks the registry, exact ABI calls, amount, recipient,
   approval scope, fee ceiling, operation/hash/version and expiry. Native signing also
   requires device confirmation and rechecks the session/wallet after asynchronous work.
7. `POST /api/v1/operations/{id}/signed` accepts
   `{expectedVersion,planHash,signedTransactions}`. Rust verifies canonical low-s type-2
   bytes and requires the exact persisted gas/fee/nonce terms. Durable acceptance
   encrypts the payloads and acquires the nonexpiring wallet/nonce guards. HTTP 202 is
   acceptance, never a settlement claim.
8. The worker simulates the remaining suffix again, checks account/contract/state/
   balances/allowances/pending nonce/fees, then collects canonical receipt evidence.
   Fresh successful predecessors and the current lease authorize the next step.
   It journals the dispatch before calling `eth_sendRawTransaction` exactly once.
9. Acknowledgement, rejection, mismatched hash, timeout and process death all lead to
   hash-based reconciliation. Only finalized receipts for **all signed slots** can
   release the guard. `GET /api/v1/operations/{id}` is the recovery contract.

`GET /api/v1/earn/aave/execution` returns only the public execution registry,
including `maximumAtokenRoundingRaw` so the client independently applies the same
operator-selected withdrawal dust bound as the server. Disabled
execution returns `unsupported`; absence of this endpoint's configuration keeps the
mobile execution panel hidden. General production Earn capabilities remain unavailable.
The generic recovery field `executionAvailable:false` is not permission to execute;
only the dedicated Aave service can authorize its own bounded path.

## Durability and concurrency

Migration `202610180005_aave_signing.sql` adds `aave_signing_requests`, keyed to the
immutable preparation. Its JSON is bounded at 48 KiB, hashed and protected by the same
update/delete rejection trigger. Reads verify the request hash, structural terms,
aggregate fee budget and equality with the separately persisted plan hash. Older plans
remain recoverable but do not acquire missing signing terms by inference. Readiness
requires the latest migration (now 6, including operation history) when authentication is configured. Migration remains explicit.

Claims select only typed Aave intents and the operation's current version. The service
processes one bounded job at a time per process; RPC work uses four shared permits.
HTTP mutations never run provider simulations or broadcasts. Worker spans carry the
operation ID/version and deferral logs use a static error code; signed bytes, auth
headers, RPC credentials and encryption keys are not logged. Parent trace propagation
through the outbox and execution-specific dashboards remain open. Worker work has a
180-second deadline and a 240-second fenced lease. Unchanged healthy reconciliation
polls defer five seconds; errors defer fifteen seconds. Execution reconciliation is
not dead-lettered merely because a provider is unavailable. All active attempts use
existing receipt/nonce fences. This serial local worker is **not** a throughput claim.

Before dispatch, the worker requires the freshly prepared calls to equal the original
remaining suffix, estimates to fit signed gas/fees, unchanged spend constraints, and
the exact next nonce. The completed preflight must be no more than ten seconds old
when journaling; receipt/nonce freshness is independently enforced by persistence.
An observed drain prevents a new send, including a second check after journal commit.
A crash in the commit-to-send gap remains ambiguous; it cannot be atomically eliminated
across PostgreSQL and a JSON-RPC node. No automatic resend is implemented.

Registry changes stop new preparation/signing progress but do not suppress receipt
reconciliation of an existing signed operation. Current authorization does not erase
old evidence. Lease loss cannot advance business state or expose bytes for a later send.

## Configuration and key custody

Set `AAVE_EXECUTION_CONFIG_FILE` to a mounted JSON file, at most 64 KiB. On Unix the
file must have no group/other permission bits (for example 0600). Required fields:

| Field | Meaning |
| --- | --- |
| `mode`, `chainId` | Exactly `local_fork`, `"31337"` |
| `rpcUrl` | Literal loopback `http://127.0.0.1:PORT`, no userinfo/fragment/redirects |
| `pool`, `asset`, `aToken`, `decimals` | Explicit reserve identity; not copied from a public APY catalog |
| `poolCodeHash`, `assetCodeHash`, `aTokenCodeHash` | Explicit Keccak proxy code identities checked at a pinned block |
| `poolImplementation`, `assetImplementation`, `aTokenImplementation` | Mandatory `{address, codeHash}` pins for implementation storage and runtime code |
| `rpcBudget` | Mandatory `{scope, intervalMs, simulationCost}` shared account admission policy; requires Redis |
| `registryRevision`, `zeroFeePolicyRevision` | Reviewed revisions; zero app/provider fees and Aave referral code zero |
| `maximumGasPerTransaction` | 21,000–2,000,000; numeric operator configuration |
| `maximumAtokenRoundingRaw` | Explicit decimal-string aToken rounding bound |
| `activeKeyId`, `dataKeys` | Active identifier and map of 1–4 identifiers to 32-byte hex application encryption keys |

These are **application data-encryption keys**, never wallet private keys. There is no
default key, generated-on-start fallback, log serialization or response serialization.
Keys are loaded into zeroizing buffers. Retain old key IDs for recovery until every
referencing signed payload is retired under an independently reviewed retention policy.
Changing the active key affects new ciphertext; it does not rotate old rows automatically.
The implementation does not claim KMS envelope encryption or safe key retirement.

`HOST` must be loopback and auth chain must be 31337. The broadcast transport separately
checks literal loopback and the RPC chain before reserving a single-use send permit.
Admission now precedes the durable dispatch record; quota pressure can defer safely.
See [RPC-AND-CONTRACT-IDENTITY.md](RPC-AND-CONTRACT-IDENTITY.md) for implementation checks,
shared limits, two-second permit expiry and remaining commit/send ambiguity. Production activation
requires a code change after the missing launch evidence is supplied. Merely editing an
environment flag cannot point this broadcaster at mainnet.

## Client and mobile behavior

The shared client validates endpoint response shapes and exact integer bounds, attaches
bearer credentials only to headers, and does not retry mutations. `validateAaveReview`
independently ABI-encodes the exact supply/withdraw/approval calls without importing a
large EVM SDK into the shared API transport. `aaveTransactionRequests` returns the exact
type-2 signing fields and rejects nonces that the wallet's JS signing API cannot represent.

The existing native Savings screen contains a configuration-gated local test flow.
Users enter token amounts and a total ETH fee ceiling; fixed-point parsing never uses
floating-point arithmetic. A second review shows targets, recipient, amounts and fees.
Device confirmation requires a device lock. Session changes, wallet changes, backgrounding,
review cancellation and screen cleanup invalidate pending signing. The private key is
wiped before the API call; signed JS strings are dropped promptly but cannot be reliably
zeroized by the JS runtime. A lost submission response triggers status recovery, not an
automatic resend. Successful finality uses the existing receipt UI with copyable IDs.

Limits: this local test panel has not had a physical-device visual/accessibility or
end-to-end UI tap-through acceptance run. It is not the final amount-entry/tray UX.
Owner-scoped operation discovery is now implemented in native Activity/Savings and web
sign-in; native Savings can reopen an unsigned intent for a new explicit review. See
[OPERATION-HISTORY.md](OPERATION-HISTORY.md). Offline history remains unavailable. Web/injected-wallet and extension execution flows remain open;
shared client contracts alone do not implement them. Native sign-in remains the existing
short-lived memory session, not a completed persistent-device authentication system.

## Verified acceptance evidence

[Recorded HTTP/fork evidence](evidence/aave-http-local-fork-2026-10-18.json) contains
actual persisted signing requests and finalized recovery objects from the successful
run on 2026-10-18: supply used two transactions (approval + action), withdrawal used
one. Both survived server restarts after preparation and staging. Duplicate creates
returned the same operation; changed intents conflicted; altered plan hashes were
rejected. Only the server worker broadcast signed transactions. The test's public scalar
was funded/undelegated solely in the snapshot and the database was dropped afterward.

Earlier test attempts hit archive-source 429s during sequential empty-block mining.
The final harness uses Anvil batch mining, verifies the exact block-count delta and
still requires the actual node's finalized tag. It does not substitute a success flag
or guessed confirmation count. This is simulated local finality, not public settlement.

## Verification and repro

- Full workspace lint, typecheck and tests passed, including the new exact-ABI,
  malformed-number, unsafe-nonce, signature cancellation and key-wiping tests.
- Thirty real-service regressions passed (10 preparation/API, 11 submission/receipt,
  7 identity/durability and 2 infrastructure). API-client tests: 37; mobile: 62 passed
  with 6 optional WalletConnect E2E tests skipped.
- Real PostgreSQL tests verify immutable terms and atomic rollback, authenticated
  creation, idempotency conflict, strict body parsing and owner-scoped signing requests.
- Existing signed-submission and canonical/finalized receipt regressions remain required.
- `packages/keyring/scripts/aave-http-fork-smoke.mjs` exercises actual server startup,
  SIWE, creation, restart after preparation, native shared-keyring signing, encrypted
  staging, restart after staging, supervised sends, and finalized supply/withdrawal.
  Its fixed local ports, public test scalar and unique database are intentional.

Build `cargo build -p honey-server --bin honey-server --example aave_fork_prepare`.
Use the isolated PostgreSQL service on port 25432 from the previous execution repro and
an owned Anvil instance on port 28545, chain 31337, fork block 26218343. Then run:

```sh
node --experimental-strip-types --import ./packages/keyring/scripts/local-ts-loader.mjs \
  packages/keyring/scripts/aave-http-fork-smoke.mjs
```

The harness validates Anvil/chain before fixture writes, snapshots/reverts the fork,
creates/drops a uniquely named database, and deletes its mode-0600 test configuration.
It uses public fixture credentials only. It mines empty blocks to advance **simulated**
local finality and asserts the exact head delta. A rate-limited archive source can fail
this integration test even when all local services are healthy; no public transaction
broadcast or production data write is part of the harness.

## Production blockers still explicit

Approved mainnet proxy implementations and upgrade policy; RPC provider budgets and
shared quotas/cooldowns; key custody/rotation operations; balance/position/history APIs;
replacement/cancellation and residual-approval recovery; contract/delegated account
support; final native/web/extension UX; production metrics/runbooks for execution;
independent chain/finality monitoring; and mixed-workload 10k-user/N-1 capacity evidence.
Aave integration does not complete Morpho, Uniswap, Relay, NEAR Intents, Hyperliquid or Polymarket.

References: [Aave Pool contract documentation](https://aave.com/docs/aave-v3/smart-contracts/pool),
[Geth simulation semantics](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth),
[Expo 57 LocalAuthentication](https://docs.expo.dev/versions/v57.0.0/sdk/local-authentication/).
The code adds its own signature/account/gas checks; simulation alone is not a signature
validator or a guarantee that state remains unchanged until inclusion.
