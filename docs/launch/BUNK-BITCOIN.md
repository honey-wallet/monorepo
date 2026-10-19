# Bitcoin spend construction, discovery and remaining integration

`packages/keyring/src/bunk-bitcoin.ts` now constructs Bunk native-P2WPKH spends
using the existing, unchanged Bitcoin derivation branch. It exports unsigned
preparation, BIP143 `SIGHASH_ALL` digests, standard recipient script conversion,
dust calculation, and assembly/verification of already-authorized DER signatures.
It does not sign application approvals or authorize reuse of an owner key.

## Preparation and assembly

`prepareBunkBitcoinSpend(seed, request)` accepts the exact Bitcoin network, account
index, reserved fresh change index, verified UTXOs, payments, fee/dust rates in
**satoshis per 1,000 vbytes**, an absolute fee cap, and a height-based locktime.
Amounts are bigint satoshis. Transaction IDs and scripts use lowercase hex without
`0x`. Supplied UTXO scripts must match the phrase-derived owner at their stated index.

Selection groups all known coins by owner, then chooses the largest owner balance
first (owner index breaks ties). Coins within a group have deterministic value/outpoint
ordering. It never partially selects a known owner group, including when an input
limit would be exceeded. It
retains payment order, derives P2WPKH change, accounts for a conservative maximum
witness size, and drops dust change only within the caller's absolute fee cap.
It may select another input to create change rather than exceed that cap. It
rejects duplicate outpoints, invalid amounts, foreign scripts, invalid addresses,
payments to selected input addresses, and a change index that does not follow
known input indices. Limits are 256 candidate UTXOs, 100 selected inputs and
32 payments. This is bounded coin selection, not a claim to scan an entire wallet.

Supported recipient addresses are P2PKH, P2SH, native SegWit v0 (20/32-byte
programs) and Taproot v1. Checks enforce the proper Base58/Bech32/Bech32m checksum,
network prefix, witness version/length and mixed-case rules. Testnet and signet
address prefixes overlap; a trusted chain observer must distinguish the network.

The result includes selected coins, exact fees/change, the non-witness transaction,
stable transaction ID, per-input digests and `signingAuthorized: false`.
`assembleBunkBitcoinTransaction(transaction, signatures)` reconstructs each digest
from transaction fields, verifies strict low-S DER signatures, and returns raw
SegWit bytes, txid, wtxid, weight and vbytes. It appends `SIGHASH_ALL` itself.

The unsigned transaction ID alone is not an approval identifier: it omits previous
output amounts, which are part of the witness signature digest. A future journal
must bind verified input amounts, public keys, network, change reservation and
the whole transaction before permitting key use. The builder cannot prove UTXO
freshness, address allocation or absence of a previous local approval.

## Verified locally

Twelve tests cover the published BIP143 native-P2WPKH digest and deterministic DER
signature, recipient/dust rules, deterministic selection, fee limits, change,
invalid input data and signatures, and changed transaction fields.

[Bitcoin Core 31.1 regtest evidence](evidence/bunk-bitcoin-regtest-local.json)
checks the bundled shared client against an isolated node with no peers and only
public-fixture keys/test coins. Core verifies a three-input payment to Taproot with
fresh P2WPKH change: 288 vbytes, 290 satoshis fee. It verifies a child spending that
change with the next key: 141 vbytes, 705 satoshis fee. Both mine together; the
unselected original coin remains unspent. Altered input-value metadata and an
altered recipient both fail script verification. After invalidating the mined
block, both exact transactions return to the mempool and can be rebroadcast and
mined in a distinct replacement block without generating new signatures.

This original report demonstrates the child-pays-for-parent mechanism. The newer
observation report below additionally uses a calculated package fee. Neither is a
production fee-bump UI. It does not demonstrate signing a replacement
parent with a previously used key. The fixture signer is hardcoded to a public
phrase and regtest; it is not exported as an application signer.

Run with an explicit Bitcoin Core 31.1 binary:

```sh
node packages/keyring/scripts/bunk-bitcoin-regtest.mjs /path/to/bitcoind /tmp/bitcoin-evidence.json
```

The runner owns and stops its node and uses a new temporary datadir. It freezes
source/bundle hashes and records the executable hash. The macOS arm64 release
archive used here matched the official HTTPS `SHA256SUMS` entry
`16a097c09fbd7eb78b240ce1dae123663ea2e5e377cfd6a951e71e227e23cf2f`.
This is checksum verification, not an independent GPG/reproducible-build attestation.

