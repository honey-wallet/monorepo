# Aave preparation and independently verified wallet signatures

Status: **internal adapter and disposable-fork proof**, not a user-accessible
transaction service. No public mutation, worker dispatch, mainnet broadcaster or
wallet deposit/withdraw button is enabled by this change. Read this with
[PREPARATION-AND-RECOVERY.md](PREPARATION-AND-RECOVERY.md). Research/test date: 2026-10-18.

## Implemented path

`providers/aave_execution.rs` prepares finite ERC20 supply/self-withdrawal for an
ordinary EOA. The production-chain branch permits Ethereum chain 1. A special
31337 branch requires loopback RPC for fork tests. This is not a general multichain
or arbitrary-token approval. The caller supplies a reviewed registry containing
Pool, underlying, aToken, decimals, code hashes and aToken rounding tolerance; those values never come from
the public catalog. There is no server configuration activating this adapter yet.

1. Pin source block number/hash; reject stale/future production timestamps. Reject
   unsupported chain, amount, gas policy and EOA code (including EIP-7702 delegation).
2. Compare contract hashes and cross-check Pool reserve aToken, underlying, owning
   Pool and decimals/configuration. Active/unpaused required; frozen blocks supply
   while allowing exits. Check actual asset and native balances.
3. Compare source nonce with pending nonce. Any pending activity requires refresh.
   This detects existing pending activity, but does not reserve a nonce across workers.
4. Read allowance; skip adequate approval, reset nonzero insufficient allowance,
   approve the exact amount. No unlimited approval, Permit2 or permit signing.
5. Build ordered calls with referral 0 and no app fee. Simulate all calls sequentially
   using `eth_simulateV1`; require source parent hash, matching call count, success,
   valid approval return and exact finite withdrawal result. For withdrawal, simulate aToken balance reads before/after
   the action and require the decrease within the requested amount plus the explicit
   raw-unit rounding tolerance (two units in the test policy). Recheck source hash.
6. Estimate each gas limit as simulated gas × 1.2 + 10,000, subject to a configured
   ceiling. Maximum fee per gas is 2 × source base fee + RPC priority suggestion.
   U256 arithmetic sums the bundle ceiling and rejects a budget overrun. Expire in
   two minutes. These are proposed fee/gas policies, not inclusion guarantees.

Supply records **no guaranteed aToken minimum**: scaled accounting rounds and
Pool.supply does not accept a min-output argument. The fork produced 999,999 raw
aUSDC for 1,000,000 raw USDC. A display must distinguish deposit principal, receipt
balance and accrued interest. Exact finite withdrawal returns the requested underlying
amount; the prepared aToken spend ceiling includes the explicit rounding tolerance
and must be resimulated before sending because the Pool has no max-burn parameter; “withdraw all” is not implemented, and small residual balances are expected.

`providers/evm_rpc.rs` is a read/simulation-only transport: fixed configured endpoint,
HTTPS except loopback, no redirects, four shared in-flight permits, two-second
admission/connect limits, 12-second request timeout and 256 KiB response cap. The
preparer has a 60-second overall deadline. RPC error bodies and URLs are not logged.
No client-supplied URL or raw RPC method is accepted. A single shared instance must
be used per endpoint; creating one per request would defeat admission control.

## Independent verification of the wallet's signed bytes

`evm_envelope.rs` accepts a validated immutable plan, trusted fresh nonce/gas policy
and the complete ordered bundle. It supports only EIP-1559 type 2. It requires exact
canonical EIP-2718 encoding, canonical low-S signature recovery, matching chain,
signer, recipient, value, calldata and sequential nonce. Contract creation, access
lists, other transaction types, trailing bytes and unsigned payloads fail closed.

Gas checks include baseline intrinsic cost, configured per-transaction ceiling,
priority ≤ max fee and the aggregate gas × max-fee budget using U256. Transaction
identifiers are Ethereum Keccak hashes of the exact bytes; the internal preparation
identifier remains canonical-JSON SHA-256. The verified wrapper has private fields
and deliberately lacks Debug/Serialize. Broadcastable signed bytes have an explicit
sensitive accessor; never place them in logs, telemetry, ordinary API responses or
unencrypted job payloads.

This pure validator does not prove chain freshness, correct provider semantics,
current balance, current base fee, fork-specific gas floors, account eligibility,
nonce ownership or ongoing user authorization. It does not broadcast. The concrete
preparer and durable submission service must establish those facts separately.

Alloy's checked `SignerRecoverable` trait implementation is called explicitly.
The similarly named inherent method on `Signed<T>` does not enforce low-S in the
selected version; the high-S cross-language regression prevents accidental substitution.

## Actual local-fork evidence

[Captured receipt/balance evidence](evidence/aave-local-fork-2026-10-18.json): Anvil
1.8.0, Ethereum source block **26,218,343**, local chain **31337**, loopback port
28545. Public upstream was used only for reads. The test:

- Checks Anvil identity and local chain before any mutation; snapshots and reverts.
- Uses public test scalar 1 and fork-only gas/token funding. Its inherited delegated
  code is explicitly cleared locally to test an ordinary EOA. Production code still
  rejects delegated accounts. No private wallet files or environment keys are loaded.
- Invokes the Rust preparer. Independently compares calldata with viem ABI encoding.
- Signs through the wallet's actual `signEvmTransaction` implementation and invokes
  Rust's independent signed-byte validator before each local bundle is sent.
- Mines approval and supply of 1 USDC, followed by withdrawal of 0.9 USDC; verifies
  matching transaction hashes, successful receipts, underlying balances, remaining
  receipt balance and consumed exact allowance. All three receipts succeeded.

