# Uniswap quote boundary and execution handoff

Status, 2026-10-18: server quote transport, validation, typed client and web/native
quote forms are implemented. **Swap execution is not implemented.** No authenticated
Trading API acceptance has run: an API key has not been supplied. Fixtures below
test our interpretation of the official schema, not provider compatibility.
Internal artifact retention and independently verified construction now exist in
[UNISWAP-BUILDS.md](UNISWAP-BUILDS.md); public quote responses remain unchanged.

## Evidence and contract

Research uses the official [quote reference](https://developers.uniswap.org/docs/api-reference/aggregator_quote),
[swap reference](https://developers.uniswap.org/docs/api-reference/swap),
[approval reference](https://developers.uniswap.org/docs/api-reference/check_approval),
[FAQ](https://developers.uniswap.org/docs/trading/swapping-api/faqs), and
[OpenAPI specification](https://trade-api.gateway.uniswap.org/v1/api.json).
The downloaded specification SHA-256 was
`2f46a6cb498f27461c219dd898f513e77d725ad10546435fb3b5e1ff4fdc2e2e`.
[Selected schema evidence](evidence/uniswap-openapi-selected-2026-10-18.json)
is an excerpt, not a standalone schema or an authenticated response. Internal
fields in that document are not an integration contract.

`GET /api/v1/swaps/configuration` returns public chain, router/Permit2 addresses,
router version, token registry, fee recipients/rates and policy revisions. It
returns 422 when unconfigured. Credentials and account quota scope are private.
`POST /api/v1/swaps/quote` requires an existing SIWE session on the configured
chain. The signer and recipient come from the authenticated wallet. Its body is:

```json
{
  "tokenIn": "<registered lower-case ERC20 address>",
  "tokenOut": "<different registered ERC20 address>",
  "amountRaw": "1000000",
  "slippageBps": 50
}
```

Amounts are canonical decimal strings. Slippage is an integer from 0 through
1000 bps; this is a supported bound, not a recommendation. Exact input must be
positive and strictly below `uint160::MAX`: Permit2 reserves that maximum for
unlimited allowance. Unknown fields, caller-supplied signer and arbitrary URLs
are rejected. No key or signature is accepted by these endpoints.

The provider request selects same-chain EXACT_INPUT CLASSIC V2/V3/V4 with no V4
hooks, exact Permit2 amount and explicit wallet recipient. Router version is pinned
to `2.1.2`. Native currency, cross-chain routes, exact output, UniswapX, arbitrary
tokens, transfer-tax tokens and hooked pools are outside this implementation.
Every intermediate token must also be registered. Routes are bounded to eight
splits and eight hops per split. Token continuity, amounts, chain, decimals and
reported simulation failures are checked. V4 pool IDs accept 32 bytes: the
[official routing implementation](https://github.com/Uniswap/routing-api/blob/main/lib/handlers/quote/quote.ts)
uses these despite the downloaded Trading schema reusing a 20-byte address type.

The normalized response reports gross output, net wallet output, minimum wallet
output, each integrator fee, swap gas estimate, source block, signer, inputs and
policy revisions. Quotes expire 30 seconds after receipt. Source block is provider
metadata; no independent RPC freshness/finality check occurs in this read path.
`executionAvailable` is always false; no raw calldata or permit typed data is
returned. `approvalGasIncluded` is false, so swap gas is not total transaction cost.

## Economics and signing boundary

The configured fee policy permits up to four unique recipients and a total of
500 whole bps. Fractional bps supported by the provider are deliberately unsupported
here. Zero fees use an empty list. Unexpected API-key partner fees fail validation;
operators must reconcile their actual commercial configuration before acceptance.
For each leg, expected fee is `floor(grossOutput * bps / 10000)`; net plus fees must
equal gross. This rounding interpretation still needs authenticated fixtures.

Minimum receive must be at least `floor(netOutput * (10000 - slippageBps) / 10000)`
and no greater than net. A stricter provider minimum is accepted. No floating-point
token arithmetic is used. Pool fees are already reflected in route output and are
not added a second time. Provider gas estimates are not final paid fees.

If present, PermitSingle data is structurally checked against configured chain,
Permit2, spender, input token and exact amount. Only the expected field/type sets
are accepted. Expiration is bounded to 30 days and signature deadline to 30 minutes
with 60 seconds tolerance. These are our review bounds, not guaranteed provider
defaults. See [Permit2 allowance transfer](https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer)
and [interface](https://github.com/Uniswap/permit2/blob/main/src/interfaces/IAllowanceTransfer.sol).
This check does not verify on-chain allowance/nonce or authorize a signature.
The user never signs through the current quote form.

## Admission, secrets and failures

`UNISWAP_QUOTE_CONFIG_FILE` names an operator-owned regular mode-0600 JSON file,
maximum 64 KiB. DATABASE_URL, REDIS_URL and matching AUTH_CHAIN_ID are required.
File fields (all mandatory, no unknown fields):

| Field | Meaning |
| --- | --- |
| `apiKey` | Secret Trading API credential; never committed or sent to clients |
| `accountScope` | Shared identifier for replicas using that provider account |
| `intervalMs` | 167–60000 ms between shared admissions; choose from actual entitlement |
| `chainId` | Numeric supported chain ID, matching auth |
| `router`, `permit2` | Explicit reviewed nonzero contract addresses |
| `tokens` | 2–64 `{address, symbol, decimals}` records; decimals 0–36 |
| `integratorFees` | Zero to four `{recipient, bps}` records |
| `registryRevision`, `feePolicyRevision` | Immutable operator revision labels |

This configuration records quote validation policy; it is not an on-chain code
pin or execution registry approval. Authenticated quote admission is capped at
10/minute/wallet and 240/minute globally using database time. Redis coordinates
provider admission and cooldown across replicas; every replica sharing a key must
use the same Redis namespace, account scope and quota configuration. The documented
default provider allowance is 6 requests/second. The 167 ms minimum interval and
240/minute API cap are deliberately conservative and cannot serve an unrestricted
10k-user quote workload. Higher negotiated quota and a measured workload are needed.

Each process has four in-flight slots, immediate rejection when full, 2-second
connect/Redis bounds, 8-second HTTP deadline and a 256 KiB streamed response limit.
The HTTPS origin is fixed. Redirects and automatic retries are disabled. API keys
use sensitive headers and upstream bodies/URLs are excluded from errors/traces.
429/5xx responses establish shared Retry-After cooldown; 401/403 establish a hold
requiring operator resolution. Transport failures establish a 10-second hold.
Redis failure rejects requests without falling back to uncoordinated local quota.
Existing RPC-budget operational guidance applies to clearing account holds after
the underlying entitlement/credential issue is resolved.

Quotes are personalized, short-lived reads and are not cached or queued. Retrying
a failed request is an explicit user action. Metrics use finite provider/operation/
outcome labels; tracing skips arguments, keeping wallet/token/key data out of labels.

## Frontend integration

Signed-in web and non-demo native Trade use the typed quote client. Fixed-point
amount parsing is shared with Earn. Both validate wallet/chain/input/policy/fee
identity and freshness before display. Requests are aborted and stale results
discarded on lifecycle/session changes. Quotes clear on expiry and input changes.
Native demo balances, mock swap review, token picker and swap settings are not
connected to this live form; the live form has its own registered pair/slippage
controls. Watch/shared wallets cannot use this initial native flow. There is no
swap/sign/approve button until the execution boundary exists. Physical-device UX
and an authenticated provider response remain unverified.

## Verification and remaining delivery

Rust normalization tests mutate identity, economics, route and Permit2 authority.
The opt-in local mock/Redis test verifies header-only credentials, shared admission,
429 cooldown, redirect rejection and oversized responses. The opt-in PostgreSQL
HTTP test verifies public config redaction, auth, schema, wallet chain and per-wallet
limits without an upstream call. Client tests cover fees, freshness, exact amount
limits and non-retry behavior; web tests cover display and stale-session fencing.
These are synthetic/local tests, not an upstream acceptance or capacity result.

Router decoding, Permit2 proof and ordered economic verification are implemented as
pure building blocks; see [UNISWAP-ECONOMICS.md](UNISWAP-ECONOMICS.md) and
[UNISWAP-AUTHORITY.md](UNISWAP-AUTHORITY.md) for precise scope and remaining semantic
checks. Execution still requires these additional steps before activation:

1. Capture authorized Trading API responses for no-fee/fee and allowance/permit
   cases; reconcile schema/rounding and contracted quotas. Record sanitized evidence.
2. Add durable swap intents and quote/build provenance, fixed deadlines and fee
   policy binding, including prepared transaction and Permit2 typed-data hashes.
3. Independently decode/reconstruct every allowed Universal Router command and
   argument on server and client. Verify destinations, recipients, amounts, fee
   legs, callbacks, refunds and absence of arbitrary commands. Provider calldata
   alone is insufficient authority.
4. Verify allowance/Permit2 nonce, exact typed signature, contract identity, balances
   and source block; simulate the ordered approval/permit/swap sequence. Define
   signature exposure/storage lifetime and crash/requote semantics explicitly.
5. Generalize the durable Earn pipeline by action/provider, preserving nonce
   coordination, ambiguous-send recovery and finality. Add swap-specific native
   review/sign/status/history with session fencing and no blind resubmission.
6. Prove actual-contract local-fork execution, fee transfers, allowance reset,
   permit replay rejection, expiration, partial approval, revert, reorg and restart
   recovery. Production activation needs reviewed registry, quota and fee policy.

NEAR Intents bridging, Hyperliquid/Polymarket execution, persistent device sessions
and full mixed-workload capacity remain separate unfinished roadmap work.

Router compatibility correction: the pinned 2.1.2 configuration excludes zkSync
(chain 324), which the official supported-chain reference lists as 2.0-only.
Deployment registry approval is separate from the supported-chain list.