## Seed-based confirmed-UTXO discovery

`discoverBunkBitcoinUtxos(seed, request, access)` derives an explicit page of up to
20 owner addresses and scans them through a caller-trusted Bitcoin Core node. It
uses public `raw(script)` descriptors with `scantxoutset`; it does not import keys
or require a Honey backend. Core must expose the coin metadata documented in its
31.x RPC interface. The transport supplies result values, enforces its own timeout,
and must permit a full UTXO-set scan. This can be expensive on a public chain.

The request binds network, account index, owner-index range and an optional prior
checkpoint. Access supplies a clock, maximum tip age and minimum confirmations.
The scanner checks the chain name and genesis, pins the tip, hashes its raw header,
validates scan totals/coin metadata and canonical block hashes, and cross-checks
every coin with mempool-aware `gettxout`. It checks the chain again before return.
Wrong networks, incomplete or oversized scans, inconsistent amounts/scripts,
changed tips, reorganized checkpoints, stale headers and RPC errors reject the
whole page. Cancellation fences further work/results and never sends a global
scan abort to a shared node. Seed-derived public targets are prepared before the
first await; the scanner's seed copy is wiped immediately afterward.

The existing v1 `testnet` namespace is pinned to **testnet3**. Testnet4 is rejected
and would need a distinct namespace. Signet additionally checks the standard
challenge because custom signets share its genesis. Regtest is only suitable for
an explicitly trusted local test node. These are consistency checks against a
trusted full node, not independent consensus or UTXO inclusion proofs.

Results retain empty addresses and every discovered confirmed coin, including
zero-valued, immature, underconfirmed and mempool-spent outputs. An owner group's
`available` flag is true only if every known confirmed coin passes the observation
policy. It is **not signing authorization**: incoming unconfirmed deposits and
previously spent outputs are outside this scan, and mempool reads are not atomic.
Reobserve before approval and submission. An empty result cannot establish that a
key is unused, allocate change, or recover missing signing history. The page has
an explicit next cursor, `inventoryComplete: false` and `signingAuthorized: false`.
An overfull page rejects rather than silently truncating at 256 coins.

Eleven discovery tests cover these boundaries. The separate
[discovery Core report](evidence/bunk-bitcoin-discovery-regtest-local.json) checks
repeated deposits, pending spends, mined change, checkpoint rejection after a reorg,
replacement-chain discovery and coinbase maturity at exactly 100 confirmations.
It also reruns the existing transaction construction/CPFP/rebroadcast acceptance.

## Pending inputs and package fees

`observeBunkBitcoinInputs(seed, request, access)` checks up to 100 explicit expected
outpoints, including known pending change. Each expected amount and script is
checked against the node and the phrase-derived owner. It shares the discovery
scanner's network, checkpoint, header and freshness checks through an internal
RPC module. Inputs are snapshotted and the owned seed copy is wiped before awaits.

Each output is reported as confirmed, unconfirmed, immature, underconfirmed or
unavailable. Unavailable means the node did not return that outpoint; it does not
distinguish spent, dropped, never broadcast or unknown transactions, and it must
never release a previous signing claim. Its retained amount is expected metadata,
not a verified current balance. Incoming deposits still require discovery/history
providers; observing a list does not establish that it contains every owner coin.

For pending inputs, the observer queries their mempool entries and ancestors,
validates parent-graph closure, rejects cycles/unrelated entries, and unions shared
ancestors by transaction ID. The bounded union allows at most 256 transactions.
It records witness IDs, vbytes, weights, actual base fees and parent IDs; local
mining-priority fee deltas are excluded. Relevant entries and output availability
are read again before return. A changed, evicted or inconsistent package rejects
the observation. This avoids requiring all unrelated mempool activity to stop;
it remains a time-bounded observation rather than an atomic reservation or relay
guarantee. Results retain `inventoryComplete: false` and `signingAuthorized: false`.

