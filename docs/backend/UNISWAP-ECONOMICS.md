# Uniswap economic proof before signing

Status, 2026-10-18: independent Rust and TypeScript economic verifiers are
implemented on top of the pinned router decoders. They check transaction identity,
ordered token debits/credits, fee ceilings, receive floors and refund destinations.
The shared client can derive public authority from a fresh reviewed quote.
No swap signing API, provider build call, durable swap worker or broadcast is enabled.

This is a **conditional-on-success proof**, not evidence a transaction will succeed.
It assumes the reviewed router/Permit2/pool implementations and approved standard
ERC20 behavior. Fresh deployment/implementation pins, account compatibility,
allowance/nonce, balance, simulation, gas ceilings and durable execution remain
mandatory. Synthetic tests do not prove authenticated provider compatibility or
actual-contract execution.

## Inputs and boundary

Server: `apps/server/src/providers/uniswap_economics.rs`. Independent wallet proof:
`packages/api-client/src/uniswap-economics.ts`. `validate_economics` and
`validateSwapEconomics` decode the complete call themselves; callers cannot supply
an unchecked subset of decoded commands. Their public authority includes:

| Field | Requirement |
| --- | --- |
| Chain, owner, router | Exact match to call chain/from/to; zero native value |
| Input/output token | Distinct approved ERC20s, registry of 2–64 unique addresses |
| Maximum input | Positive finite amount below Permit2's unlimited sentinel |
| Minimum output | Positive base-unit receive floor |
| Deadline | Exact encoded deadline, live and within 30 minutes of trusted time |
| Fee basis | Explicit `settlement_balance`, never the quote's estimated amount |
| Fees | At most four unique recipients, total ceiling at most 500 whole bps |
| Rounding per fee | Explicit zero or one output-token base unit, never inferred |

All numeric authority fields are canonical decimal strings, including basis points.
This preserves the existing immutable-intent store's no-JSON-numbers invariant.
Recipient sentinels resolve to the actual owner/router; approved addresses cannot
themselves be the zero/sentinel addresses. Fees cannot be paid to a disguised router,
unknown recipient or an input/intermediate asset.

`swapAuthorityFromQuote` validates wallet, chain, policy revisions, exact input,
net receive and freshness before copying the authority. Caller-supplied deadline
and rounding allowance remain fixed. The resulting arrays are independent of later
configuration mutations. No signature is requested by this helper. Future review
must explicitly show any one-base-unit rounding allowance, especially for assets
with few decimals; it must not silently select this permission for compatibility.

The proof returns the total maximum token debit, guaranteed output lower bound,
refund assets and fee recipients. It does not return executable permission or
transaction/signature bytes. Native network fees are checked by the separate EVM
signing/envelope pipeline, not by this ERC20 economic proof.

## Ordered balances and user debit

Each router-held asset has a lower bound and an optional upper bound. Exact
prepayments create exact bounds; swap outputs have an enforced lower bound and
unknown upper bound. Credits and transfers update those bounds in command order.
A router payer must have provenance from this execution; preexisting router tokens
cannot manufacture a required route receive floor. A zero-floor owner cleanup may
also return unrelated dust, without increasing the proof's guaranteed receive.

Every user-funded V2/V3 input, Permit2 transfer and V4 settlement contributes to
the aggregate maximum debit. Only the approved input token can be charged. The
declared allocation must equal the reviewed input amount; actual partial fills may
spend less. Full-router-balance sentinels are rejected when the payer is the user,
because arbitrary router deposits would otherwise alter user authority.

Router-funded routes can consume intermediate credits, including full-balance
amounts. This supports split and mixed V2/V3/V4 sequences. No assumption is made
that all commands use the same protocol or directly connect input to final output.
All intermediate assets must be registered. The decoder's command/hop/byte bounds
apply, and total swaps are additionally capped at 64.

