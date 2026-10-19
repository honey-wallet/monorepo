# Uniswap service, worker and native review flow

Status (2026-10-18): the internal preparation components now have authenticated
HTTP commands, a supervised durable worker, typed client validation and native
review/permit/transaction signing. One synthetic-provider/mock-RPC test exercises
HTTP → worker → immutable review → permit admission → simulated preparation →
real EIP-1559 signing → encrypted submission, including exact retries. **The new
service now also has actual-contract V3 HTTP-to-finality acceptance**, including
restart recovery, bounded fees, a lost broadcast acknowledgement and an unfillable
minimum. See [service acceptance](UNISWAP-SERVICE-ACCEPTANCE.md) for reproducible evidence
and limits. The provider remains synthetic; this is not live Trading API acceptance.
Production swap availability remains false.

## Explicit local execution boundary

Enable only with `UNISWAP_EXECUTION_CONFIG_FILE`, loopback server `HOST`, auth chain
31337, PostgreSQL, Redis and `MAX_REQUEST_BODY_BYTES` at least 196608 (192 KiB).
The body bound accommodates the supported 64 KiB router calldata after hex encoding,
approvals and signed-envelope overhead. This setting is exclusive with the existing
`UNISWAP_QUOTE_CONFIG_FILE`. The normal quote path keeps its fixed production origin
and live-chain allowlist.

The mode-0600 execution JSON file has these fields; no secrets belong in git:

| Field | Meaning / restriction |
| --- | --- |
| `mode` | Exactly `local_fork` |
| `rpcUrl` | HTTP literal `127.0.0.1`; RPC confirms chain 31337 before nonce admission/broadcast |
| `rpcBudget` | Existing Redis account scope, interval and simulation cost policy |
| `registry` | `UniswapExecutionPolicy` including all code/implementation pins, token decimals, revisions and bounded gas/block lag |
| `quoteConfigFile` | Separate mode-0600 quote registry file with chain 31337 |
| `fixtureOrigin` | HTTP literal `127.0.0.1`, no credentials/query/fragment/path; synthetic `/quote` and `/swap` server |
| `maximumFeeRoundingRaw` | Explicit 0 or 1 base-unit allowance, shown in review |
| `activeKeyId`, `dataKeys` | Existing bounded application AEAD key ring; retain old keys needed by history |

The local quote file uses the existing quote configuration schema, but its `apiKey`
must be exactly the nonsecret sentinel `local-fixture-only`. This prevents accidental
forwarding of a real Trading API key to a fixture endpoint. Token addresses/decimals,
router, Permit2 and revisions must match the execution registry. `TokenCode` uses
`{"kind":"direct"}` or `{"kind":"usdc","implementation":{...ContractPin...}}`
or `eip1967` with the same implementation shape. Registry approval/dependency closure
still has the requirements described in [UNISWAP-PREPARATION.md](UNISWAP-PREPARATION.md).
The local endpoint uses the same quote normalizer, build validator, account quota,
body bounds, response-version checks and economic proof as normal transport.

A real Trading API response cannot simply be relabeled from Ethereum to 31337:
chain identity is part of Permit2's signed domain. Local fixtures must produce
chain-31337 authority. No production broadcast escape hatch was added.

## Commands and recovery

All paths are under `/api/v1`. Execution mutations require a wallet session and
use global/wallet limits of 60/10 per rate-limit window; execution reads use 600/60.
Quote reads retain their existing separate limits. Shared HTTP middleware adds
request/trace IDs, bounded admission/deadlines and `Cache-Control: no-store`.

| Method / path | Contract |
| --- | --- |
| `GET /swaps/execution` | Explicit local configuration; production capability remains false |
| `POST /swaps/operations` | Idempotency key and `CreateSwap`; returns owner-scoped operation recovery |
| `GET /operations/{id}/swap-intent` | Original public intent for restart discovery |
| `GET /operations/{id}/swap-review` | Authenticated immutable public review and review hash/version |
| `POST /operations/{id}/swap-permit` | Exact reviewed PermitSingle signature and expected version |
| `GET /operations/{id}/swap-signing-request` | Authenticated original review plus exact nonce/gas/calls |
| `POST /operations/{id}/swap-signed` | Exact EIP-1559 bundle and expected plan hash/version |

`CreateSwap` contains canonical-string token addresses, amount, slippage basis
points, minimum output, deadline seconds and total network-fee cap. Numeric economic
values remain strings in immutable intents. The original intent also records chain,
registry/fee revisions and the explicit rounding allowance. A newly fetched quote
may improve the minimum output, but cannot worsen the user's floor. This second
quote is created before immutable review; the worker never re-quotes a signed review.