`estimateBunkBitcoinChildFee` takes that unique ancestor list, the proposed child's
conservative maximum vbytes, target package rate, minimum child relay/mempool rate
and absolute child fee cap. Rates use satoshis per 1,000 vbytes. It covers the greater
of the missing package fee and the child's minimum fee, then includes upward
integer-rate rounding so its returned rate fits `prepareBunkBitcoinSpend` without
silently exceeding the cap. Already expensive ancestors cannot reduce the child's
minimum fee. Recalculate if selection or output shape changes. The caller supplies
current policy rates; this does not predict confirmation time or bypass cluster,
package or relay limits. Keep the original parent bytes unchanged.

Twelve observer/fee tests cover pending, missing and confirmed outputs, ancestor
deduplication and consistency, cancellation/reorgs, fee units, rounding and caps.
[Core pending-input and fee evidence](evidence/bunk-bitcoin-observe-regtest-local.json)
uses a 289-vbyte parent paying 290 satoshis and computes a 1,861-satoshi child fee.
The 141-vbyte child brings the 430-vbyte package to 2,151 satoshis, meeting the
5 sat/vbyte target. Core accepts and mines it after a temporary parent priority
delta is removed. The observer reports actual base fees despite that delta,
rejects an incorrect expected input amount, sees the two-transaction ancestor
chain, switches to confirmed after mining, and returns to unconfirmed after a
reorg while rejecting the obsolete checkpoint. Thirteen source/dependency hashes
and the fixture bundle are frozen/rechecked; only local public-fixture coins are used.

## Spent and received history

`discoverBunkBitcoinHistory(seed, request, access)` scans up to 20 explicit owner
indices over a caller-selected window of at most 2,016 blocks. Core's basic filter
index finds candidate blocks; descriptor activity resolves false positives into
actual receive/spend events. Matching blocks must be canonical and inside the
requested window. The same chain/header/freshness/checkpoint checks used by UTXO
discovery apply. Missing index, unavailable block/undo data, incomplete scans and
oversized responses fail rather than silently yielding an empty history.

Each event retains its owner, script, amount, outpoint or spending input, and
confirmed block location (or `null` for pending). Incoming mempool outputs are
included even when the address has no confirmed UTXOs. Relevant mempool activity
is read twice and compared after normalization; this detects changes between the
observations but does not provide an atomic snapshot or reserve funds. Total
activity is capped at 4,096 events; callers can narrow windows/owner pages on overflow.
The RPC transport must also bound response bytes and enforce timeouts.

The response gives explicit block coverage/continuation and owner continuation.
`activityObserved: false` means no activity in this window and pending snapshot;
it does not prove the key has never been used. Consumers must scan every required
block window and owner page, handle reorg invalidation, and deduplicate pending
events repeated across pages. Window events are not a current balance. This API
does not choose a restore gap limit, reset a journal cursor or release a reservation.
Never-broadcast approvals and evicted/orphaned signatures cannot be reconstructed
from canonical history. Both `inventoryComplete` and `signingAuthorized` remain false.

Eleven unit cases cover spent/empty owners, pending receipts, range continuation,
false positives, malformed/inconsistent/duplicate activity, reorgs, freshness,
cancellation and caller/transport mutation. [The Core 31.1 history report](evidence/bunk-bitcoin-history-regtest-local.json)
finds ten confirmed receive/spend events across owners 0–4, including emptied
owners 0, 2 and 3. An empty early block window continues to the later page with all
ten events. Invalidating the spending block rejects its old checkpoint and returns
six events to pending status. A later 30,000-satoshi deposit to used owner 0 is
visible before confirmation. All existing construction, fee, UTXO and maturity
assertions also pass. Fifteen source/dependency hashes and the fixture bundle were
rechecked; the isolated node stopped. This is local public-fixture evidence, not
packaged-app restoration or public-network readiness.

## Fee policy and capped rate selection

`observeBunkBitcoinFeePolicy(request, access)` reads the trusted node's minimum
relay rate, current mempool minimum and incremental relay rate, plus an explicit
economical/conservative confirmation estimate. Every rate is converted exactly
from BTC/kvB to integer satoshis per 1,000 virtual bytes. Shared chain/header,
freshness and checkpoint validation applies; the policy fields are read again
before return. Unrelated mempool transaction counts do not invalidate the result.

The estimate retains its actual returned block target, which may differ from the
requested target. Missing estimates return `status: 'unavailable'` with bounded
diagnostics. RPC failures and malformed responses throw. Neither case is silently
replaced with a hardcoded fee. These observations do not promise confirmation or
future relay acceptance, and callers must refresh before approval/submission.

