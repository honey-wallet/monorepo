# Relay and Across observation recovery

Implemented and locally verified: 2026-10-18. Decisions D83–D84.

This milestone adds provider status readers, durable polling, an authenticated
recovery endpoint and web/native history presentation. **It does not create a
bridge quote, prepare a deposit, execute a bridge or prove delivery/refund.** No
public command currently creates the signed bridge bundle required to register a
watch. Fixtures exercise this internal handoff with relational metadata, not a
valid signed financial preparation. No production bridge capability is enabled.
Subsequent work adds an independent direct-ERC20 Across proof primitive with
actual-contract fork evidence ([ACROSS-EVIDENCE.md](ACROSS-EVIDENCE.md), D85–D86).
It strengthens Across watch registration; stored status responses remain advisory.
Authenticated Across direct quote reads are now implemented separately in
[ACROSS-QUOTES.md](ACROSS-QUOTES.md); they do not create signed bridge operations.

## Authority and contracts

The immutable operation intent commits `bridgeTracking`: provider, source chain,
destination chain and refund chain, plus Relay's request ID. A source transaction
hash cannot exist before signing and is therefore bound later to the last entry
of the persisted signed source bundle. Across's deposit ID likewise arrives
later. New Across watches now require `attach_across` with a verified canonical
source result and matching immutable `acrossDirectDeposit` terms. The original
caller-supplied lookup-hint path is no longer accepted for new registrations.

`BridgeMonitor::attach` (Relay) and `attach_across` require a bridge operation, matching immutable intent
terms and that operation's last signed transaction on the expected chain. It
rejects an approval hash, missing bundle or changed binding. Registration is
internal only; there is no endpoint for submitting arbitrary provider IDs. The
table's immutability trigger prevents rebinding or deleting a watch. Digest
checks detect inconsistent stored serialization; these are integrity checks,
not authentication against a database administrator.

The provider response is an observation. Even a matching source transaction and
provider-reported fill only identify candidate transactions. They establish
neither recipient nor token/amount nor canonical finality. Every response has
`verificationRequired: true`. Polling never advances financial operation state,
releases a nonce reservation, requests a signature or sends a transaction.

| Provider | Fixed request | Binding checks | Normalized observation |
| --- | --- | --- | --- |
| Relay | `https://api.relay.link/intents/status/v3?requestId=…` | Expected source/destination chains and source hash; at most one input transaction; bounded unique EVM output hashes | Waiting/depositing/pending/submitted → pending; success → fill reported; refund with a candidate → refund reported; refund without candidate → refund pending; failure → recovery required |
| Across | `https://app.across.to/api/deposit/status?originChainId=…&depositId=…&integratorId=…` | Exact deposit ID, chains and source hash; matching aliases; no multiple-deposit pagination or unsupported action/sweep fields | Received/pending → pending; filled → fill reported; expired → refund pending; refunded → refund reported |

Terminal-looking reports require their corresponding candidate hashes. Across
fill and refund candidates together are rejected as ambiguous. Unknown states,
conflicting aliases, malformed/zero hashes and unexpected chains are rejected.
HTTP 404 is `not_indexed`, not a failed transfer. Expiry does not prove funds
returned. Relay refunds are currently restricted to the source chain; Across's
refund chain comes from the immutable route policy. Only EVM-shaped identifiers
are supported; this is not Solana, embedded-action or universal bridge support.

Provider freeform reasons, details, payloads and URLs are neither copied into
recovery responses nor logged. Requests use fixed origins and paths, with no
redirect following or automatic request retry. A malformed provider response
cannot choose a destination for another HTTP request.

## Durability, limits and recovery

Migration `202610180010` adds `bridge_status_watches`. It stores the immutable
binding, source-transaction foreign key, next poll time, lease token/deadline,
version, latest observation/digest and a fixed error code. Claiming uses
`FOR UPDATE SKIP LOCKED`; completion requires the same token/version and an
unexpired lease. A crash leaves a 30-second lease for another worker to reclaim.
Failed reads retain the previous observation rather than rewriting it as failure.

