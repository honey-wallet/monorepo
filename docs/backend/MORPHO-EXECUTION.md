# Morpho Vault V2 execution and shared Earn processing

2026-10-18. Local-fork integration; production activation remains disabled. This
document distinguishes contract behavior, Honey decisions and test evidence.
The fixture vault is not an approved product recommendation. Existing public Earn
catalog data does not enable execution or represent a user's savings balance.

## Verified contract behavior

Primary sources, reviewed at immutable revisions:

- [VaultBundlesV1](https://github.com/morpho-org/bundles/blob/860ceacde7e6729a4956f78b31dbe75e4ce99cb6/src/vault/VaultBundlesV1.sol)
  and [TokenLib](https://github.com/morpho-org/bundles/blob/860ceacde7e6729a4956f78b31dbe75e4ce99cb6/src/libraries/TokenLib.sol).
- [VaultV2](https://github.com/morpho-org/vault-v2/blob/f4fc64ed11cda9e6722fbedf6f55b89606eacd1e/src/VaultV2.sol).
- Current provider documentation: [bundles](https://docs.morpho.org/developers/contracts/bundles/),
  [asset flow](https://docs.morpho.org/developers/earn/tutorials/assets-flow/),
  [addresses](https://docs.morpho.org/developers/contracts/addresses/).

Vault V2's `maxDeposit`, `maxMint`, `maxWithdraw` and `maxRedeem` return zero.
Preview/conversion methods describe share economics; they do not prove liquidity
or admission. VaultBundlesV1 deposit checks a maximum realized assets-per-share
price scaled by 1e27. The withdrawal function supports either an asset amount or
a share amount, not both. It checks a deadline but provides no output-price floor.
Its referral percentage uses WAD units. Those referral fees are distinct from
vault management and performance fees already affecting share value.

The observed Ethereum fixture uses USDC
`0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`, vault
`0x04422053addbc9bb2759b248b574e3fca76bc145` and bundle
`0x02912516d49de997db75b9d7858faae59209650b`, at source block 26218343.
The service accepts only loopback HTTP and chain 31337. No transaction from the
acceptance scripts goes to Ethereum mainnet.

## Decisions and tradeoffs

**Shared durable engine, separate economic adapters.** `earn_service.rs` owns
immutable requests, signing-term persistence, encrypted submissions, nonce guards,
worker leases, dispatch and reconciliation. Aave and Morpho implement `EarnAdapter`.
Jobs are claimed by their immutable service discriminator; signing/intent endpoints
check the expected provider. This avoids diverging money-movement state machines.
The cost is a larger regression surface: both providers must be tested after a
shared-engine change. A provider-independent arbitrary-calldata endpoint is not
exposed. Existing Aave canonical intent bytes and response contracts are preserved.

**Deposit protection is a contract constraint.** For exact assets A and minimum
shares M, set `maxSharePriceE27 = floor(A * 1e27 / M)`. Reject multiplication overflow,
zero and uint256 maxima. The contract checks `ceil(A * 1e27 / mintedShares)` against
that bound, which conservatively ensures mintedShares >= M. Simulation independently
checks the exact asset debit and minimum share credit. The rounding can be stricter
than a nominal minimum; rejecting is preferable to silently weakening the limit.
Native review currently chooses M at 0.1% below a fresh preview and displays it.

**Redemption spends exact shares with acknowledged output risk.** The request must
set `minimumSharesRaw: null` and `acknowledgeUnprotectedOutput: true`. The plan must
have `minimumReceive: null`. Simulation requires the exact share debit and positive
asset credit, but a later transaction may receive a different amount. A displayed
preview is not a guaranteed payout. Fixed-asset withdrawal and forced/in-kind
withdrawal are not implemented. They need separate maximum-share/loss semantics;
they cannot be added by relabeling the current action.

**Finite approvals, no permit authority, zero app referral fee.** Use an existing
sufficient allowance, or reset a nonzero insufficient allowance to zero and approve
the exact spend. The user approves the bundle on USDC for deposit or vault shares
for redemption. Permit structures and referral amounts/recipients are exactly zero.
The bundle may internally approve the vault from its own balance; this is distinct
from the user's allowance. Approval transactions can settle while a subsequent
action fails or expires. Residual approvals need an explicit later revocation flow;
the system does not claim transaction-bundle atomicity.

**Curated configuration, verified again before sending.** Pin runtime code for vault,
bundle, asset, asset implementation and each ordered adapter (maximum eight). Check
asset identity/decimals, share decimals, owner/curator, adapter registry, liquidity
adapter, canonical ABI liquidity-data hash, fee amounts and fee recipients. Reject
nonzero permission gates in this initial scope. Verify the source block remains
canonical and simulate sequential calls with before/after balances. Repeat provider
preflight before each remaining signed step. This catches selected configuration
drift, not all market risk, implementation changes behind nested adapter proxies,
or future governance behavior. Production requires a reviewed registry and monitoring
policy covering that wider dependency graph.

**Fresh read-only quotes.** Authenticated POST quotes bind the session signer,
vault/asset, action, exact amount, policy revisions and source block. They expire
after 30 seconds and use a 15-second RPC deadline. A quote checks core identity/fees
and previews balances; it is not full execution admission. The worker independently
checks the full configuration and simulates. Separate quote evidence avoids
pretending an indexed APY or stale preview authorizes an action. It costs RPC calls;
account-wide Redis admission and per-wallet request quotas bound demand.

**Independent signing review.** The shared client reconstructs all ABI words,
including dynamic permit offsets, zero referral fields and deadline. It checks
operation/version/hash, target registry, signer, spend/output, approvals, gas and
aggregate fee. Native code validates before and after owner confirmation, copies
public JSON inputs before awaiting, fences account/session/lifecycle changes, wipes
the mutable key before HTTP submission and drops signed-string references afterward.
JavaScript cannot promise zeroization of immutable strings. Network ambiguity is
resolved through operation recovery, not automatic resubmission.

## HTTP contracts

All paths are below `/api/v1`. Configuration is public; every other route requires
a wallet bearer session. Scope is the authenticated wallet, never a supplied user ID.

| Method/path | Meaning |
|---|---|
| GET `/earn/morpho/execution` | Enabled local fixture and disclosed vault fees |
| POST `/earn/morpho/quote` | `{action, amountRaw}` preview and balances |
| POST `/earn/morpho/operations` | Idempotent immutable request; requires `Idempotency-Key` |
| GET `/operations/{id}/morpho-intent` | Owner-scoped unsigned intent for fresh review |
| GET `/operations/{id}/morpho-signing-request` | Exact persisted unsigned signing terms |
| POST `/operations/{id}/morpho-signed` | Validate/stage signed bundle |
| GET `/operations` and `/operations/{id}` | Shared history and receipt recovery |

Create body: `vault`, `action` (`deposit` or `redeem`), `amountRaw`,
`minimumSharesRaw`, `acknowledgeUnprotectedOutput`, `deadline`,
`maximumNetworkFeeRaw`. Raw amounts **and deadline seconds are canonical decimal
strings**; unknown fields and numeric deadlines are rejected. New deadlines must
be within 15 minutes; native sizing chooses 10 minutes. The signing plan expires after
at most 2 minutes or the action deadline, whichever is earlier. Immutable intents
remain readable after expiry; a new operation requires a new quote/review.

Read quota: 60/wallet/minute and 600/global/minute. Create, quote and signed submission
share 10/wallet/minute and 60/global/minute. POST quotes consume mutation admission
to bound expensive simulations/reads, but cannot submit anything. Quota scopes are
provider-specific; RPC account admission is shared across providers using the same
account. Errors expose stable API codes/request IDs, not keys or signed bytes.

## Configuration and migration

Set `MORPHO_EXECUTION_CONFIG_FILE` to a regular 0600 JSON file of at most 64 KiB:

```json
{
  "mode": "local_fork",
  "rpcUrl": "http://127.0.0.1:28545",
  "rpcBudget": {"scope": "local-earn", "intervalMs": 10, "simulationCost": 10},
  "registry": "REPLACE_WITH_REVIEWED_MorphoExecutionPolicy_OBJECT",
  "activeKeyId": "REPLACE_WITH_KEY_ID",
  "dataKeys": {"REPLACE_WITH_KEY_ID": "REPLACE_WITH_32_BYTE_HEX_KEY"}
}
```

The above is a schema illustration, not runnable credentials. `registry` is the
object defined in `providers/morpho_execution.rs`; the redacted acceptance evidence
contains a complete **test-only** observed registry. Require DATABASE_URL, REDIS_URL,
loopback HOST and AUTH_CHAIN_ID=31337. No startup migrations or key generation occur.
Key rotation/recovery constraints from [AAVE-API.md](AAVE-API.md) apply unchanged.

Migration 202610180007 renames `aave_signing_requests` to `evm_signing_requests`,
its immutability trigger and the service expression index. It does not rewrite
canonical payloads or hashes. **Drain old API/worker binaries before migration; old
binaries cannot query the renamed table.** Back up and validate restore, explicitly
apply migrations, then start the new binaries. No production migration has been
performed. Rollback needs a reviewed reverse rename while processes are stopped;
do not delete persisted signed requests or ignore unknown transaction outcomes.

## Verification and remaining evidence

Captured [adapter evidence](evidence/morpho-adapter-local-fork-2026-10-18.json)
and [HTTP/worker evidence](evidence/morpho-http-local-fork-2026-10-18.json) both
completed successfully. The HTTP case deposited 1,000,000 raw USDC, minted
941,825,668,054,109,067 shares, then redeemed exactly those shares for 1,000,000 raw
USDC. Each action used two transactions; both reached the local finalized state.
The two providers were enabled together; Aave signing/intent endpoints refused the
Morpho operation. Disabled-execution history remained readable after restart.
Neither file contains bearer tokens, private keys or signed raw transactions.
The [Aave shared-engine regression](evidence/aave-shared-earn-local-fork-2026-10-18.json)
also passed supply/withdraw, staging/restart and disabled-execution recovery. A
populated-table migration regression reapplies migration 7 from the previous
metadata names and checks unchanged canonical JSON/hash plus update/delete rejection.

`pnpm lint`, `pnpm typecheck` and `pnpm test` passed. Tests requiring loopback sockets
were run with that access after sandbox listener denial. The separate disposable
Postgres/Redis suite covered 37 persistence, isolation, lease, RPC-budget and
reconciliation checks. These counts are regression evidence, not a throughput claim.

Adapter tests cover successful finite-approval deposit/redeem plus code/implementation,
gates, adapters/liquidity, fees, balances, nonce, chain, simulation, exact debit/credit,
gas bounds, reorg and deadline faults. Client tests independently mutate every action
ABI word, including fee/permit fields; native tests cover owner cancellation, session
changes, partial-signature discard, key wiping, consent and copied review inputs.

Reproduction uses an Anvil fork at 26218343 on 127.0.0.1:28545 chain 31337, disposable
Postgres 25432 and Redis 26379. Build `honey-server`, `aave_fork_prepare` (the existing
disposable-database helper) and `morpho_fork_prepare`; run:

```sh
node --import ./packages/keyring/scripts/local-ts-loader.mjs ./packages/keyring/scripts/morpho-fork-smoke.mjs
node --import ./packages/keyring/scripts/local-ts-loader.mjs ./packages/keyring/scripts/morpho-http-fork-smoke.mjs
```

The HTTP script enables both providers and exercises SIWE, quotes, idempotency,
provider isolation, prepare/sign/restart, encrypted staging/restart, receipt finality,
balance deltas and history with execution disabled. It uses a public fixture scalar,
funds only the local chain, creates/drops its own database and reverts its snapshot.
Anvil finality is simulated by mining the observed bounded lag; it is not Ethereum
consensus evidence. Failed runs must finish cleanup before another run begins.

Pending launch evidence: production registry/risk approval, nested adapter upgrade
coverage, actual selected RPC quotas and support for sequential simulation, operational
key custody/rotation, real-device UX, web/extension execution UX, positions and accrued
yield, cancellation/replacement and residual-approval recovery, provider outage/reorg
drills, mixed 10k/N-1 capacity. This milestone does not close those requirements.
