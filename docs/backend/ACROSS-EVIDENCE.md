# Across deposit and delivery evidence

> Retired 2026-10-21: Across is no longer mounted or started in the active server.
> This document preserves historical evidence. See [NEAR-INTENTS.md](NEAR-INTENTS.md) for its replacement.

Implemented and verified locally: 2026-10-18. Decisions D85–D86.

The direct ERC20 contract boundary now has independent calldata validation,
source-event identity and finalized destination-payment verification. A real
Ethereum/Base two-fork test passes with actual Across and USDC contracts. This
is a prerequisite for the bridge execution service, **not a completed bridge
product**: quote reads are now separate ([ACROSS-QUOTES.md](ACROSS-QUOTES.md)); there is no public Across prepare/submit endpoint, provider-driven
relayer acceptance, refund verifier or financial-state transition from this proof.
The history UI still presents provider observations as advisory.

## Exact implemented boundary

`apps/server/src/providers/across_evidence.rs` accepts independently reviewed
`DirectDepositTerms`. Chain IDs, raw amounts and timestamps serialize as canonical
decimal strings so the terms can be committed in the existing immutable operation
intent. The terms bind depositor, recipient, source/destination chains and tokens,
exact input/output amounts, exclusive relayer, quote time, fill deadline and
exclusivity parameter. They are not a substitute for a validated quote or user
consent. Future preparation must additionally enforce quote freshness, minimum
output, fee policy, allowance, nonce, gas limits and simulation.

The initial accepted call shapes are `deposit(bytes32,…)` and `depositV3(address,…)`
directly on a reviewed SpokePool. Validation compares every argument and requires
canonical ABI layout, zero native value and an empty message. Untagged terms
accept exactly 420 bytes; terms with a Swap API integrator ID accept exactly 428
bytes with the bound `1dc0de` + two-byte ID + `73c0de` suffix (D88). No other
trailing data is allowed. EVM address padding and integer widths are checked. Periphery calls,
unsafe deposit IDs, automatic timestamps, other integrator trailers, permit
wrappers, source/destination swaps, embedded calls and native-token payments need
their own decoding and economic verification. They are rejected here rather than
being routed through the direct-call validator. Builder fee callbacks remain open.

