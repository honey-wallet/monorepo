# Bitcoin observed approval preparation

`packages/keyring/src/bunk-bitcoin-approval.ts` connects the unsigned builder,
chain observers, durable journal and a strict one-digest-per-owner signing
coordinator. App activation is separate. The Bitcoin multi-input signing-policy
question remains in REVIEW L19; the coordinator rejects multiple inputs from one
owner before claiming or signing.

## App sequence

1. Preserve the existing account journal and allocate change through the durable
   allocator. Missing history must enter restoration, never new-wallet initialization.
2. Construct a candidate spend with explicit payments, input amounts, fee rate,
   dust policy, absolute fee cap and locktime. Supply stable approval/change IDs,
   confirmation target/mode, caller rate limits, optional explicit estimate fallback
   and explicit consent policy for pending inputs.
3. Call `reviewBunkBitcoinApproval`. This reads the journal and node but makes no
   writes. Present its exact prepared transaction, amounts/fees, input status and
   fee-estimate source to the user. Retain `reviewDigest` with that presentation.
4. After approval, call `reserveObservedBunkBitcoinApproval` with the same request
   and `approvedReviewDigest`. It rebuilds/checks the digest, repeats observation,
   and atomically reserves the selected owner keys and change allocation. A changed
   plan, insufficient new fee policy or changed input group requires a new review;
   this API never silently reprices or substitutes inputs.
5. Call `signObservedBunkBitcoinApproval` with the same request, the approved
   `approvedReviewDigest` and the reservation's `approvalDigest`. It requires the
   existing approval, validates its complete plan, observes before and after an
   atomic durable claim, signs each distinct owner once, and persists verified
   signatures before returning bytes. Multiple inputs from one owner reject.
6. [Saved-approval submission/status APIs](BUNK-BITCOIN-SUBMISSION.md) then send or
   observe those exact persisted bytes after submission intent. Signing itself
   performs no broadcast. These APIs return `signingAuthorized: false`, granting
   no permission for another signature or general website-message signing.

The review digest binds the account storage key, stable IDs, canonical selected
spend, exact unsigned bytes, per-input signature digests, fee-policy constraints
and pending-input consent. Previous-output values are bound even though Bitcoin's
unsigned transaction/txid alone omits them. Unselected candidates do not alter
the selected-plan identity. The caller is responsible for connecting the displayed
digest to actual user consent; supplying a digest is not cryptographic proof of consent.

## Observation rules

All observations must agree on one pinned chain tip. Shared observers verify
network/genesis, raw header hash, freshness, canonical checkpoint and final tip.
The journal must match the network/account; inputs must be allocated and change
must have the requested allocated change identity.

Selected owners and change are scanned in bounded contiguous pages, with sparse
gaps skipped. Confirmed UTXOs are combined with pending receives from descriptor
activity. The exact observed input-owner inventory must match the builder's whole
selected groups. Omitted/late deposits reject rather than being left behind under
an owner key whose public key is about to be revealed. Unavailable confirmed coins,
pending spends by a selected owner, and observed funds/activity at the change
address also reject. The history call requires Core31's basic filter index and
matching block/undo data; it examines the current block and mempool, not an entire
restore history. Preserved allocation/approval history is therefore essential.

Known-input observation then rechecks availability, ownership and values, and
collects the union of pending ancestors. Pending inputs require explicit consent
and enough approved fee for the whole ancestor package. The approved rate must
still meet the freshly observed fee policy within the caller's maximum rate;
the builder independently enforces the absolute fee cap.

These RPCs and the later journal CAS are not one atomic transaction. A node remains
trusted for consensus/completeness; changes after observation remain possible.
Reservation does not promise relay, confirmation or current availability at a
later claim. The signer repeats observation around claiming; a later deposit or
chain change remains possible. Independent devices do not share the local CAS
lock. Missing-journal restoration, backup/device policy and UI integration remain
launch work.

## Retry and verification

If an ID already exists, reservation validates the exact requested stored plan
and returns its original phase/bytes without another RPC observation or write.
This handles a committed write whose acknowledgement was lost, including when the
transaction subsequently broadcasts and its inputs disappear. The result has
`resumed: true` and `observation: null`; it provides no renewed chain assurance or
permission to sign. Cancelled/claimed/signed phases are preserved.

The signer returns an already signed approval offline without observation, writes
or signature computation (`resumed: true`, `observation: null`). A `claimed`
approval throws `BunkSigningUncertain`. Failure after claiming, including a failed
second observation, cancellation or signature-save failure, leaves that claim
intact. There is no automatic claim reset or signature reconstruction. If saving
committed but its acknowledgement was lost, the next call reads the saved bytes.
Temporary seed and private-key buffers are cleared; the caller still owns its
input seed and must protect it through the normal vault lifecycle.

An uncertain claim can leave an owner unavailable. Recovery/reconstruction policy,
Bitcoin history restoration and device coordination remain release work. Do not
claim the strict signer completes Bitcoin recovery or resolves REVIEW L19.

Nine tests cover read-only review, exact-byte reservation, altered consent/fees/
payments, incomplete or late owner deposits, unavailable inputs, change activity,
pending consent/package fees, lost acknowledgements with offline retry, concurrent
reservation, cancellation/tip/history failures and caller-buffer mutation.
The existing journal's SQLite proof covers durable storage separately.

Eleven additional normal unit tests cover signing distinct owners, the strict
multiple-input rejection, digest/consent binding, changed inputs/fees before and
after claim, claim/save failures and lost acknowledgements, competing signers,
caller-buffer mutation, cancellation and exact signed bytes through the submission
API. All 20 tests in this suite pass using in-memory stores and mocked RPC replies;
no Docker/node run is claimed for this coordinator.

[The Core31.1 composition report](evidence/bunk-bitcoin-approval-regtest-local.json)
verifies review and reservation of a three-input confirmed parent and its one-input
pending child. Reserved bytes equal the transaction bytes that Core accepts/mines.
The child review verifies the parent's actual fee/size package; missing pending
consent rejects. Omitting a repeated deposit to the parent's owner rejects as an
incomplete group. Existing fee, signature, history, reorg and maturity checks pass.
The proof uses in-memory CAS journals for composition, not persistent databases;
the SQLite crash/race proof remains separate. All 61 source/dependency hashes and
the bundled fixture were frozen/rechecked. The isolated node stopped.
