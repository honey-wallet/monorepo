# Across direct bridge quote boundary

Date: 2026-10-18. Decisions D87–D88. This documents authenticated quote reads
and a deliberately local-fork-only execution slice. Live-provider acceptance,
public-network execution, refunds and builder revenue remain disabled.

## API and authority

`GET /api/v1/bridges/across/configuration` returns the public reviewed route
registry; credentials and account quota keys are omitted. `POST
/api/v1/bridges/across/quote` accepts only `routeId`, `amountRaw`,
`minimumOutputRaw` and `recipient`. Authentication supplies the sender. The
session's chain must match the configured source chain. Requests are limited to
240 globally and 10 per wallet per minute before consuming provider quota.
Unknown fields are rejected, including a client-supplied sender or private key.

Amounts and chain IDs are decimal strings. Quotes bind registry revision, route,
owner, recipient, both token addresses, exact input/output, fee and expiry. The
returned minimum is the exact decoded destination amount, which must be at least
the requested floor. Source gas is an estimate in **gas units**, not a native
currency price; approval gas is excluded. No provider-supplied approval or raw
transaction is returned for signing. Configuration and quotes explicitly set
`executionAvailable: false` in the quote registry. Execution is separately
advertised by `GET /api/v1/bridges/across/execution`, only when the local-fork
service is configured.

The provider transport uses fixed `https://app.across.to/api/swap/approval`, a
sensitive Bearer header, no redirects or automatic retries, four in-process
permits, a two-second connection timeout, eight-second request timeout and a
256 KiB streamed response cap. Redis admission uses `across-{accountScope}`:
quote and status clients for the same account must share the scope and spacing.
429/5xx cooldown is shared across these clients. Redis failure rejects admission.
No credential, request body, provider error body or arbitrary provider label is
added to telemetry; quote outcomes have bounded labels.

## Supported route and verification

This first path accepts exact-input, direct SpokePool ERC20 deposits with empty
callback messages and no source/destination swaps. CCTP/OFT, periphery, native
value, permit wrappers and embedded actions require separate validation.
The protected operator registry must assign the same explicit `assetId` to
economically equivalent assets and equal decimals. Symbols are display metadata;
they do not prove asset identity. Registry review must verify deployments and
token semantics; examples or observed fork addresses are not production approval.

Independent calldata decoding binds the depositor, recipient, chains, tokens,
input/output, quote timestamp, deadline and exclusivity. Metadata must agree with
those bytes. Fee is checked as input minus output in the reviewed common unit,
with a configured basis-point ceiling. No integrator fee is requested or accepted.
Approval hints are bounded and parsed for exact token/spender/amount shape but
never used as signing authority. A future preparer must observe real allowance
and construct finite approvals itself, including any required reset to zero.

Only the exact Swap API attribution suffix is accepted for this quote path:
`1dc0de` + configured two-byte integrator ID + `73c0de`. Untagged historical
proofs remain supported when their immutable terms omit the tag. Missing,
changed, extra or arbitrary trailing bytes fail verification. Attribution does
not establish fee entitlement or revenue settlement.

Local quote validity is at most 30 seconds and is further bounded by any provider
`quoteExpiryTimestamp`, fill deadline and exclusivity budget. The quote response
preserves the provider expiry separately from Honey's cache expiry. Preparation
requires the cached quote to remain fresh, then performs fresh chain checks and
full sequence simulation. Only after that succeeds does the server set
`preparedAtMs` and derive a signing-plan expiry of at most five minutes, further
bounded by the provider expiry, the user's execution deadline, on-chain
`quoteTimestamp + 300`, `fillDeadline - 30`, and relative or absolute
exclusivity. The 30-second cache expiry is never extended into a provider expiry.
The API response must include a usable ID, estimated gas and successful
estimation flag; that flag is provider metadata, **not Honey simulation
evidence**.

## Configuration

Set `ACROSS_QUOTE_CONFIG_FILE` to a regular mode-0600 JSON file. PostgreSQL, Redis
and authentication are required. Illustrative nonproduction schema:

```json
{
  "apiKey": "replace-through-secret-management",
  "accountScope": "reviewed-account",
  "intervalMs": 1000,
  "sourceChainId": "1",
  "integratorId": "0xabcd",
  "registryRevision": "reviewed-v1",
  "routes": [{
    "id": "reviewed-usdc-base",
    "destinationChainId": "8453",
    "sourceSpoke": "0x1111111111111111111111111111111111111111",
    "inputToken": {"assetId": "usdc", "address": "0x2222222222222222222222222222222222222222", "symbol": "USDC", "decimals": 6},
    "outputToken": {"assetId": "usdc", "address": "0x3333333333333333333333333333333333333333", "symbol": "USDC", "decimals": 6},
    "minimumInputRaw": "1000000",
    "maximumInputRaw": "100000000",
    "maximumBridgeFeeBps": 100,
    "maximumFillSeconds": 3600,
    "maximumExclusivitySeconds": 300
  }]
}
```

The placeholder addresses, integrator ID, bounds and quota above are not approved
commercial settings. No environment file containing credentials belongs in Git.
Route lists are bounded to 32; IDs are unique. The source chain is the auth chain,
with a distinct destination. Fee ceiling cannot exceed 1,000 bps, fill duration
is between one minute and one day, and exclusivity cannot exceed that duration.

## Source provenance and acceptance limits