Each process handles one poll at a time with a 100 ms tick. Provider transport
also caps concurrent admission at four without queueing. Requests have a 2-second
connect deadline, 8-second total deadline and 64 KiB streamed body cap; the worker
has a 15-second read deadline. Redis account admission is shared across replicas.
429/5xx responses apply a shared cooldown using bounded Retry-After handling;
network failures apply a 10-second cooldown. Redis failure prevents provider reads.

Pending/fill observations schedule another read after 10 seconds. Refund/recovery
observations use 60 seconds. Errors schedule 30 seconds; all receive deterministic
0–2550 ms operation jitter. Admission may delay a due read further. These are
conservative local policies, not a claim about account entitlements or latency.
Every future quote/build/status caller sharing a provider account must use the
same admission scope and agreed costs, or these limits would be incomplete.

There is deliberately no stop condition derived from a provider's terminal label.
Until a verified chain-outcome handoff and archival policy exist, watches continue
polling. **Do not activate this monitor at production scale yet.** A backlog age
SLO, terminal-proof stop condition, per-provider fairness and measured quota demand
are still required. The current single-poll loop is bounded but can underutilize
an account; increasing concurrency requires measurement and failure tests.

`GET /api/v1/operations/{id}/bridge-status` authenticates the session and exact
user/wallet ownership, then reads PostgreSQL only. It never causes a synchronous
provider call. The current read quotas are 600/minute globally and 60/minute per
wallet; these defensive defaults are not a 10k-user capacity design. Stored
recovery remains available without provider credentials. A missing watch returns
404. Missing/older-than-three-poll-interval observations are marked stale.

The shared API client validates identifiers, roles, candidate chains, observation
times and advisory semantics. Web and mobile fetch only the selected operation,
cancel on session/visibility/focus changes and poll at the supplied interval.
Source finality is labelled separately from destination outcome. Provider fills
say confirmation remains pending; refund observations do not claim funds arrived.
The UI makes no automatic repeat-deposit or refund transaction. Physical-device
acceptance and a complete bridge quote/review/sign interface remain open.

## Configuration and rollout

`BRIDGE_STATUS_CONFIG_FILE` is optional. When set, runtime requires PostgreSQL,
Redis and authentication configuration. The existing protected configuration-file
loader requires a regular file without group/other permission bits on Unix.
Use a secret-managed, mode-0600 JSON file; never commit its populated contents.

```json
{
  "relay": {
    "apiKey": "REPLACE_WITH_SECRET",
    "accountScope": "relay-account-name",
    "intervalMs": 1000
  },
  "across": {
    "account": {
      "apiKey": "REPLACE_WITH_SECRET",
      "accountScope": "across-account-name",
      "intervalMs": 1000
    },
    "integratorId": "0xabcd"
  }
}
```

Either provider may be omitted; an empty file configuration is rejected. The
example intervals and integrator ID are placeholders, not approved settings.
Select spacing from the actual account agreement. Provider names prefix Redis
budget scopes to avoid collisions. Relay credentials use `x-api-key`; Across uses
a Bearer credential. Sensitive header values are marked for redaction. No endpoint
override is available in a production build; literal loopback overrides exist
only under `cfg(test)`.

Readiness now requires migration 10. Apply it explicitly through the existing
migration procedure before upgrading a configured instance; API startup does not
migrate data. This work applied migrations only to disposable test databases,
not the base development database or any production system. Retain old signing
keys/configuration required for existing encrypted submissions. Removing provider
configuration stops new polls and preserves historical reads; it does not cancel
an already submitted deposit.

Transport spans and metrics use fixed provider/error labels. No request ID, wallet,
transaction hash or response body becomes a metric label. Worker failures emit a
static retry code. Operator backlog dashboards, error-class paging and verified
bridge settlement metrics remain future work.

## Current provider evidence and execution prerequisites

