# Uniswap actual-contract acceptance

Status, 2026-10-18: the independent server/wallet authority checks now have
actual-contract local-fork acceptance for seven routes. This is a contract-level
test harness, not the unfinished provider HTTP, durable signing or app execution
flow. Production swap execution remains disabled.

Evidence: [captured local results](evidence/uniswap-contract-local-fork-2026-10-18.json).
Reproduction lives in `packages/keyring/scripts/uniswap-fork-smoke.mjs`, with the
pure Rust bridge `apps/server/examples/uniswap_fork_verify.rs`. No dependencies or
database migrations were added.

## Deployment and input provenance

The fork starts at Ethereum block **26218343** and runs with chain ID **31337**.
The driver rejects a different starting block, non-Anvil client or different chain.
Every RPC request uses literal `http://127.0.0.1:28545`, with redirects forbidden;
the driver accepts no endpoint or private-key configuration. It signs only with
public fixture scalar 1. The local fixture clears that address's delegated code,
funds local gas, and impersonates the Aave aUSDC contract to transfer fixture USDC.
Those changes happen inside a snapshot reverted in `finally`. Each scenario also
has an independent snapshot, so earlier swaps do not alter later quotes or nonces.

Version-specific deployment references are:

- [Trading API supported chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains)
  and [V4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments):
  mainnet router **2.1.2**, `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85`.
- [V3 deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments):
  QuoterV2, Permit2 and WETH addresses.
- [V2 deployments](https://developers.uniswap.org/docs/protocols/v2/deployments):
  Router02, used only for its read-only `getAmountsOut` quote.
- [Pinned V4 quoter interface](https://github.com/Uniswap/v4-periphery/blob/545a5d2a87228167edde48f3b9eda122d1e3c4d6/src/interfaces/IV4Quoter.sol):
  no-hooks USDC/WETH pool quote. V3 uses fee 3000; V4 uses fee 500/tick spacing 10.

The artifact records observed bytecode hashes, the fork block hash, calldata hashes
and local transaction hashes. Observed hashes are test provenance, **not approved
production code pins**. This test does not reproduce the compiler build or inspect
every immutable and proxy implementation. Pool quotes are obtained with `eth_call`;
none comes from the authenticated Trading API. Calldata is independently encoded
with existing viem 2.57.2 against the pinned router ABI.

## Covered behavior

| Scenario | Contract behavior checked |
| --- | --- |
| V2 direct | Finite PermitSingle, exact input, owner output floor |
| V3 direct | Six-field router command, owner output floor |
| V4 direct | Nested exact input, bounded `SETTLE_ALL`, minimum `TAKE_ALL` |
| V3 two fees | Router custody, bps fee, adjusted full-precision second fee, owner sweep |
| V4 fee | Pool-manager `TAKE_PORTION`, then minimum owner take |
| V3 prepaid refund | Permit2 transfer to router, router payer and explicit input cleanup |
| Mixed split and fees | 30% V2 + 30% V3 + 40% V4, one router settlement balance, two fees and sweep |

Every case authorizes exactly 1 USDC with finite ERC20 and Permit2 allowances.
The wallet reconstructs PermitSingle typed data; the keyring signs it; the server
recovers the owner and independently hashes the same terms. Both economic verifiers
must agree before a transaction is signed. After actual execution the driver checks:

- Owner debit equals the authorized input; output meets the proven minimum.
- Owner output plus measured fee-recipient deltas equals the independently quoted
  gross output. Every fee fits its approved gross percentage plus explicit rounding.
- Router input and output balances are zero. Neither the ERC20 approval nor Permit2
  spend allowance retains authority. Permit2's nonce advanced exactly once.
- Replaying the swap reverts. A separate direct Permit2 call returns the exact
  `InvalidNonce()` selector, isolating nonce rejection from exhausted token allowance.

The two-recipient schedule allows one base unit of rounding only for the second
recipient. That is an explicit fixture policy, not a production fee-policy default.
The prepayment route exercises cleanup, but its actual fill consumes all input;
**it does not establish acceptance of a real partial fill**.

Failure checks also run on every route: altered owner/spend/receive authority is
rejected by both verifiers, expired router calldata is rejected and reverts, and
a corrupted signature passes economic checks but fails permit validation and
reverts. The V3 direct case additionally builds an unfillable minimum at twice the
quote. Its bounded authority and valid signature pass both pure validators, while
the actual contract reverts. This demonstrates why simulation is a separate gate.
Failure probes use `eth_call`; balances and Permit2 state remain unchanged.

## Reproduce

Start a fresh disposable fork in a dedicated terminal:

```sh
anvil --fork-url https://eth.drpc.org --fork-block-number 26218343 \
  --chain-id 31337 --host 127.0.0.1 --port 28545 --accounts 0 \
  --no-storage-caching --silent
```

From the repository root:

```sh
cargo build -p honey-server --example uniswap_fork_verify
node --experimental-strip-types \
  --import ./packages/keyring/scripts/local-ts-loader.mjs \
  packages/keyring/scripts/uniswap-fork-smoke.mjs
```

The driver prints only bounded proof metadata and hashes, not signatures or raw
signed transactions. Stop the owned Anvil process after testing. Archive RPC
availability/rate limits are external prerequisites; transport failure is not
counted as an expected contract revert.

## Remaining execution work

Authenticated quote/build acceptance still needs a Trading API credential location.
Review/permit provenance, encrypted preparation, authenticated HTTP commands and
durable dispatch are now connected in [UNISWAP-SERVICE.md](UNISWAP-SERVICE.md).
A separate [service harness](UNISWAP-SERVICE-ACCEPTANCE.md) now exercises V3 through
actual preparation, restart recovery, bounded fees, an unknown broadcast response
and final reconciliation. The router-only driver on this page still does not prove
those service properties for its seven route shapes.

Additional service route/reorg/failover scenarios and real-device acceptance remain
open. Intermediate-token mixed routes, actual partial fills, taxed/rebasing assets,
native wrapping, hooks and contract-account signatures are not established by this
harness. Supported-flow limits remain in [UNISWAP-ECONOMICS.md](UNISWAP-ECONOMICS.md).