For V3, exact-input execution may consume less than its requested amount at a price
boundary. The verifier preserves possible input leftovers for router-funded swaps
and possible intermediate leftovers for multi-hop swaps. Those balances must be
returned to the owner; an exact-output minimum does not substitute for a refund.
Builders lacking necessary cleanup need a separately reviewed normalization step
or must be rejected. They are not accepted merely because a simulation used every
token in one snapshot. See the pinned
[V3 implementation](https://github.com/Uniswap/universal-router/blob/802fe4c18f47300e0f183e2a42e9146ec2ea9fc3/contracts/modules/uniswap/v3/V3SwapRouter.sol).

## V4 debt, credit and settlement

The V4 proof tracks a conservative signed lower bound for each pool-manager delta.
Fixed swap inputs bound possible debt; output floors create credit. An open-credit
swap consumes that credit without inventing another user debit. Explicit settlements
charge their exact amount; open-debt settlements charge at most the derived debt
bound; `SETTLE_ALL` also applies the encoded maximum. Router-funded settlement
consumes router credit and preserves possible refunds where the actual debt is lower.

`TAKE_ALL`, open-credit takes and explicit amounts deliver only to the owner,
router or approved fee recipients. A take cannot invent provenance for output
that has not been produced/funded. Known unsettled lower bounds reject the build.
At successful unlock the pinned
[PoolManager](https://github.com/Uniswap/v4-core/blob/59d3ecf53afa9264a16bba0e38f4c5d2231f80bc/src/PoolManager.sol)
requires every actual currency delta to be zero. Therefore an uncertain residual
inside the pool-manager callback can cause a revert but cannot survive a successful
transaction. Router ERC20 balances have no equivalent invariant and require explicit
owner cleanup. This distinction is part of the proof, not an assumed equivalence.

## Fees and integer rounding

Fees are charged only after route swaps finish, from one settlement location, with
each configured recipient appearing once. Additional output cannot be introduced
into that fee source after the fee phase begins. Post-fee output can be moved to the
router for owner delivery, but a second fee source cannot restart percentage accounting.
Fixed fee transfers, basis-point portions, full-precision portions and V4 take portions
are checked. Unexpected fees or omitted configured recipients reject the build.

The fee basis is the actual initial balance at the settlement source, including any
incidental output dust swept through that source. It is not the earlier quoted gross
output. The owner receive floor remains independently enforced; a percentage fee's
absolute amount may change with actual output. Multiple fees use the remaining
balance, so individually comparing command percentages with gross percentages is wrong.

For original settlement balance `G`, maintain `R <= a*G + e`, initially `a=1, e=0`.
For command rate `r=n/d`, payment is `floor(R*r)` and the updated bound is:

```text
payment <= floor(a*r*G + e*r)
remaining <= a*(1-r)*G + e*(1-r) + 1
```

The verifier requires `a*r` not to exceed the recipient's approved gross rate and
the ceiling of `e*r` not to exceed its explicit rounding allowance. When the raw
command rate itself is no larger than the approved gross rate, `R <= G` gives the
bound directly without rounding permission. Fixed amounts must fit the approved
rate at the available lower bound, plus explicit rounding allowance; ignoring their
deduction conservatively overestimates the base for later percentage fees.

Numerators and denominators remain exact integers. Four fee legs bound denominator
growth to `10^72`; overflow rejects. Amount multiplication divides before multiplying
to avoid overflowing full-width uint256 balances. The remaining-balance function is
monotone, so applying it to a proven lower bound preserves a safe receive floor.
Repeated percentage truncation is not implemented using floating-point arithmetic.

## Explicit supported-flow limits

- Native currency, hooks, taxed/rebasing assets, exact output, contract-account
  signatures, arbitrary calls, partial-revert flags and subplans remain outside the
  current reviewed command vocabulary.
- Direct prepayment into a V2 pair with `ALREADY_PAID=0` requires independent pair
  derivation/identity proof and is currently rejected. Router-custodied mixed routes
  are supported; this does not prove every Trading API mixed route is compatible.
- Fee transfers cannot be interleaved with later route swaps or charged from multiple
  settlement contexts. Such provider builds need explicit additional proof, not
  a relaxed check or guessed effective rate.
- Conservative lower bounds may reject feasible paths involving uncertain signed
  deltas. Simulation cannot silently replace missing symbolic authority checks.
- A configured token list does not prove token behavior or deployment identity.
  Contract/RPC acceptance remains an independent required gate before use with keys.

## Verification and next steps

The independent viem generator produces 16 positive scenarios and 40 negative
scenarios in `packages/api-client/src/fixtures/uniswap-economics.json`. Both language
implementations verify the same manually specified economic outcomes. Coverage
includes mixed V2/V3/V4 flow, split V4 routes, open debt, exact prepayment, partial
refunds, maximum-width output arithmetic, four sequential fees, identity changes,
extra debits, weak floors, unauthorized recipients and missing refunds. A separate
concrete integer evaluation checks the accepted four-fee schedule over 150,001 gross
balances, including output improvements, against each approved fee ceiling and the
reported net lower bound. Quote-to-authority tests cover expiry, wallet binding and
copy isolation. These are synthetic/local proofs, not production acceptance.

Seven actual-contract local-fork routes now pass, including V2/V3/V4 splits, ordered
fees, finite allowances and exact Permit2 replay rejection. See
[UNISWAP-CONTRACT-ACCEPTANCE.md](UNISWAP-CONTRACT-ACCEPTANCE.md) for reproducible evidence
and its limits. Actual partial fills and intermediate-token mixed routes remain unverified.

Encrypted immutable built-swap preparation storage is now implemented in
[SEALED-SWAP-PREPARATIONS.md](SEALED-SWAP-PREPARATIONS.md). Next, capture authenticated
Trading API build fixtures and implement pre-build permit authority/signature staging,
provider provenance and the swap execution worker. The native review/sign/status
flow must compose economic validation, Permit2 proof, immutable signing terms,
fresh chain checks and session fencing before any key access.

Deployment research also found that the tagged repository's `deploy-addresses/mainnet.json`
retains an older V2 address. The current 2.1.2 mainnet address is published in the
[official supported-chain reference](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains)
and [release notes](https://github.com/Uniswap/universal-router/releases/tag/2.1.2).
Use those version-specific records plus bytecode/immutable verification; the generic
file is not sufficient authority. zkSync has only router 2.0 and is now rejected by
the quote configuration that pins 2.1.2. Nothing here approves a production registry.
