# P1: wallet identity and durable work

Implementation date: 2026-10-18. This document describes code that exists, its
tradeoffs, and the boundaries that must remain closed. The broader product design
is in [ARCHITECTURE.md](ARCHITECTURE.md); this is a concrete implementation record,
not an assertion that the entire roadmap or 10k-user acceptance gate is complete.

## Scope and evidence

| Implemented | Source |
| --- | --- |
| Embedded, explicit, transactional schema migration | `apps/server/migrations/202610180001_identity_and_work.sql`, `src/database.rs` |
| SIWE challenge issuance and EIP-191 proof verification | `apps/server/src/identity.rs` |
| Auth routes, rejection normalization, cross-replica proof limits | `apps/server/src/routes/identity.rs` |
| One shared PostgreSQL pool with server-side statement/lock/idle-transaction timeouts | `apps/server/src/runtime.rs` |
| Operation intent deduplication and transactional job insertion | `apps/server/src/work.rs` |
| Job claims, expiry recovery, fencing, bounded retry and terminal failure | `apps/server/src/work.rs` |
| Runtime-validated client contracts and strict challenge review validator | `packages/api-client/src/authentication.ts`, `client.ts`, `types.ts` |
| Actual browser wallet sign-in → protected profile → revocation flow | `apps/web/src/WalletSignIn.tsx` |
| Database-backed race/failure tests in unique disposable databases | `apps/server/tests/durability.rs`, `tests/common/mod.rs` |

No financial endpoint is enabled by authentication. Uniswap, Relay, NEAR Intents,
Morpho, Aave, Hyperliquid and Polymarket adapters still need their own account,
signing, eligibility, fee, provider and reconciliation acceptance checks. Existing
mobile/extension local vaults remain local; this change does not silently replace
their app-lock or onboarding flows with a server account.

## Why this initial identity method

