# Uniswap router decoding and Permit2 proof

Status, 2026-10-18: pure Rust and independent TypeScript router decoders, fixed
PermitSingle reconstruction and Rust EOA signature verification are implemented.
They are building blocks for the unfinished execution service. Ordered token-flow and
fee verification is now implemented separately in [UNISWAP-ECONOMICS.md](UNISWAP-ECONOMICS.md);
seven actual-contract local-fork routes now pass ([acceptance](UNISWAP-CONTRACT-ACCEPTANCE.md));
authenticated provider acceptance and durable signing remain unfinished. **No new signing
endpoint, native key-access flow or broadcast is enabled.** Internal quote/build
construction now exists with independent response checks ([UNISWAP-BUILDS.md](UNISWAP-BUILDS.md)).
Successful structural decoding or permit verification is not swap authorization.

## Pinned evidence

The Trading API router version `2.1.2` resolves to Universal Router commit
`802fe4c18f47300e0f183e2a42e9146ec2ea9fc3`, with V4 periphery
`545a5d2a87228167edde48f3b9eda122d1e3c4d6` and Permit2
`cc56ad0f3439c502c246fc5cfcc3db92bb8b7219`. Source links and downloaded SHA-256
hashes are recorded in [the evidence manifest](evidence/uniswap-router-source-pins-2026-10-18.json).
This records source identity, not deployed bytecode approval.

