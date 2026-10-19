# Uniswap service: actual-contract local acceptance

Verified 2026-10-18. The real HTTP server, PostgreSQL lifecycle, Redis admission,
SIWE authentication, worker, shared client validation and keyring now complete a
V3 exact-input swap against actual forked Ethereum contracts. The quote/build
server is a synthetic local fixture. **This is not authenticated Trading API
acceptance, production registry approval, real consensus finality or a device UX test.**
Production execution remains disabled.

## Reproducible boundary

Driver: `packages/keyring/scripts/uniswap-http-fork-smoke.mjs`. It accepts only fixed
`--fees`, `--drop-ack` and `--unfillable` scenario flags; no arbitrary endpoint or
wallet/key arguments. It requires a fresh Anvil fork of Ethereum block 26218343,
chain 31337, literal `127.0.0.1:28545`. Server/provider ports are 28546/28547; the
optional lost-response proxy is 28548. None may be occupied by another process.

The driver verifies Anvil/chain/block identity, snapshots the fork and funds a
public scalar-1 fixture account from an impersonated aUSDC holder only on that
fork. Its inherited mainnet delegated code is cleared locally to model an EOA.
The next block's timestamp is aligned with the wall-clock review. All changes are
reverted on exit. An isolated database is created/migrated and dropped, private
mode-0600 config files are removed, owned HTTP children close and key bytes are wiped.
The shared database/Redis services and unrelated server processes are retained.
The helper removes only exact RPC/quote budget keys in this run's unique namespace.

Contract pins are observed acceptance data; they do not authorize production.
The harness uses Universal Router 2.1.2, Permit2, USDC and WETH at the documented
Ethereum addresses. The V3 pool is read from its factory and output comes from
`quoteExactInputSingle` on the actual QuoterV2. Deployment references:
[Uniswap v4/router deployments](https://developers.uniswap.org/docs/protocols/v4/deployments),
[V3 Ethereum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments).

Start the dedicated fork:

```sh
anvil --fork-url https://eth.drpc.org --fork-block-number 26218343 \
  --chain-id 31337 --host 127.0.0.1 --port 28545 --accounts 0 \
  --no-storage-caching --silent
```

With the documented local PostgreSQL/Redis services running at 25432/26379:

```sh
cargo build -p honey-server --bin honey-server --example aave_fork_prepare
node --experimental-strip-types \
  --import ./packages/keyring/scripts/local-ts-loader.mjs \
  packages/keyring/scripts/uniswap-http-fork-smoke.mjs
node --experimental-strip-types \
  --import ./packages/keyring/scripts/local-ts-loader.mjs \
  packages/keyring/scripts/uniswap-http-fork-smoke.mjs --fees --drop-ack
node --experimental-strip-types \
  --import ./packages/keyring/scripts/local-ts-loader.mjs \
  packages/keyring/scripts/uniswap-http-fork-smoke.mjs --unfillable
```

Run scenarios sequentially. Each restores the original fork snapshot. The source
archive RPC must remain available; its failures are not successful negative tests.
Stop the owned fork after testing. The database helper's Aave-derived name is reused
only for its bounded disposable database lifecycle, not for swap execution.

## Passing evidence

| Scenario | Result | Evidence |
| --- | --- | --- |
| Zero-fee V3 | 1,000,000 USDC base units spent; 413,588,559,259,636 WETH base units received, above 409,452,673,667,039 minimum | [JSON](evidence/uniswap-service-zero-fee-local-fork-2026-10-18.json) |
| Two 100-bps fees + lost broadcast acknowledgement | Same input; owner receives 405,316,788,074,444; each recipient receives 4,135,885,592,596; signed transactions broadcast exactly once | [JSON](evidence/uniswap-service-fees-lost-ack-local-fork-2026-10-18.json) |
| Unfillable output | Provider claims twice the actual quoter output; semantic proof passes but actual sequential simulation rejects it. Operation fails without preparation or signed submission; balances/allowance/Permit2 nonce unchanged | [JSON](evidence/uniswap-service-unfillable-local-fork-2026-10-18.json) |

Both successful scenarios exercise:

1. Real SIWE challenge/signature/session and idempotent operation creation.
2. Fresh quote observation, immutable review, independent wallet review and a real
   PermitSingle signature admitted into encrypted persistence.
3. Real code/implementation/nonce/allowance reads and `eth_simulateV1` preparation
   of finite USDC approval plus router action. No allowance/state simulation override.
4. Independent client call/economic validation and exact EIP-1559 signing.
5. Server restart before signing: identical persisted signing evidence and original
   intent return. Exact permit retry does not request a new provider build.
6. Encrypted signed-bundle admission and restart; the worker dispatches sequentially,
   reconciles actual receipts and reaches `succeeded` after bounded local mining.
7. Input/output balance checks, consumed ERC20 and Permit2 finite allowances,
   incremented Permit2 nonce, exactly one quote and one build, and historical status
   recovery with execution disabled.

The fee scenario forwards the first broadcast to Anvil, then destroys its HTTP
response. The provider transport reports an unknown result. Recovery discovers the
included transaction and continues without replaying it; the proxy records exactly
one broadcast per signed hash. It also checks recipient balance deltas, total output
conservation and zero router residuals. The second fee uses the router's fractional
payment command with an explicit one-base-unit rounding tolerance.

Both successful runs observe a finalized-tag lag of 64 blocks and mine that bounded
number locally. No application finality rule is bypassed; this is simulated finality,
not evidence of mainnet consensus behavior. Output JSON contains hashes, public test
addresses and economic observations, never the Permit2 signature or raw signed bytes.

## Limits and next checks

V2/V4/split/partial-fill service scenarios, reset-approval execution, dropped sends
before node acceptance, conflicting external nonces, chain reorgs, failover under
load and device review rendering are not established by these three runs. Earlier
router-only evidence covers seven route shapes but cannot replace service evidence.
The unfillable case proves rejection before signing; it does not imply an admitted
permit can be erased or its nonce reservation released early. Database regression
coverage separately verifies retained permit authority on failed builds.

Live Trading API credentials, deployed registry/upgrade policy, approved fee
recipients, production broadcast policy and full frontend acceptance remain required.
This milestone advances Uniswap; it does not complete the other providers, persistent
sessions or the 10,000-active-user capacity goal.