Relay's status contract is documented in its [v3 status reference](https://docs.relay.link/references/api/get-intents-status-v3)
and machine-readable [API description](https://api.relay.link/documentation/json),
retrieved during this work. Across status fields and aliases were checked against
its [status reference](https://docs.across.to/api-reference/deposit/status/get).
A guessed Across `/openapi.json` URL returned 404; no machine-readable Across
schema has been pinned or authenticated response accepted.
The observed Relay schema hash and evidence limits are recorded in
[contract evidence](evidence/bridge-status-contracts-2026-10-18.json).

Relay's [refund guide](https://docs.relay.link/references/api/api_core_concepts/refunds)
requires explicit `refundTo` for automatic refunds, while the quote schema describes
recipient/user defaults. Future command creation must explicitly commit `refundTo`
and verify the returned order, rather than relying on conflicting defaults.
Relay's [input validation guide](https://docs.relay.link/references/api/api_core_concepts/input-validation)
calls for protocol order data and independent checks. The execution design must
recompute order identity and verify payer, assets, amounts, recipients and the
approved depository, not merely trust a quote ID or displayed output.

Relay's [contract documentation](https://docs.relay.link/references/api/api_resources/contract-addresses)
announces a v3.2 router/ApprovalProxy migration for 2026-10-26 at 10 AM ET and an
ABI request process. This requires versioned deployment review before enabling
execution; legacy pins cannot silently authorize a replacement router.

Across currently documents [swap/approval](https://docs.across.to/api-reference/swap/approval/get)
for transaction construction. Quote, approval and swap payloads require independent
decoding, exact finite allowances and economics checks. Explicit `refundOnOrigin`
and `refundAddress` must be committed because refund behavior depends on route.
Its [refund documentation](https://docs.across.to/introduction/refunds) separates
expiry and subsequent recovery; these cannot be collapsed into one successful
refund state. Credentials, integrator registration, quotas and live response
fixtures remain external prerequisites, not values inferred from examples.

The next execution milestones are:

1. Approve a bounded chain/token/EOA route and deployment registry per provider;
   obtain current API/ABI fixtures and exact fee/refund terms. Record source
   evidence, code identity, version, activation switches and rejection cases.
2. Build immutable quote/review contracts and independent calldata/protocol-order
   decoders. Verify sender, source/destination asset, recipient, minimum amount,
   deadline, native value, allowances, builder fees and refund authority. Treat
   unsupported steps/signature schemes as unavailable.
3. Simulate the ordered source sequence and reuse sealed preparations, device
   signing, nonce reservations, journaled dispatch and ambiguous-send recovery.
   Persist the monitor handoff without assuming a source receipt means delivery.
4. Wire the direct Across source/fill proof into execution and durable outcomes;
   implement Relay source/order proof, remaining Across route shapes and both
   refund verifiers. Independently verify asset/recipient/amount under chain
   finality and reorg rules. Only persisted proofs may advance the end-to-end
   financial outcome and stop a watch.
5. Exercise restart at every boundary, lost acknowledgements, delayed indexing,
   no fill, partial/unsupported results, destination reorgs, refund delay and
   concurrent workers. Confirm no duplicate deposit and no premature nonce release.
6. Connect complete web/native review and recovery, test actual devices, then run
   authenticated provider acceptance and mixed-workload capacity/failure tests.

## Verification

Provider tests cover strict normalization plus loopback HTTP/Redis admission,
credential/query shape, redirects, 404, invalid/oversized responses, shared cooldown
and credential-free metrics: **5 passed**. Monitor tests cover immutable binding,
ownership, competing claims, stale leases, restart, retained observations and
provider → worker → authenticated recovery: **3 passed**. These use synthetic
provider responses and disposable PostgreSQL/Redis data, not real transfers.

The shared-client tests reject inconsistent candidate/chain/role/state claims.
A web regression verifies that a generic source operation marked succeeded still
shows a provider fill as awaiting destination confirmation. Ordinary suite checks
and opt-in durability/preparation regression results are recorded in
[IMPLEMENTATION.md](IMPLEMENTATION.md). The two opt-in bridge suites also run in CI.

```sh
TEST_DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:25432/honey' \
TEST_REDIS_URL='redis://127.0.0.1:26379' \
cargo test --locked --lib bridge_monitor:: -- --include-ignored

TEST_REDIS_URL='redis://127.0.0.1:26379' \
cargo test --locked --lib providers::bridge_status:: -- --include-ignored
```