Public recovery contains neither a Permit2 signature nor calldata. Signing responses
are sensitive: no Debug/log serialization, shared-cache use or device persistence.
Historical signing evidence is readable after expiry; reads do not grant renewed
signing, submission or broadcast authority.

## Durable worker behavior

The worker claims one service-owned job per tick using `SKIP LOCKED`, a fresh lease
token and operation version. A job has a 240-second lease and 180-second processing
budget; transient read/provider failures defer for 15 seconds. Independent replicas
can compete safely, but this is not measured throughput for 10k active users.

1. `created`: bind the immutable intent, fetch/validate the exact quote, create the
   review, observe pinned chain/allowance/nonce state and persist it atomically.
2. `awaiting_permit`: wait for an explicit user action. New admission requires a
   fresh RPC nonce/finality observation sourced from the authenticated quote. Exact
   retries acknowledge already admitted bytes without requiring another RPC read.
3. `building_swap`: reconstruct the stored quote and exact admitted signature,
   validate the build, simulate finite approvals plus action, and atomically install
   the reviewed encrypted preparation. No replacement permit or expiry extension.
4. `awaiting_signature`: independent wallet review and explicit owner confirmation.
   Submission verifies every signed transaction, exact gas/nonce/fee terms and fresh
   pending nonce. Exact bundle retries return existing recovery.
5. Signed/unknown/confirming: reconstruct the same saved call, revalidate it without
   a provider rebuild, and simulate the remaining approval/action suffix against
   fresh state. Require its nonce, calls, gas limits and fee needs to fit the signed
   suffix. Reconcile even if policy, expiry or fees prohibit another send. Existing
   durable dispatch journaling and predecessor/finality checks govern each send.

A definitive failure before preparation may terminate `created` or `building_swap`.
**Failure retains the admitted permit and nonce reservation.** No timeout/failure
releases still-valid transferable authority. Expired awaiting-permit/signature
records remain historical; the UI permits a new explicit review, never refreshes
one silently. An unresolved signed bundle remains in reconciliation and is never
blindly resent. Old signing readers must support the version-2 encrypted envelope.

## Client and native consent

The shared API client mirrors all response types and checks operation identity,
canonical integers, bounds, chain, timestamps and Permit2 shape. Its independent
review validator binds signer, original intent, token registry, router/Permit2,
deadline, minimum output, network budget and every fee/rounding recipient. The
signing validator re-runs router/economic proof, enforces exact reset/finite approval
sequences and binds the embedded permit. Server hashes identify artifacts; they
never replace these semantic comparisons. Existing Earn validation remains stricter
for its own provider-specific fields and calldata limits.

The native Swap screen discovers local execution separately from quote availability.
It shows amount/minimum, fee policy, network cap, recipient and permission expiry.
Permission and transaction signing require separate explicit confirmation. No effect,
poll, timeout or restart signs automatically. Session/account/foreground changes
invalidate active reviews; key bytes are wiped before submission. Request history
can reopen unfinished swaps from authenticated stored intent. After restart, the
embedded Permit2 signature is verified offline against the EOA and fixed typed data
before transaction signing. No permit signature is saved in device storage. Unknown
outcomes show status recovery, and success is displayed only for finalized state.

Relevant API references checked against installed Expo 57 and existing keyring APIs:
[Expo Crypto](https://docs.expo.dev/versions/v57.0.0/sdk/crypto/),
[AppState](https://reactnative.dev/docs/appstate). No dependencies were added.

## Evidence and remaining acceptance

- Synthetic HTTP/provider/RPC + isolated PostgreSQL/Redis: create retry, immutable
  review, changed-version/hash rejection, permit admission/retry, build preparation,
  real signed-bundle admission/retry and public signature redaction. Provider is
  contacted once for the quote and once for the build in this test.
- Preparation persistence: failed unprepared build keeps review, signature and nonce
  guard; prior atomicity/lease/restart/rotation checks remain enabled in CI.
- Shared client: valid fixed fixture, changed economic/identity/expiry/fee/gas terms,
  exact approvals, missing permit, endpoint authentication and identity substitution.
- Native signing: cancellation, session/foreground changes, key wiping, stable
  review snapshots and offline embedded-signature verification failure. Keyring
  tests verify an actual typed signature and reject wrong signer/changed message.
- Configuration rejects public listen addresses, live chains, conflicting quote
  mode, missing Redis and insufficient request-body bounds.

Still required: additional route/reset/reorg/failover service scenarios,
physical-device UX, web/extension execution, authenticated production Trading API
acceptance, production registry/fee approval, and mixed-load/failover measurement.
These tests do not prove those requirements. Local mode is an acceptance harness,
not the completed production swap product.
