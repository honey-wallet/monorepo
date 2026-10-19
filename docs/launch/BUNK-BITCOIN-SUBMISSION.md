# Bitcoin saved transaction submission and observation

`packages/keyring/src/bunk-bitcoin-submit.ts` submits and observes an already
signed, persisted approval. It reads the encrypted journal through the existing
store adapter and validates account network, approval ID/digest, phase, signatures
and exact saved transaction. It creates no signatures, changes no journal rows,
releases no owner claims and does not activate Bunk in an app.
The [shared observed signer](BUNK-BITCOIN-APPROVAL.md) can now produce its stored
input under the strict one-input-per-owner policy. An uncertain claim never
becomes a fresh signing permission through this submission API.
An authenticated [read-only journal archive](BUNK-BITCOIN-JOURNAL.md#encrypted-history-archives)
can also supply the saved transaction. Submission never needs to make that imported
history writable or recompute a signature.

## Submission

Call `submitBunkBitcoinApproval` only after submission intent for the saved approval.
Supply an explicit positive maximum fee rate in satoshis per 1,000 virtual bytes.
The actual saved fee divided by the signed transaction's actual size must fit this
cap. The saved plan was independently checked against its absolute fee cap when
reserved. The RPC cap is serialized as an exact eight-decimal BTC/kvB string;
it is never disabled with zero. The burn allowance is explicitly zero.

Before sending, the helper opens a verified chain observation and checks the
saved transaction twice. If the exact transaction is already pending or canonically
included, it returns `already-observed` without rebroadcasting. Otherwise it calls
`testmempoolaccept` for those saved bytes and verifies transaction/witness IDs,
actual virtual size and base fee. A rejection returns `rejected` and a bounded
reason without sending. Malformed or contradictory results throw.

After the final chain/freshness check, `sendrawtransaction` sends those same bytes.
A matching acknowledgement returns `submitted`, with the preflight checkpoint.
This means submission was acknowledged, not that peers received it or a block
included it. Core31 private broadcast may acknowledge before local mempool appearance.

A transport failure, cancellation or bad acknowledgement after entering the send
step throws `BunkBitcoinSubmissionUncertain`, carrying the saved txid/wtxid.
The node may have received the transaction. Retain the signed journal and observe
before retrying; do not clear the claim, recompute a signature or replace fees.
Preflight and send are not atomic. A transaction mined between them can also make
the send result uncertain; subsequent observation resolves what the node can see.

## Status observation

`observeBunkBitcoinApproval` reads only the exact saved transaction and witness.
It verifies raw bytes, txid, wtxid, size/weight and canonical block metadata, then
repeats the observation and checks the pinned tip again. Its states are:

- `not-observed`: lookup returned Core's numeric -5 error. This can mean absent,
  dropped, never seen, missing txindex, or unavailable block data. It proves neither
  failure nor permission for a new signature. Other RPC errors propagate.
- `pending`: exact saved bytes were found without a block location.
- `included`: canonical inclusion below the caller's confirmation threshold.
- `confirmed`: canonical inclusion meets that threshold at this checkpoint;
  Bitcoin confirmations are not irreversible finality.
- `orphaned`: the saved bytes occur in an observed block outside the active chain.

Mined lookup generally needs a synced `txindex`, or the observer can accept a known
`blockHint`. The hint is checked, including active-chain status. Passing an obsolete
previous checkpoint rejects after a reorg; callers must reconcile deliberately
without discarding saved approvals. All result objects retain `signingAuthorized:
false`. The full node remains trusted; this is not an independent inclusion proof.

RPC adapters must preserve numeric error codes on thrown error objects. Timeouts
and arbitrary error strings must not be mapped to “not observed.” Transport should
bound response bytes/time. Native signing, device/import policy, fee-bump UI and
packaged-app integration remain launch work.

## Verification

Ten unit cases cover exact-byte preflight/send, bounded caps, existing-transaction
retries, confirmation thresholds/orphans, unavailable lookup, lost acknowledgement,
rejections, altered bytes/witnesses/fees, unsigned or mismatched approvals,
cancellation, checkpoint changes and caller mutation. No test authorizes a new
signature after a submission outcome.

[The Core31.1 + SQLite report](evidence/bunk-bitcoin-submit-regtest-local.json)
persists the public fixture's parent and child signatures through the encrypted
SQLite adapter, then reopens the DB in fresh processes for submission/observation.
The parent reaches the node before its response is deliberately lost; the retry
finds the exact pending transaction. The child is submitted from saved bytes,
observed below/at the confirmation threshold, observed in an orphaned block after
invalidation, and found pending again. The replacement block confirms the same
witness ID. An obsolete checkpoint rejects. Journal revisions and ciphertext hashes
remain unchanged during all submission/observation calls (parent revision 7, child
revision 11); retry branches do not invoke the fixture signer. All preceding
construction, fee, review, discovery and reorg checks also pass. Sixty-three source/
dependency hashes and the bundle were frozen/rechecked; the owned node stopped.
This proves local composition, not packaged-app or public-network readiness.

References: [Core31 sendrawtransaction](https://bitcoincore.org/en/doc/31.0.0/rpc/rawtransactions/sendrawtransaction/),
[testmempoolaccept](https://bitcoincore.org/en/doc/31.0.0/rpc/rawtransactions/testmempoolaccept/),
[getrawtransaction](https://bitcoincore.org/en/doc/31.0.0/rpc/rawtransactions/getrawtransaction/).
