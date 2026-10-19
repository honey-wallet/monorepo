# Receipt reconciliation, sequential execution and final settlement

Implemented 2026-10-18: internal receipt verification/persistence, later-step dispatch,
owner-scoped recovery and a database-backed actual-contract Aave fork smoke. This is
not yet a running worker, public transaction API or frontend execution screen. The
full backend goal remains active. Extends [SIGNED-SUBMISSIONS.md](SIGNED-SUBMISSIONS.md).

## Evidence boundary

The worker reconstructs a reconciliation context from the immutable operation and
encrypted signed transactions. It decrypts and re-verifies the bundle against its
historical plan, including chain, signer, calls, ordered nonces and fee ceiling.
Historical verification deliberately does not authorize sending an expired plan.

The context and resulting verified report have no public constructors or Deserialize
implementation. Arbitrary HTTP JSON cannot claim a successful receipt. A report binds
the operation, plan hash, chain and complete ordered transaction hashes. Each poll
loads the persisted finalized checkpoint; stale contexts cannot silently replace it.

The RPC collector checks:

- Configured chain, at most eight expected transactions, fresh Ethereum head timestamp;
  chain 31337 is accepted only through loopback for disposable tests.
- Exact receipt transaction hash, sender and target; type 2, no contract creation,
  status 0/1, bounded gas used, and exact EIP-1559 effective price derived from the
  canonical block base fee and the signed max/priority fee. Numeric quantities are
  parsed without floats or JavaScript precision loss.
- Canonical block number/hash and transaction hash at the receipt's block index.
  Known transactions from the same bundle must occur in nonce order.
- A supported `finalized` checkpoint no higher than the observed head. No fallback
  to a guessed confirmation count. The old finalized checkpoint remains canonical,
  even if the new finalized height advances.
- Rechecks of all source/receipt/checkpoint block hashes before returning the report,
  to detect a branch change during the multi-request read.

RPC remains trusted chain infrastructure. This is consistency validation, not a light
client, Merkle inclusion proof or Byzantine-provider quorum. An endpoint that lies
consistently can lie about consensus. Approved RPC operations, independent monitoring
and any quorum policy remain launch requirements. A lagging/inconsistent provider is
rejected rather than interpreted as financial failure.

## Missing, included, reverted and finalized are different facts

A missing receipt does not prove that a transaction was dropped, replaced or never
sent. The observation stores no fabricated inclusion and does not release its nonce.
A successful canonical receipt permits provisional progress. A reverted receipt blocks
later steps. Final business outcome requires **every signed slot** to have a canonical
finalized receipt for its exact known hash.

| Observed bundle | Operation state / consequence |
| --- | --- |
| Stored signatures, no dispatch or receipt | `signed` |
| Dispatch intent with no receipt | `unknown`; reconcile by hash |
| One or more successful included receipts, incomplete finality | `confirming` |
| Previously included receipt disappears | `unknown` if none remain; keep reservations |
| A reverted receipt with unresolved signed slots | `unknown`; later dispatch blocked |
| Every signed transaction finalized and successful | `succeeded`; release wallet guard |
| Every signed transaction finalized, at least one reverted | `failed`; release wallet guard |

Receipt success here means the prepared EVM calls executed successfully on the approved
contracts. It does not establish profitability, APY, or a balance that the contract did
not guarantee. Provider semantics and fresh pre-send simulation remain mandatory.
A failed action can leave a successful approval behind; releasing a nonce guard does
not revoke ERC20 allowance. UI must expose the partial outcome and a separately reviewed
revoke/cancel workflow.

Partial failure cannot free unused signed nonces on a timer. Those signatures still
exist and could be broadcast outside Honey. Replacement discovery, user-signed nonce
cancellation and explicit fee replacement remain unfinished. A missing receipt plus
an advanced account nonce is not sufficient here to fabricate a replacement outcome.

## Persistence and worker fencing

Migration 4 adds immutable observation batches and a refreshable current projection.
A batch stores the ordered observations and a content hash, head/finalized checkpoints
and observation time. Every meaningful receipt/reorg/finality change appends a batch.
Unchanged polls refresh the current proof and defer the existing job by five seconds;
they do not append history or advance the operation version. Healthy deferral resets
retry attempts, separate from retries for upstream faults.

The current projection is an operational cache of the latest verified checkpoint,
not an immutable record of every poll. Meaningful history remains immutable. Both
recovery and later-step dispatch hash-check the persisted observation JSON. Corrupted
or incomplete evidence fails closed.

A live version/token/lease locks the job and operation. The report must be no more
than ten seconds old according to database time. Full ordered hash binding, finalized
checkpoint continuity and final lease/freshness predicates are checked under the lock.
Observation, operation/version, job acknowledgement, successor and terminal guard release
commit together. Old workers, older checkpoints and conflicting finalized hashes cannot
advance the operation. Already finalized receipts cannot disappear or change gas,
block position or outcome while other signed steps remain pending. Terminal operations cannot be regressed by this method.

The finalized anchor is a consistency invariant, not a remedy for a consensus finality
violation. Such a conflict must halt automated progress and be investigated. No automatic
reinterpretation or deletion of historical finalized evidence is implemented.