Measured gas: approval **55,558**, supply **201,989**, withdrawal **166,198**.
Starting from 10 USDC and no aUSDC, the final fixture had 9.9 USDC and 99,998 raw
aUSDC. This proves contract interaction on that historical local state; it does not
prove current mainnet eligibility, production finality or the frontend transaction UX.
That initial evidence bypassed persistence. The harness now includes real operation
intent/preparation, encrypted signatures and receipt settlement in a disposable database;
see [RECEIPT-RECONCILIATION.md](RECEIPT-RECONCILIATION.md) for the newer captured evidence.
It is still not an HTTP-to-frontend end-to-end test.

Reproduce (requires Foundry, historical RPC reads and installed workspace dependencies):

```sh
anvil --fork-url https://eth.drpc.org \
  --fork-block-number 26218343 --chain-id 31337 \
  --host 127.0.0.1 --port 28545 --accounts 0 --no-storage-caching --silent
# In a second terminal, repository root:
cargo build --locked --example aave_fork_prepare
node --experimental-strip-types packages/keyring/scripts/aave-fork-smoke.mjs
```

Never substitute a production URL in the smoke. The Rust bridge and JS driver both
hardcode loopback. Registry hashes are observed dynamically **only by this test
example**; that is deliberately not an approval mechanism for a launch registry.
The initial publicnode run passed; a later restart failed because that provider
no longer served the pinned state. The final run used eth.drpc.org at the same
block. Historical availability is external and may require an archive RPC.
Snapshot restoration is attempted even on failure; terminate the disposable Anvil
process afterward. The captured hashes refer to local transactions, not mainnet explorers.

## Tests and dependency costs

- Four Aave preparation/transport tests exercise ordered approval/reset/skip,
  finite withdrawal, exact fee aggregation, frozen versus paused behavior, chain,
  code, identity, balance, pending nonce, simulation failure, rounding-bound rejection, source timestamp freshness/overflow,
  fee budget and reorg.
- Four signed-envelope tests use deterministic fixtures generated by the actual
  Honey keyring / viem 2.57.2. They cover signer/call/chain/nonce substitution,
  malformed/noncanonical encoding, high-S signatures, aggregate fees, expiry,
  large exact amounts, all proper truncations and complete ordered step coverage.
- Regenerate offline vectors with
  `node --experimental-strip-types packages/keyring/scripts/generate-evm-envelope-fixtures.mjs`.

Alloy consensus/eips are pinned to 2.1.1 and primitives to 1.7.3. Features enable
only std and k256 signature recovery, not RPC/signer/KZG functionality. The lockfile
also records optional packages. Declared MSRV moves from 1.88 to **1.91** to match
dependency metadata; the installed/CI toolchain remains **1.93**. Validation was on
1.93, not a separate 1.91 compilation. RustSec audit on this lockfile: **0 vulnerable
packages; 2 unmaintained-package warnings** (derivative 2.2.0, paste 1.0.15).
`derivative` is lockfile-only in the selected graph; `paste` is active through
alloy-primitives. No ignore rule was added. Updating compatible dependencies and
reviewing advisories remain release maintenance, not an assertion of zero risk.

## Remaining work before a user can execute Aave

1. Approve a launch registry and fee policy. Pin/check proxy implementations and
   upgrade authority; proxy runtime hashes alone do not detect implementation changes.
2. Connect authenticated typed intent creation, semantic validation, queue preparation,
   persisted plan and explicit fee/call review in web/native/extension. Request fields
   cannot supply registry revisions or override signer/ownership checks.
3. Durable encrypted bundle storage, nonce coordination and initial dispatch journaling
   now exist ([SIGNED-SUBMISSIONS.md](SIGNED-SUBMISSIONS.md)); complete orchestration and
   reconciliation before exposing submit. Persist exact signed bytes/hash before dispatch; ambiguous
   RPC outcomes recover by hash. Never blindly retry a newly signed transaction.
4. Send approvals sequentially, wait for successful canonical receipts, revalidate
   action state before sending it. Approval success plus failed action leaves an
   allowance; expose that partial outcome and a separate reviewed revoke workflow.
5. Handle dropped/replaced/reverted transactions, reorgs, confirmation/finality rules,
   cancellation, fee replacement, stale plans and account changes. Preserve evidence
   and never infer success from a timer or a successful RPC submission response.
6. Configure shared RPC quotas/cooldowns, operator metrics, implementation monitoring,
   audit retention and withdrawal-specific kill switches. Test outage/restart/failover.
7. Add real positions and physical-device acceptance. Then include this workload in
   the reproducible 10k mixed-user test. The previous 10k socket test is insufficient.

## Primary references

- [Aave Pool contract API](https://aave.com/docs/aave-v3/smart-contracts/pool)
- [Aave deployed addresses](https://aave.com/docs/resources/addresses)
- [Aave reserve configuration implementation](https://github.com/aave/aave-v3-origin/blob/main/src/contracts/protocol/libraries/configuration/ReserveConfiguration.sol)
- [Aave scaled token accounting](https://github.com/aave/aave-v3-origin/blob/main/src/contracts/protocol/tokenization/base/ScaledBalanceTokenBase.sol)
- [Geth sequential simulation API](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth)
- [EIP-1559 transaction format and fees](https://eips.ethereum.org/EIPS/eip-1559)
- [EIP-2 canonical signatures](https://eips.ethereum.org/EIPS/eip-2)
- [EIP-2681 nonce bounds](https://eips.ethereum.org/EIPS/eip-2681)
- [Alloy transaction encoding](https://alloy.rs/transactions/encoding-and-decoding/)

Verification after the final rounding correction: `pnpm lint && pnpm typecheck && pnpm test` passed; four Aave and four envelope regression tests passed; the final local-fork run passed. Real-service PostgreSQL/Redis tests were previously verified and were not rerun for this CPU/RPC-only change.