The keyring already derives an EVM secp256k1 account using the established path
in `packages/keyring/src/index.ts`. This is evidence of a usable key type, not
evidence that all client screens already implement transaction signing. The
first server method is `siwe_eoa`, using the existing
[ERC-4361 message format](https://eips.ethereum.org/EIPS/eip-4361) and
[Spruce's Rust SIWE implementation](https://docs.rs/siwe/0.6.1/siwe/).

The deployed identity scope is one explicitly configured EIP-155 chain and an
explicit relying-party origin allowlist. The server never infers them from Host,
forwarded host, demo product names or an untrusted request body. `AUTH_ORIGIN` is
the primary origin used for originless native requests. Optional
`AUTH_ADDITIONAL_ORIGINS` is a comma-separated list of up to seven exact browser
origins; each must be an HTTPS origin without path/query/userinfo/trailing slash
(loopback HTTP is allowed for local development), and must also appear in
`CORS_ALLOWED_ORIGINS`. A Chrome extension can use its exact
`chrome-extension://<id>` origin, where `<id>` is 32 lowercase characters in
`a`–`p`. For browser requests, `/auth/config` selects the exact incoming Origin
only when it is in the auth allowlist, and challenge creation independently checks
the same Origin before issuing SIWE. Originless native clients keep the primary
`AUTH_ORIGIN`. `AUTH_CHAIN_ID` must be a positive signed-64-bit value. The primary
origin and chain must be configured together, and auth requires `DATABASE_URL`.
The extension build adds the API origin from `EXPO_PUBLIC_API_URL` to generated MV3
host permissions.

`GET /me/wallets` returns all EOA memberships for the authenticated principal.
`POST /me/wallets/challenges` creates a five-minute, origin-bound link-intent SIWE
message for the submitted same-chain EOA, and `POST /me/wallets` verifies and consumes
it under the same live session. This never merges principals: an address already
owned by another user returns conflict. The first version has no unlink, watch-only,
cross-chain or smart-account linking. See D104.

The verifier proves control of the secp256k1 key for the signed address. It does
not inspect `eth_getCode` or classify EIP-7702 delegation. `accountKind: eoa` names
the accepted authentication method, not a guarantee of no code at that address.
EIP-1271 contract verification, ERC-6492 counterfactual verification and delegated
execution are not implemented. Execution adapters must independently classify
accounts; this session is never a transaction delegation or signing capability.

Alternative: use email OTP as the initial principal. That would require an email
provider, delivery/abuse policy and a separate wallet binding proof. No such
provider is configured, and existing local email UI does not establish server
identity. Alternative: accept a submitted wallet address. That provides no proof
and is not an acceptable authorization scheme.

## HTTP contracts

All routes below are under `/api/v1`. Types are mirrored and responses validated
in `packages/api-client`. Runtime request IDs, CORS and `Cache-Control: no-store`
from P0 apply to the full production router.

| Method/path | Input | Success | Failure behavior |
| --- | --- | --- | --- |
| `GET /auth/config` | none | enabled/method/origin/chainId/sessionTtlSeconds | Disabled config is explicit; never enables trading |
| `POST /auth/challenges` | `{address, chainId: "eip155:…"}` | `{id, message, expiresAt}` | Wrong chain 422; malformed/unknown fields 400; quotas 429; DB outage 503 |
| `POST /auth/verify` | `{challengeId, signature}` | `{accessToken, tokenType: "Bearer", expiresAt, profile}` | Bad proof, stale/replayed challenge or changed policy 401; DB outage 503 |
| `GET /me` | `Authorization: Bearer …` | `{userId, wallet: {id, chainId, address, accountKind}}` | Missing, malformed, expired or revoked credential 401 |
| `DELETE /auth/session` | bearer header | 204 | Idempotent for a syntactically valid already-revoked token; DB outage 503 |

No auth route accepts a recovery phrase, private key, client-supplied SIWE message,
user ID, role or arbitrary wallet membership. Input structs deny unknown fields.
The verify route accepts only 65-byte signatures with supported recovery-byte
encodings. It does not call an RPC endpoint supplied by the client.

Tokens never go in URLs, cookies or localStorage. The shared client binds the
passed token into a header after caller options, sets `credentials: omit`, and
does not retry proofs or mutations automatically. A timeout during verification
may leave a short-lived session whose response was lost. The correct recovery is
a fresh challenge; replaying the consumed proof will fail.

## Challenge and session transactions

1. The service creates a UUID challenge ID, a random 122-bit UUID-v4 nonce, a fixed
   sign-in-only statement and a five-minute expiry based on PostgreSQL time.
2. The complete server-rendered message is stored. The client receives exactly
   that message plus the ID and expiry. Nothing is signed by the server.
3. The verifier loads an unconsumed, unexpired challenge and checks its policy
   still matches the running origin, chain and challenge ID. It verifies EIP-191
   with the stored address/message using SIWE's verifier.
4. A transaction conditionally marks the challenge consumed using database time.
   Under concurrent requests only one update can affect a row. Failed crypto does
   not consume the challenge; all proof attempts still encounter route quotas.
5. A transaction-scoped advisory lock serializes identity creation for the chain
   and address. A unique `(chain_id, address)` constraint is authoritative; a hash
   collision merely serializes unrelated sign-ins. One proof does not establish
   ownership of other derived addresses, chains, email identities or shared wallets.
6. The same transaction inserts the session and a minimal `signed_in` audit event.
   Failure rolls back challenge consumption, identity creation and session creation.
7. The bearer is two independent random UUID-v4 values encoded as 64 hex characters
   (244 random bits). Only SHA-256(token) is persisted. There is no token signing key
   to rotate and revocation is immediately observable across API replicas.
8. Every protected read checks the session's expiry/revocation in PostgreSQL and
   joins the exact `(wallet_id, user_id)` ownership relationship. No auth cache can
   make a revoked session valid. Logout and its audit event commit atomically.

Access tokens expire after **15 minutes**. The server now supports optional device-
bound 30-day refresh families with one-time rotation. Only refresh-token SHA-256
hashes are stored. Rotation is serialized on the family row; reusing a spent token
revokes that family and its access sessions. A refresh credential is not transaction
authority and does not change the SIWE wallet proof. Logout revokes the family.
Expired refresh hashes are retained until the family expires, then removed by bounded
maintenance. These server primitives have an ignored PostgreSQL test for wrong-device
rejection, rotation, and replay revocation.

Only originless requests receive a refresh credential; requests carrying an `Origin`
receive `null` refresh fields, and the refresh endpoint rejects origin-bearing calls.
This keeps browser JavaScript on short-lived in-memory access tokens while native
fetch clients can use platform secure stores. Origin presence is a browser boundary,
not device attestation. Mobile now persists the refresh family through the secure-store
adapter (Keychain/Keystore on device), keeps access only in memory, rotates before
access expiry, and suspends access on background/lock. Resume requires local owner
confirmation, current-wallet matching, rotation, and a protected `/me` check. The
extension uses the same exact-challenge SIWE flow, with its access token kept only
in memory for the current foreground popup. It receives no refresh credential and
requires manual sign-in after expiry or when backgrounded/locked. Popup closure removes
the local bearer but cannot reliably revoke the server-side 15-minute session; explicit
sign-out attempts revocation and reports failure while local access is removed. The browser password
prompt confirms the sign-in. A single deployment can serve web and extension auth by
setting the installed `chrome-extension://<id>` in `AUTH_ADDITIONAL_ORIGINS` and in
`CORS_ALLOWED_ORIGINS`; `/auth/config` and challenge creation use the matching exact
browser Origin while originless native auth stays on the primary origin. Extension UI
fails closed when the API's selected origin does not match the build's expected
extension origin. It displays the full validated SIWE message before approval, derives
and checks the selected account key, clears the private-key byte buffer, verifies the
issued profile through `/me`, and revokes a session if cancellation races with
verification. The access token exists only in popup memory; refresh credentials are
discarded. After sign-in, the extension now offers a user-triggered read-only
Hyperliquid account lookup using that bearer. It validates the returned account against
the signed-in wallet, aborts and clears the in-memory view on account change, sign-out,
or popup lock/unmount, and does not persist provider data. It does not submit orders or
sign transactions. Other provider/API screens remain unintegrated. User-visible per-device revocation remains missing. Mobile tests do
not replace physical-device or packaged-extension release acceptance. A lost native
refresh response may invalidate the family; the client does not retry automatically
and must offer SIWE recovery.

## Browser integration and client trust

The web shell uses an injected [EIP-1193 provider](https://eips.ethereum.org/EIPS/eip-1193).
The user first connects an account, then sees the full challenge, then explicitly
requests signing. `personal_sign` receives the exact UTF-8 message encoded as hex.
The client independently binds the message to `window.location.origin`, selected
address, selected chain, exact statement, nonce shape, request ID and five-minute
expiry. Arbitrary resources, transaction statements or extra lines are rejected.

The browser discovery response is not trusted as an origin allowlist: its origin
must equal the current page origin. Account/chain selections are checked before
and after signing and again before accepting the profile. Provider change events
invalidate pending work and clear active credentials. A late successful verification
response is revoked instead of reviving the old selection. The client then calls
the actual protected `/me` endpoint before rendering a signed-in state.

The token exists in a React ref only. It is not a component prop, URL, log entry,
DOM value or persistent browser-storage value. Reloading requires another sign-in.
Unmount/provider-change revocation is best effort; server expiry is authoritative
if the network is lost. Explicit sign-out distinguishes local clearing from an
unconfirmed server revocation. EIP-6963 multi-provider discovery and WalletConnect
are future work. Browser tests use a fake EIP-1193 provider; they are not claims of
hardware-wallet, mobile-wallet or browser-extension release certification.

Native/extension integration must obtain explicit user consent, unlock key material
through the existing vault, sign this restricted message on-device, and place any
longer-lived credential in an approved platform store. Face ID/local app unlock
alone is not server authentication. No derivation path was changed in this slice.

## Abuse limits, database timeouts and retention

Proof routes use atomic PostgreSQL fixed-minute buckets: 1,200 attempts/minute
globally, 30 attempts/minute per client IPv4 or IPv6 /64, and five challenges/minute
per address. These are conservative initial configuration-in-code limits, not a
measured 10k-user login budget. A minute boundary permits a bounded double burst.
Global limits are applied before allocating per-client/address rows. Any DB failure
fails closed; there is no process-local fallback that multiplies limits by replicas.

With `TRUST_PROXY_HEADERS=false`, quotas use the TCP peer. When true, configure
`TRUSTED_PROXY_CIDRS`; only a TCP peer inside those CIDRs may supply the appended
client address. Untrusted peers are keyed by their socket IP even when they forge
forwarded headers. The rightmost forwarded entry from an allowed proxy is used and
missing/malformed data is rejected. Proxy append/sanitization and network isolation
remain deployment responsibilities. Global quotas can be exhausted by a
distributed attacker; edge abuse controls remain a rollout gate. Address issuance
quotas can also be exhausted for a known address; adaptive challenges/edge policy
must be considered before opening unrestricted public registration.

Raw subject/IP values are not stored in limiter rows, only SHA-256 digests. This is
pseudonymization, not irreversible anonymization: IP spaces are enumerable. Treat
the records as sensitive. The `prune-auth` command deletes up to 5,000 old records
per auth table per invocation, retaining expired challenges/sessions and limiter
windows for one day. Schedule it every minute and monitor lag. This deletion rate
exceeds the limiter's nominal per-minute row allocation bound; database overload
or missed scheduling can still cause a backlog. Audit events have no automatic
deletion until the product retention policy is approved. Do not apply auth cleanup
to operations, job history, fee evidence or transaction observations.

`DATABASE_STATEMENT_TIMEOUT_MS` defaults to 5,000 ms, validated within 100–60,000.
The PostgreSQL connection also sets lock timeout to min(statement timeout, 2,000 ms)
and idle-in-transaction timeout to the statement timeout. These bound queries that
outlive a canceled HTTP handler; pool acquisition has its independent P0 budget.
Timeouts can produce an unknown commit outcome, so external effects are not retried
on the assumption that a canceled future rolled them back. Logs include a bounded
error category and SQLSTATE, never driver messages or bind values.

## Operations, idempotency and transaction boundaries

`WorkStore` is an internal repository, not an exposed “submit arbitrary intent” API.
Provider adapters must validate tokens, chains, recipients, amounts and fee policy
before invoking it. The initial generic intent accepts bounded object/array depth,
rejects JSON numbers, and limits encoded input to 8 KiB. Numeric financial values
must be exact strings. It stores a SHA-256 digest of a versioned canonical envelope
including action and wallet ID. Migration 2 now also stores the canonical plaintext
intent as immutable private evidence, never signed payloads or credentials; see
[PREPARATION-AND-RECOVERY.md](PREPARATION-AND-RECOVERY.md). Legacy digest-only rows
remain readable and explicitly cannot be reconstructed.
The current serde_json default object map sorts keys; changing that feature or
canonicalization requires a digest-version migration and compatibility tests.

Uniqueness is `(user_id, action, idempotency_key)`. Repeating the same intent returns
the existing operation, including its current state. Reusing a key for another
intent/wallet returns 409. Ownership is checked before deduplication and enforced
again by a composite foreign key. Cross-user and cross-wallet reads return 404.
There is no automatic key expiry that could accidentally permit a second transfer.

Creation inserts an operation, immutable intent and its `operation.created` job in one transaction.
Transitions use a locked row, expected version, allowed state edge and live worker
lease, then insert `operation.changed` for the new version in the same transaction.
Versions are decimal strings on the wire to preserve all bigint values. Invalid or
stale transitions return conflict. An injected outbox failure demonstrably rolls
back the operation change. The generic transition now only permits created → failed
before preparation. Immutable preparation owns created → awaiting_signature and
atomically acknowledges its job; financial transitions require future submission/receipt
evidence methods. A queue lease alone cannot assert financial success.

`unknown` is not failure: it means provider/chain reconciliation is required. The
repository does not implement confirmation depths, reorg handling, cancellation,
partial fills, bridge refunds or provider-specific terminal evidence. Those must
be designed and implemented with each adapter before money movement is enabled.

## Queue algorithms and failure semantics

The jobs table is both transactional outbox and durable queue. Workers use
[PostgreSQL SKIP LOCKED](https://www.postgresql.org/docs/17/sql-select.html) to claim
one ready/expired job in a short transaction. Each claim increments attempts and
assigns a new unpredictable UUID lease token and deadline using database time.
No transaction or pool connection remains held during provider I/O.

Completion and failure updates require a matching, unexpired token. Operation
transitions also lock/check the job and match its operation version, and recheck
expiry after obtaining the operation lock. A reclaimed job invalidates an old
worker's acknowledgement and domain writes. Retries use capped exponential full
jitter; only classified codes are stored. Final failed attempts become `dead`, and
the next claim sweep marks expired final attempts dead in bounded batches of 100.

This is **at-least-once work**, not exactly-once execution. A process can die after
a provider accepted a request but before the database commit/acknowledgement.
PostgreSQL fencing does not fence an HTTP endpoint or blockchain. The provider
adapter must use a stable external identity and reconcile ambiguous responses.
Never wire `fail → retry` to blind resubmission of financial requests. A transaction
can advance an operation and crash before acknowledging its source job; on retry,
the worker must recognize the advanced version and reconcile/acknowledge rather
than repeating the action. The changed-version outbox event is already durable.

Supervised local Aave/Morpho/Uniswap workers now exercise `claim`, `transition`,
`complete` and `fail` against configured local forks. Production provider dispatch,
heartbeat/extension, dead-letter inspection/replay tooling and public-network release
acceptance remain work; see `IMPLEMENTATION.md` for the worker scope and gates.
No Kafka/Redis stream broker is necessary for this initial durable queue. This
saves a distributed commit boundary but increases PostgreSQL write load and requires
queue table/index maintenance and load measurements before choosing worker counts.

## Local execution and release boundaries

Start only the disposable Compose project described in IMPLEMENTATION.md. Then:

```sh
DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:25432/honey?sslmode=disable' \
cargo run -p honey-server -- migrate

DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:25432/honey?sslmode=disable' \
REDIS_URL='redis://127.0.0.1:26379' REQUIRE_INFRASTRUCTURE=true \
AUTH_ORIGIN='http://localhost:5173' AUTH_CHAIN_ID=1 LOG_FORMAT=json \
cargo run -p honey-server

pnpm --filter @honey-wallet/web dev

TEST_DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:25432/honey?sslmode=disable' \
cargo test --locked --test durability -- --ignored
```

The chain above is a local identity example only; signing a message transfers no
funds. Each durability test creates its own `honey_test_<uuid>` database and applies
the migration there, then closes/drops it. A panic may leave a test database inside
the disposable service until that project is removed. Never point TEST_DATABASE_URL
at production. Tests require CREATE/DROP DATABASE privilege; the runtime application
role must not have that privilege in production.

Migration execution is an explicit operator command. API startup never creates
tables or migrates data. SQLx checks migration history/checksums and uses migration
locking; edits to an applied migration are rejected. New changes must use a new
forward migration and be added to the embedded source. The container build copies
the migrations before compiling so the runtime image needs no writable filesystem.
When auth is enabled, readiness requires the recorded schema version (currently
`202610180012`, including refresh-token families) as well as connectivity. The
required version is independent of enabled provider flags because all auth routes
share the same identity schema. This version probe is not a substitute for
release-time checksum, permission, restoration and expand/contract checks.

Separate migration/runtime roles, DB grants, managed TLS, backups/PITR, restoration
drills, deployment approval and native credential storage are still rollout tasks.
No existing database was migrated, no production service deployed, and no real
funds, fees or provider credentials were used during implementation.

## Verification and next acceptance gates

Seven real PostgreSQL tests cover:

- Invalid signer rejection; replay races with one winner; hashed session storage;
  cross-instance revocation and idempotent logout audit.
- Concurrent distinct proofs yielding one user/wallet; challenge/session expiry;
  old relying-party policy rejection.
- HTTP proof/profile/logout contracts and rejection of unknown private-key fields.
- Atomic minute buckets, bounded cleanup and repeatable migration application.
- Same-intent races, conflicting intent, exact amount strings, cross-owner denial,
  and rollback when the outbox insert fails.
- Exclusive claims, expired lease reclamation, stale worker rejection, legal state
  transitions, version conflict, and rollback of state changes on outbox failure.
- Explicit failure and crashed final-attempt dead-letter behavior.

A static fixture generated with the existing Noble 2.4.0 dependencies is verified
by Rust. A separate built-binary HTTP smoke generated a fresh Noble signature,
exercised a replay race, restarted the API without losing the session, revoked it,
and checked logs for credentials/signatures. These establish protocol and restart
behavior with a public test key; they do not certify hardware-wallet UX.

The client tests cover message/domain/address/chain/resource/expiry substitutions,
malformed responses, credential placement and no automatic proof replay. Browser
tests cover review before signing, protected profile retrieval, explicit sign-out,
origin mismatch, account changes and late-result cancellation. Full verification
results are tracked in IMPLEMENTATION.md.

Remaining: native integration and real wallet compatibility; broader Redis
read-model caching and edge quotas; dead-letter operator tooling; public provider
release gates and reviewed fee/builder-code contracts. Redis-backed pairing and price
delivery, along with supervised local workers, are implemented. None of these tests
measures 10,000 concurrent users, managed HA failover, database restore, real wallet
compatibility or provider limits.

## Native and extension sign-in continuation

The Settings → Wallet sign-in screen now uses the shared restricted SIWE validator,
then the existing device vault and keyring. Independently configured
`EXPO_PUBLIC_AUTH_ORIGIN` and `EXPO_PUBLIC_AUTH_CHAIN_ID` must exactly match the
server discovery response; the response cannot choose its own trust anchor. A
vault-backed account is required. Watched/demo accounts cannot produce a proof.
The entire server-issued message is shown before Sign in → owner confirmation.

`backend-session.ts` serializes the UI state, validates the key-derived address,
wipes the returned key byte array in a finally block, verifies the issued profile
with `/me`, and keeps the bearer outside persisted stores. JavaScript/runtime
copies are not guaranteed wiped. A wallet change makes the bearer unusable immediately,
then clears the local refresh family and attempts best-effort family revocation; app lock
and background suspend the bearer but retain refresh for owner-confirmed resume. Explicit
sign-out deletes local refresh and attempts best-effort remote revocation. Explicit
cancellation or expiry clears the credential.
A late successful verification is immediately revoked; background during biometric
confirmation cannot proceed to key access. An iOS inactive biometric dialog is
not treated as background. Extension uses the same screen with its existing
password confirmation and encrypted local vault.

The root mounts lifecycle observers. The sign-in screen cancels incomplete work on
unmount; an established session remains until the lifecycle rules above. Revocation
is best effort if offline/process-killed; access expiry is 15 minutes and refresh families
expire after 30 days. Remote device management and smart-account proof remain out of
scope. Same-chain EOA wallet listing/linking was added later under D104. D29 records
why the initial behavior is stricter than the eventual persistent-session UX.

Six native controller tests cover review-before-key-access, key-byte cleanup,
profile check, local expiry, watched accounts, independent origin, altered message,
mismatching key, background cancellation, account switch/late-response revocation,
and protected-profile failure. These mock device owner authentication; physical
Face ID/Android passcode and extension password acceptance still require runtime
checks. Expo 57 LocalAuthentication and React Native AppState documentation were
checked before integration:
[Expo 57 LocalAuthentication](https://docs.expo.dev/versions/v57.0.0/sdk/local-authentication/),
[AppState](https://reactnative.dev/docs/appstate).