`selectBunkBitcoinFee(observed, budget)` chooses the highest of the estimate,
caller minimum and node relay/mempool minimum. An unavailable estimate requires an
explicit `fallbackRateSatPerKvB`; the result labels that source. Both the caller's
maximum rate and total-fee cap are enforced without clipping. The amount rounds
up at the supplied conservative transaction size. Recalculate if selection/output
shape changes, and pass the same total cap to `prepareBunkBitcoinSpend`: discarded
dust change can increase its final fee. Pending-parent inputs additionally require
the ancestor package calculation described above.

Incremental relay fees are reported separately, not added to ordinary sends or
treated as permission to re-sign an approved parent. These RPCs do not expose the
node's dust relay rate; the builder still requires an explicit dust policy. Both
APIs return `signingAuthorized: false`. Application wiring remains open.

Ten unit cases cover exact conversion/rounding, estimate targets, floors, explicit
fallback, caps, malformed data, changing policy, transport errors and observation
fences. [The Core fee-policy report](evidence/bunk-bitcoin-fees-regtest-local.json)
checks actual node rate fields, unavailable-estimate behavior and both cap failures,
then uses the selected 1,000-sat/kvB fixture fallback in the accepted parent.
Seventeen source/dependency hashes and the bundle were rechecked. Regtest does not
provide evidence of real-market fee-estimate quality.

## Decision and work still required

[Observed approval preparation](BUNK-BITCOIN-APPROVAL.md) now joins input-group,
pending-ancestor and fee-policy checks with exact-digest review and durable
reservation. It requires allocated change and preserved history, rechecks before
new reservation, and recovers the original stored approval after a lost response.
The shared strict signing coordinator now observes before/after claiming, signs
one digest per distinct owner and persists signatures before returning bytes.
Already saved signatures support offline exact-byte retries; uncertain claims
reject further signing. App activation remains separate.

[Saved transaction submission and observation](BUNK-BITCOIN-SUBMISSION.md) now send
only persisted signed bytes, retain uncertain outcomes, avoid rebroadcasting exact
transactions already observed, and distinguish acknowledgement from canonical
inclusion/confirmation. The journal stays intact through errors and reorgs.

The user has been asked whether “no key signs twice” means one **approved
transaction** per key, allowing that transaction's multiple inputs, or one distinct
signature digest per key. Bitcoin signs each input separately. Multiple payments
to one address therefore need multiple digests to spend together. The unsigned
builder can describe them; production signing policy remains pending that answer.
No elapsed-time assumption grants this exception.

The [durable allocation/approval journal](BUNK-BITCOIN-JOURNAL.md) now has encrypted
CAS storage and real SQLite crash/race evidence. Continue packaged signer integration
and safe history restoration,
including concurrent devices, interrupted signing, original-byte retries,
pending/unconfirmed coins, lost-history restore, and deposits to previously used
addresses. Add fee-bump UI and complete wallet/app/relay integration.
Do not declare Bitcoin Bunk complete from construction or regtest evidence alone.

References: [BIP143](https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki),
[BIP350](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki),
[Core 31.1 dust policy](https://github.com/bitcoin/bitcoin/blob/v31.1/src/policy/policy.cpp),
[Core scantxoutset](https://bitcoincore.org/en/doc/31.0.0/rpc/blockchain/scantxoutset/),
[Core gettxout](https://bitcoincore.org/en/doc/31.0.0/rpc/blockchain/gettxout/),
[Core mempool entries](https://bitcoincore.org/en/doc/31.0.0/rpc/blockchain/getmempoolentry/),
[Core mempool ancestors](https://bitcoincore.org/en/doc/31.0.0/rpc/blockchain/getmempoolancestors/),
[Core scanblocks](https://bitcoincore.org/en/doc/31.0.0/rpc/blockchain/scanblocks/),
[Core descriptor activity](https://bitcoincore.org/en/doc/31.0.0/rpc/blockchain/getdescriptoractivity/),
[Core smart fee estimate](https://bitcoincore.org/en/doc/31.0.0/rpc/util/estimatesmartfee/),
[Core mempool policy](https://bitcoincore.org/en/doc/31.0.0/rpc/blockchain/getmempoolinfo/),
[network parameters](https://github.com/bitcoin/bitcoin/blob/v31.1/src/kernel/chainparams.cpp),
[official release downloads](https://bitcoincore.org/en/download/).