The pinned [dispatcher](https://github.com/Uniswap/universal-router/blob/802fe4c18f47300e0f183e2a42e9146ec2ea9fc3/contracts/base/Dispatcher.sol)
decodes **six** V2/V3 fields, including `uint256[] minHopPriceX36`. Older five-field
examples are not sufficient for this version. The
[V4 interface](https://github.com/Uniswap/v4-periphery/blob/545a5d2a87228167edde48f3b9eda122d1e3c4d6/src/interfaces/IV4Router.sol)
also includes per-hop price limits. Versions must never be guessed from opcode
numbers or API examples alone.

## Decoder contract

Server module: `apps/server/src/providers/uniswap_router.rs`. Wallet implementation:
`packages/api-client/src/uniswap-router.ts`. Both require the deadline-bearing
`execute(bytes,bytes[],uint256)` entrypoint and preserve the exact numeric values
as decimal strings. They accept this initial CLASSIC vocabulary:

| Command | Decoded authority |
| --- | --- |
| V2/V3 exact input | Recipient, spend, minimum output, complete path, payer, hop price limits |
| Permit2 transfer-from | Token, recipient, uint160 spend |
| PermitSingle | Token, finite-width amount, expiration, nonce, spender, signature deadline and bytes |
| Sweep/transfer | Token, recipient and minimum/exact amount |
| Pay portion/full precision | Token, recipient and raw percentage parameter |
| V4 swap | Complete nested exact-input and settle/take/portion sequence |

V4 single and multi-hop pool keys require zero hooks and empty hook data, static
fee at most 1,000,000, positive tick spacing at most 32,767 and valid currency
ordering for a single pool. Swap paths and per-hop limit arrays are bounded to
eight hops. Zero hop-price arrays are accepted where the source supports them.
V4 `OPEN_DELTA`, router `CONTRACT_BALANCE`, recipient sentinels and explicit zero
amounts remain distinguishable in the decoded result; the decoder does not silently
turn them into fixed amounts. Registry checks must reject native/unknown currencies
for the initial ERC20 service; syntactically valid addresses alone are insufficient.

No partial-revert flags, nested subplans, exact-output commands, position-manager
calls, wrapping commands, batch permits or cross-chain commands are accepted.
Unsupported commands reject the whole build. These restrictions are an explicit
initial execution vocabulary, not proof that all valid Trading API builds fit it.
Mixed V2/V3/V4 command sequences have independent economic validation and local-fork
split-route acceptance; the explicit limits in UNISWAP-ECONOMICS.md still apply.

Canonical ABI checking requires contiguous ordered dynamic tails, exact consumption,
zero padding, correct offset bases, bounded lengths, exact booleans and integer/address
widths. Aliased offsets, gaps, overlap, truncated words and ignored suffixes are
rejected even where Solidity assembly could decode them. Entire calldata is capped
at 64 KiB, commands at 64 and each V4 action sequence at 64; all nested data shares
the outer byte bound. This parser bound is not an increase to the durable EVM plan's
existing transaction-size limit; execution sizing must be reconciled separately.

Decoded server models intentionally have no production Debug/Serialize implementation.
The temporary binary buffer and extracted signature string are zeroized on drop.
The caller's original input still needs encrypted/short-lived handling. JavaScript
strings cannot be reliably wiped; no signing flow or persistent store uses these yet.

## Permit authority

`providers/permit2.rs` reconstructs Permit2's domain and nested PermitSingle hashes
from canonical terms. No provider-supplied type definition or domain is forwarded.
The shared client's `permit2TypedData` produces the corresponding fixed typed-data
JSON, and `validatePermit2Quote` binds it to the actual wallet, current quote, exact
input, chain, configured Permit2 and router. Chain IDs are limited to positive safe
JavaScript integers for identical native/server reconstruction.

The server verifies either standard 65-byte signatures with recovery byte 27/28 or
64-byte ERC-2098 signatures against the expected EOA. Honey requires low-S signatures;
raw Permit2 ecrecover is more permissive. Zero/unlimited amounts, oversized nonce,
noncanonical decimal text and expired authority reject. Signature lifetime is at most
30 minutes; allowance expiration is at most 30 days and cannot precede the signature
deadline. The deadline boundary is exclusive for local admission. These stricter
policy choices need provider-acceptance evidence and an eventual immutable-intent
deadline; this code does not renew an existing authorization.

`Execution::verify_embedded_permit` requires exactly one leading PermitSingle when
one was expected, no permit otherwise, exact equality with separately supplied terms,
a live router deadline no later than the signature deadline, and cryptographic owner
recovery. Client `validateEmbeddedPermit` compares the embedded permit and signature
to the terms and exact bytes the wallet produced. The client comparison does not
replace server signature recovery or a fresh chain nonce check.

Neither helper proves the owner has no contract/delegated code, the nonce is current,
the ERC20 allowance is sufficient, or the router/Permit2 bytecode is approved. Those
remain required RPC/service checks. PermitSingle grants allowance to a spender; it
does not cryptographically bind the swap recipient, output token, price or fee policy.
The separate transaction review and durable intent must protect those values.

## Tests and limits of evidence

The repository's existing viem 2.57.2 independently encodes five router fixtures,
28 malformed/unsupported examples and a Permit2 EIP-712 vector. The fixture generator
is under `packages/keyring/scripts/`; outputs are under `packages/api-client/src/fixtures/`.
Both decoders compare complete results with the same independent fixtures and reject
every word-boundary truncation. Tests include legacy five-field commands, dirty
booleans/addresses, aliased tails, unsupported flags, hooks, spacing, width overflow
and missing/multiple/reordered permits. Rust digest and recovered signer match viem,
including compact signatures; mutations cover every signed field, high-S, recovery
bytes and expiry. Client tests bind permits to wallet/quote and locally signed bytes.
The test key is the explicitly public scalar 1 and must never hold real funds.

These fixtures are synthetic. They are neither authenticated Trading API output nor
an actual-contract execution test. Separate actual-contract evidence is now recorded in
[UNISWAP-CONTRACT-ACCEPTANCE.md](UNISWAP-CONTRACT-ACCEPTANCE.md). No production service
or public-chain funds were used.

## Authority handoff and remaining execution work

1. Ordered token-flow and economic verification is now implemented with the explicit
   constraints in UNISWAP-ECONOMICS.md. Actual-contract acceptance must verify:
   every user debit across commands/V4 settlements, every intermediate balance,
   final receive floor, surplus/refund ownership and all fee recipients. Resolve
   sender/router/full-balance/open-delta sentinels explicitly. Fail on retained
   user assets, duplicate spending, unapproved external transfers or ambiguous flow.
2. The implemented fee proof accounts for order; authenticated build compatibility
   remains unverified. The pinned
   [Payments implementation](https://github.com/Uniswap/universal-router/blob/802fe4c18f47300e0f183e2a42e9146ec2ea9fc3/contracts/modules/Payments.sol)
   applies portion commands to the **remaining balance**. Multiple command rates
   cannot simply be compared one-by-one with quote percentages of gross output.
   Full-precision portions, rounding, pool-manager take portions and preexisting
   router balances need explicit semantics and adversarial tests.
3. Built swap preparations now have encrypted immutable persistence and recovery
   ([SEALED-SWAP-PREPARATIONS.md](SEALED-SWAP-PREPARATIONS.md)). Pre-build permit review
   and encrypted signature staging remain unfinished. Do not request a permit
   signature until owner, input, spender, fee
   policy and deadline are reviewed. Bind build provenance and signing snapshots;
   never blindly re-sign after uncertain submission or silently refresh deadlines.
4. Fetch authenticated build fixtures with the actual key/account settings and
   validate provider compatibility. Then check contract pins, nonce/allowances,
   balance, gas/fee ceilings, source block and ordered simulation; extend existing
   durable dispatch/reconciliation by action without weakening Earn's invariants.
5. Wire native review/confirmation/sign/history/recovery and test the full route
   on an actual-contract fork, including splits, mixed protocols, fees, permit
   replay, partial approvals, reorgs and process restarts. Production launch still
   needs reviewed registries, fee policy, provider entitlements and capacity evidence.