The current Across [interface source](https://github.com/across-protocol/contracts/blob/950e9154f3d61e59590eb7d4403fae5d3cae84f8/contracts/interfaces/V3SpokePoolInterface.sol)
defines the bytes32 `FundsDeposited` and `FilledRelay` events. Legacy event names
and non-EVM identifiers are not accepted by this verifier. The pinned
[implementation](https://github.com/across-protocol/contracts/blob/950e9154f3d61e59590eb7d4403fae5d3cae84f8/contracts/spoke-pools/SpokePool.sol)
resolves a nonzero exclusivity parameter at most 31,536,000 as an offset from the
source block timestamp; larger values are absolute timestamps. It emits a zero
hash for an empty message. The verifier follows these execution semantics,
including checked timestamp addition. Source-file hashes are in
[contract-source evidence](evidence/across-contract-source-2026-10-18.json).

## Source proof

`verify_deposit` uses the supplied trusted RPC and an independently approved
`EvidencePolicy`, with a 30-second overall deadline. The policy binds chain,
SpokePool/proxy implementation, token/proxy implementation and wrapped-native
address. It is not populated from a quote. Supported implementation slots are
fixed EIP-1967 and USDC families; arbitrary caller-selected slots are absent.

The verifier requires:

- Correct RPC chain, expected source hash, successful receipt, exact sender and
  direct SpokePool destination, and no contract-creation receipt.
- Receipt inclusion at or below the RPC's finalized checkpoint, matching block
  hash, and that transaction at its claimed canonical block index.
- Historical SpokePool/token code hashes and implementation addresses matching
  the policy. The SpokePool's wrapped-native getter must match too. The selected
  token cannot be the wrapped-native token under this initial path.
- Bounded, ordered, nonremoved logs with matching transaction/block metadata.
- A transaction read with matching hash, chain, sender, destination and block,
  whose entire calldata and native value match the immutable terms.
- Exactly one supported deposit event from that SpokePool, with all financial
  fields and resolved exclusivity equal to the expected terms. The deposit ID is
  extracted from this event, not a status API. Counter-based direct deposit IDs
  must fit uint32; unsafe deposit paths are not inferred from an event alone.
- A matching standard-token transfer from depositor to SpokePool, before the
  deposit event, with the exact input amount. Conflicting relevant transfers are
  rejected. The canonical source block is checked again after the transaction read.

The returned `VerifiedAcrossDeposit` has no public constructor or deserializer.
It contains the exact terms, deposit ID, resolved exclusivity, source event/block
and finalized checkpoint, plus observation time. Other modules cannot deserialize
a provider response into this proof type.

`BridgeMonitor::attach_across` now requires this proof. It derives the status
binding itself, compares `acrossDirectDeposit` and `bridgeTracking` with the
immutable operation intent, checks the persisted submission's signer and requires
the source hash to be the last transaction in that operation's signed bundle.
Proof freshness is rechecked after database waits, before commit. Generic
`attach` accepts Relay only. A caller-supplied Across ID can no longer register a
new watch. This strengthens the prior advisory handoff without claiming that the
application already creates valid signed bridge preparations.

## Destination proof and trust limits

`verify_delivery` refreshes source proof, checks a candidate destination receipt,
then rechecks the source block and finalized checkpoint after destination reads.
The combined operation has a 60-second deadline. Destination verification repeats
the chain, canonical receipt, historical identity and log checks. It requires
one supported fill event with the exact source chain/deposit ID and complete
original token, amount, depositor, recipient, deadline, exclusivity and empty-message
identity. It separately checks the actual execution recipient, output amount and
message hash: a speed-up cannot silently change the reviewed payment.

Fast, replaced-slow and slow fill types are accepted only when the delivered terms
are unchanged. The receipt must show a subsequent exact output-token transfer to
the recipient, with no conflicting recipient-related transfer. A matching event
or source success without payment is insufficient. Multiple fills in one receipt,
native unwraps and callback-based fee distributions remain unsupported.

These checks trust approved RPC infrastructure and reviewed standard-token
semantics. They are not consensus light-client proofs. A consistently dishonest
RPC or a token designed to emit misleading transfers is outside the model. Pin
approval must include proxy dependencies, upgrade governance and historical
deployment semantics; sampling a runtime hash is not approval. Block-end code
and storage checks also do not independently reconstruct intra-block upgrades.
Production finality policy needs chain-specific review, especially L2 settlement
and recovery assumptions. This work does not prove Base L1 finality by running
Anvil's simulated finalized tag.

The result does not yet write an end-to-end financial outcome. Before doing so,
the execution service must bind the proof to the exact operation/version and
persist source/destination anchors under a lease, reject stale/conflicting prior
proofs, expose a separate verified outcome in the shared client, and stop polling
only after that durable handoff. Refunds need an independent verifier; relayer
refund events must not be treated as money returned to the depositor.

## Verification evidence

Four evidence tests pass: canonical consent/calldata checks, malformed encoding
and decimal contracts, successful source/destination reads, and a matrix of
identity/payment/reorg failures. Synthetic logs and calldata are encoded by viem
2.57.2 in `packages/keyring/scripts/across-evidence-fixture.mjs`, independently of
the Rust parser. The fixture is explicitly not a live transaction. Faults cover
missing/unfinalized/failed receipts, wrong chains/senders/targets, removed or
duplicated logs, bad transfer amount/recipient, changed terms, unsupported messages,
changed implementations, inconsistent block contents, destination expiry and a
source branch change after destination verification.

Four monitor tests pass, including the new proof-to-watch PostgreSQL handoff,
unchanged financial operation state, immutable binding and mismatched intent.
These database tests intentionally seed relational metadata, not valid encrypted
financial preparations. CI runs both opt-in evidence and monitor suites.

The separate actual-contract harness passed:

| Check | Observed result |
| --- | --- |
| Ethereum fork | Block 26,220,316, local chain 31337 |
| Base fork | Block 52,773,813, local chain 31338 |
| Source debit | 1,000,000 raw USDC (1 USDC) |
| Destination recipient credit | 990,000 raw USDC (0.99 USDC) |
| Local relayer debit | 990,000 raw USDC |
| Source and relayer finite allowances after use | Both zero |
| Unfinalized receipt | Rejected |
| Changed expected recipient | Rejected |
| Cleanup | Both snapshots restored; owned fork processes stopped |

The 10,000-unit spread is a deliberately selected test term, **not a provider quote
or verified Across/builder fee**. The harness funds local test accounts from forked
pool balances by local impersonation and manually sends the fill from a local
relayer. It never submits to a public RPC or provider service. Sixty-four local
blocks simulate finality. No API authentication, preparation worker, device signing,
refund, live relayer availability or production activation is established here.
Runtime pins, anchors and proof are recorded in
[actual-contract evidence](evidence/across-direct-local-fork-2026-10-18.json).

## Reproduction

Start fresh, disposable forks in two terminals. Public archive availability can
change; a read-only provider credential may be required later. Do not substitute
production chain IDs or point transaction-writing code at a public URL.

```sh
anvil --fork-url https://eth.drpc.org --fork-block-number 26220316 \
  --chain-id 31337 --host 127.0.0.1 --port 29545 \
  --retries 1 --timeout 10000 --silent

anvil --fork-url https://base-rpc.publicnode.com --fork-block-number 52773813 \
  --chain-id 31338 --host 127.0.0.1 --port 29546 \
  --retries 1 --timeout 10000 --silent
```

Then, from the repository root:

```sh
cargo build --locked --example across_fork_evidence
node packages/keyring/scripts/across-fork-evidence.mjs
cargo test --locked --lib providers::across_evidence:: -- --include-ignored
```

The harness checks literal local ports, Anvil identity, chain IDs, expected fork
heights and public test accounts before writes. It explicitly waits for local
mining before receipt lookup; an early lookup can otherwise fall through to the
public fork source, where the local hash does not exist. Initial runs exposed
that behavior and slow upstream retries. The successful run used bounded upstream
retries. Snapshot cleanup attempts both chains and preserves the original error
if cleanup also fails. Stop only the fork processes started for this test.

## Next execution work

Connect authenticated `/swap/approval` transport and a versioned route registry;
validate actual response/calldata forms, including integrator attribution and fee
semantics. Add independently checked periphery/permit/callback paths where required
by the live API. Then reuse immutable preparation, finite approval simulation,
device signing, nonce reservation, durable dispatch and reconciliation, followed
by verified source attachment and persisted destination/refund outcomes. Keep
production execution unavailable until that full path has authenticated provider,
contract, restart/fault and physical-device acceptance.


## Tagged Swap API contract acceptance

[Tagged local-fork evidence](evidence/across-direct-tagged-local-fork-2026-10-18.json)
adds the exact eight-byte attribution suffix to an independently encoded direct
call. Actual forked contracts accepted it and delivered the exact reviewed amount;
changed and omitted IDs were rejected by proof verification. Both fork snapshots
were restored. This is a synthetic ID, manual local relayer and artificial spread,
not live API acceptance, registered attribution, builder fees or a service-worker
bridge execution test.