The [Across API reference](https://docs.across.to/api-reference/swap/approval/get)
documents exact-input requests, Bearer authentication, integrator ID, refund
selection and app-fee parameters. Honey requests owner refunds on the source
chain, zero slippage and strict trade type. It does not request an app fee.

The SDK [response schema](https://github.com/across-protocol/toolkit/blob/2edb9f61335071bc5b1d9778306f815e9354bd3d/packages/sdk/src/api/swap-approval.ts)
and [attribution utility](https://github.com/across-protocol/toolkit/blob/2edb9f61335071bc5b1d9778306f815e9354bd3d/packages/sdk/src/utils/hex.ts)
were inspected at commit `2edb9f61335071bc5b1d9778306f815e9354bd3d`.
Rust validation is independently implemented. The documentation and SDK differ:
maximum-fee summaries use `totalMax` versus `maxTotal`; provider expiry is absent
from that SDK schema, and maximum input can be omitted. Present variants must
agree; omission never relaxes the decoded input amount or local TTL.

Synthetic provider/HTTP tests establish local validation and transport behavior.
Actual-contract tagged-fork evidence separately establishes contract acceptance
of exact attribution bytes. Neither establishes authenticated live Swap API
compatibility: approved credentials, integrator registration, account quota and
actual direct-route responses are still needed. Unsupported responses fail
closed until their shape and economics are reviewed.

## Local-fork execution slice

`ACROSS_EXECUTION_CONFIG_FILE` enables a deliberately isolated 31337→31338
flow. The API process itself must bind only to loopback, authentication must
use chain 31337, both RPC endpoints must be literal loopback endpoints, and the
quote/status transports must be local fixtures with the sentinel credential.
The configuration pins source and destination token/spoke code identities,
decimals, registry revision, RPC budgets and envelope encryption keys. Startup
rejects mismatched route addresses, asset IDs, decimals, chains, listener
exposure, or a second bridge-status transport.

The selected quote is retained for at most 30 seconds in wallet-scoped Redis;
operation creation restores and revalidates that exact provider response before
persisting immutable intent, local quote expiry, and optional provider expiry.
The worker performs fresh
contract/proxy/token checks, nonce/balance/allowance reads, finite approval
construction and full-sequence simulation. A signing request is bound to the
owner, operation version, intent hash and simulation plan. Submission accepts
only locally verified signed envelopes and journals each dispatch before raw
transaction relay. Retries are idempotent, including after quote-cache expiry.
After preparation, dispatch re-simulates from latest chain state without relying
on the expired quote cache and refuses to send if the persisted plan expiry,
provider expiry, user deadline, contract deadlines, nonce, or exact call no longer
agree. Preparation expiry is computed from the server's completed simulation,
not from client-supplied timestamps.

Finalized source deposit means `bridging`, never `succeeded`. Completion requires
source deposit proof plus destination recipient/token/amount proof, canonical
block anchors on both chains, and an immutable hashed settlement committed with
the operation transition and outbox update. Recovery returns
`verifiedDelivery: null` until this proof exists. The status poller is advisory;
its candidate transaction is independently checked against destination receipts
and logs. A status API claim or stale worker lease cannot finalize the operation.

This isolated mode does not use live Across credentials or route advertisements.
It cannot run on a public listener or public chain, and does not imply that an
operator route is commercially authorized. Refund verification is not
implemented; non-fill/refund candidates remain pending. The short quote/signing
window can require a fresh quote if wallet review is slow. Multi-transaction
approval flows share that bounded plan expiry; pre-existing allowance is the
smoother path. Live expansion requires refund verification, durable quote
semantics, explicit allowance UX, provider acceptance tests, capacity tests and
independent security review.

Redis carries short-lived quote cache and admission state; PostgreSQL remains
the source of truth for intents, signatures, dispatch, reconciliation, watches
and delivery proof. This supports worker restart and owner recovery, at the cost
of extra writes and settlement proof versioning. Across remains a distinct
adapter rather than inheriting Relay status semantics, so a provider response
cannot be mistaken for a deposit or fill. The first mode is single-route and
local-only to keep the trust boundary testable; it limits coverage while route,
credential, quota and settlement policy remain under review. See
[ACROSS-EVIDENCE.md](ACROSS-EVIDENCE.md) and
[BRIDGE-RECOVERY.md](BRIDGE-RECOVERY.md).

## Local verification record

- Six provider tests cover valid quotes, economic/identity mutations, deadlines,
  fee aliases and approval hints, plus real loopback HTTP and shared Redis quota.
- Two HTTP admission tests cover authentication, chain/schema validation, quota,
  credential omission and absent execution endpoints using disposable PostgreSQL.
- Six evidence tests cover canonical calldata, exact attribution and RPC proof
  rejection; four durable-monitor regressions cover owner/intent/source binding.
- Four shared-client tests and three web component tests cover contract binding,
  cancellation, session changes, expiry and displayed economics. Native and
  extension integration has typecheck coverage; physical-device UX is unverified.
- The tagged local-fork evidence records actual contract execution and cleanup.

CI includes the new opt-in provider and HTTP tests with its disposable services.
The shared test-database helper now force-drops only its own randomly generated
database after closing its pool; this avoids a PostgreSQL connection-shutdown
race. No configured application database is migrated or dropped by this helper.

Final workspace gates passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
The test run requires local-listener permission for existing RPC fixtures; the
new database/Redis integration tests were also run explicitly above.