## Later-step dispatch

`begin_dispatch_step` extends the initial dispatch journal without weakening its
commit-before-bytes rule. A later step additionally needs a current proof younger than
ten seconds, every predecessor successfully included, its own receipt absent, and no
reverted receipt anywhere in the bundle. It cannot skip steps or resend a transaction
with an existing dispatch intent. Signed nonce, plan expiry and worker fencing are
rechecked before commit.

Intermediate approval inclusion is distinct from final settlement. Waiting for full
Ethereum finality before every approval would outlive the two-minute preparation.
A reorg can still occur after a check; a database transaction cannot lock a blockchain.
The orchestrator must obtain fresh account/nonce/fee/provider eligibility and simulate
remaining calls immediately before sending. These internal methods do not replace that
orchestration. RPC IO occurs outside database locks.

## Recovery contract and frontend seam

Owner-scoped GET `/api/v1/operations/{id}` now includes nullable `reconciliation`:
checkedAtMs, head and finalized numbers/hashes, and ordered transaction observations.
Each observation has its hash and either null inclusion or block/index, status,
finality, gas used and effective gas price. All large quantities are decimal strings.
No signatures, ciphertext or data-encryption key IDs are returned.

The shared client validates identity/order, scalar bounds, block/finality relations
and state semantics. It distinguishes successful inclusion from settled success and
accepts missing receipts as uncertainty. The actual fork run passes its final backend
response through this shared validator. UI integration still needs to show last-checked
age, per-step status, exact fees, failure/reorg recovery and safe user actions; a hash
alone must never drive a success screen.

## Actual-contract/database proof

[Captured evidence](evidence/aave-reconciled-local-fork-2026-10-18.json) records:

1. A new isolated PostgreSQL database migrated through version 4, a fixture principal
   and proven-address membership, a real Aave intent and persisted immutable preparation.
2. Actual wallet-keyring signatures, independent Rust verification, encrypted bundle
   acceptance, nonce guard and transactional outbox.
3. Journaled approval, successful canonical approval verification, journaled supply,
   receipt reconciliation and settlement. Then a separate finite withdrawal operation.
4. Recovery via the server repository, validated by the shared API client. Both
   operations reached `succeeded`; finality released each wallet guard so the next
   operation could reserve the wallet's new nonce.

Source Ethereum block: 26,218,343. Local chain: 31337. Supply: 1 USDC; withdrawal:
0.9 USDC. Starting from 10 USDC, final fixture balances were 9.9 USDC and 99,998 raw
aUSDC. Gas used: approval 55,558; supply 201,989; withdrawal 166,198.

Anvil reported safe = head−32 and finalized = head−64. The first run correctly remained
unsettled after inclusion. The successful test reads the actual lag, bounds it to 256,
and mines 64 empty **local** blocks after each completed action. This proves the code's
finality gating against that node's simulated policy, not real Ethereum consensus.
All upstream requests were reads. The database was dropped and the fork snapshot restored.
The public test scalar's inherited delegated code was cleared only inside the snapshot.

Reproduce using the disposable `honey-backend-agent` PostgreSQL service (port 25432,
fixture credentials from compose.backend.yaml) and the loopback Anvil command in
[AAVE-EXECUTION.md](AAVE-EXECUTION.md), then:

```sh
cargo build --locked --example aave_fork_prepare
node --experimental-strip-types packages/keyring/scripts/aave-fork-smoke.mjs
```

The bridge hardcodes loopback services and accepts only its generated test-database
name prefix for cleanup. It uses public test encryption material, never a production
key. It does not exercise HTTP authentication, production secret loading, a supervised
worker, or a physical frontend. Those remain necessary acceptance tests.

## Capacity and remaining integration

The collector is bounded by existing four-request RPC admission, per-request limits
and a 60-second overall deadline. At eight steps it can make up to 30 RPC reads,
including checkpoint rechecks. This is not an acceptable per-user hot path. A running
worker must apply shared provider quotas, limit concurrent active operations, coalesce
head/checkpoint reads safely, back off pending transactions and expose per-stage metrics.
The five-second healthy poll interval is an initial policy, not 10k-user capacity proof.

Next: authenticated typed Aave create/prepare/submit APIs, configured key distribution,
validated launch registry/fee policy, fresh pre-send checks, actual dispatch and supervised
reconciliation workers, plus frontend review/sign/status flows. Then fault/restart testing
through the HTTP API and deployment-level mixed-load evidence. Other providers, persistent
device sessions and the full 10k workload remain in the overall roadmap.

Primary references: [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/),
[EIP-1559 fee calculation](https://eips.ethereum.org/EIPS/eip-1559),
[Ethereum finality](https://ethereum.org/developers/docs/consensus-mechanisms/pos/gasper/).

Verification: `pnpm lint && pnpm typecheck && pnpm test` passed; 28 explicit real-service regressions passed (11 submission/reconciliation, 8 preparation, 7 durability, 2 infrastructure). Shared-client suite: 34 passing tests. The actual-contract/database smoke passed and cleaned up its database and snapshot; the owned Anvil process was stopped. No production transaction or deployment occurred.
