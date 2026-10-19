# Bitcoin address allocation and approval storage

`packages/keyring/src/bunk-bitcoin-journal.ts` stores Bitcoin address allocations
and exact approval state in one account record. It uses the existing encrypted
compare-and-swap store, with a separate `bunk-bitcoin-account:<hash>` namespace
accepted by the SQLite and IndexedDB adapters. Existing ciphertext formats and
other protocols' storage keys are unchanged.

This is durable storage for a signing coordinator. It does not compute signatures,
query the chain, authorize key use, or resolve the pending multi-input signing
policy. Every returned plan/artifact retains `signingAuthorized: false`.

## Initialization and allocation

`bunkBitcoinAccountJournalKey` binds the network, account index and phrase-derived
owner identity. Wallet labels and password changes cannot create a second journal
for the same account. Wrap the platform store with `encryptedBunkJournalStore` and
`deriveBunkJournalEncryptionKey`; destroy the wrapper when the vault locks.

`initializeBunkBitcoinJournal` requires `origin: 'new-wallet'`. This is an integration
precondition: call it only for a newly generated wallet, never as an automatic
fallback after import or missing history. If an account record already exists, it
is validated and preserved. Read/allocation/approval operations on a missing record
throw `BunkBitcoinHistoryRequired` rather than initializing cursor zero.

`allocateBunkBitcoinAddress` takes a stable 32-byte hexadecimal request ID, the
expected next index and purpose (`receive` or `change`). It commits the allocation
before returning the address. Retrying the same ID/index/purpose after a lost
acknowledgement returns the original allocation. A different request at a stale
cursor conflicts. Concurrent requests cannot both consume that cursor. Inputs and
seed buffers are copied before awaits; owned seed copies are wiped afterward.

## Exact approval lifecycle

`reserveBunkBitcoinApproval` takes an approval ID, a previously allocated change
token and a spend request. It runs the existing builder, retains all selected
coins in each owner group, and reserves those owner indices together. The caller
must already have verified live input state, complete owner groups and the user's
approval. No network observation is inferred from the storage write.

The approval digest binds account/network scope, change allocation, selected
outpoints/amounts/scripts, recipient payments, fee policy, locktime, unsigned bytes
and every input's signature digest. It is not merely the non-witness transaction
ID. Reload verifies reconstruction against the saved bytes/digests, so a changed
builder cannot silently reinterpret an earlier approval.

The phases are `approved → claimed → signed`. A claim is committed before external
signature computation. A repeated claim reports `BunkSigningUncertain`. A missing
signature after a crash does not release the owner or permit a competing approval.
`persistBunkBitcoinSignatures` accepts signatures only for the exact claimed plan,
verifies all DER signatures, and commits them before returning transaction bytes.
Saved signatures cannot be replaced even by different valid signatures for the
same digest. Reload returns the same transaction bytes and witness ID.

Cancellation is allowed only while `approved`, and races atomically against the
claim. Cancelled approvals release input reservations but permanently consume
their change token. Claimed/signed records retain owner claims after confirmation,
failure or reorg. Exact retries use the saved bytes; they do not replace the parent.

## Verified evidence

Twelve tests exercise encrypted storage, aliases, missing history, concurrent
allocation, lost acknowledgements, amount/fee binding, whole-owner reservation,
claim/cancel races, uncertain claims, signature validation, exact-byte retries,
alternative valid signature rejection, failed/committed signature saves, foreign
seeds, malformed records, ciphertext revision binding and caller-input snapshots.

[The SQLite process report](evidence/bunk-bitcoin-journal-restart-local.json) uses
only a fixed public fixture seed and temporary databases. Separate processes:

- Race address allocation and competing approvals: one CAS winner and one conflict
  in each case, synchronized after both processes have read the same revision.
- Exit with code 73 after computing a fixture signature but before saving it;
  a restarted reader retains the claim and rejects ordinary re-claim/cancellation.
- Explicitly reconstruct the same fixture digest, save it, then reopen and compare
  exact raw bytes in another process.
- Exit with code 74 after committing an allocation; retry returns index 4 while
  the next index remains 5.
- Exit with code 75 after committing signatures but before acknowledgement;
  reopening recovers the identical signed transaction.
- Refuse a missing account without inserting one, and verify ciphertext at rest.

The runner rechecks 54 source/dependency hashes. SQLite uses the shared WAL/FULL
adapter. This is actual process/database evidence; it does not prove device power
loss behavior, packaged mobile/browser persistence, or Bitcoin node acceptance of
the runner's synthetic outpoints. Separate [Core evidence](BUNK-BITCOIN.md) covers
transaction construction, observation and package fees.

Run under Node 22:

```sh
node --import ./packages/bunk-evm/test/bundler/typescript-loader.mjs packages/keyring/scripts/bunk-bitcoin-journal-restart.mjs run /tmp/bitcoin-journal-evidence.json
```

## Remaining launch integration

### Encrypted history archives

`exportBunkBitcoinJournalArchive(store, key, seed, random)` captures one atomic
account snapshot without changing the live journal. Its version-1 envelope has
format `honey-bitcoin-journal-archive`, account `key`, `revision` and base64 `data`.
Data holds a fresh 24-byte nonce and XChaCha20-Poly1305 ciphertext/tag. Encryption
uses the phrase-derived journal key; AAD is
`honey-bunk-bitcoin-archive-v1:<key>:<revision>`, distinct from local encrypted rows.
The recovered phrase can open an archive exported from an unlocked legacy
random-key source, but the source database itself is not migrated. No phrase or
private key is stored in the archive. Account identity and revision are public.

`openBunkBitcoinJournalArchive(archive, seed)` authenticates the envelope, bounds
its decoded record to 8 MiB and validates canonical account history against the
seed. It returns the account identity, revision and a **read-only** journal store.
Existing readers rebuild saved approvals and verify signatures. Saved signed
transactions can pass through the existing observation/submission APIs unchanged.
Every write throws `BunkBitcoinArchiveReadOnly`, including allocation, claiming
and signature persistence. Opening does not install rows into a writable database.
Call `store.destroy()` when locking the vault; retained JavaScript strings cannot
be reliably zeroized, but subsequent reads reject.

An old authentic archive may omit later approvals. Imports explicitly report
`historyComplete: false` and `signingAuthorized: false`; approved/claimed phases
remain recorded without becoming new signing permission. Preserve the live journal.
These APIs recover known history and saved transaction bytes; they do not resume
normal sends after device loss. [Version-3 password backups](BUNK-RECOVERY-BACKUP.md)
now authenticate supplied archives together with the phrase and discovery hints.
Latest-history/device authority, complete app collection, durable replication and
restore UI remain open.

Seven archive unit tests cover exact signed recovery, protected approval phases,
old snapshots, tampering/bounds, local-row domain separation, input snapshots and
closing. The signing suite also restores an archive before submitting its exact
saved bytes through mocked RPC. No Docker or blockchain node is used by these tests.

[Observed approval preparation](BUNK-BITCOIN-APPROVAL.md) now rechecks input groups,
pending ancestry and fees before storing an exact reviewed plan. Its strict
`signObservedBunkBitcoinApproval` coordinator now observes before/after claiming
and persists signatures before returning bytes. It allows only one input per
owner; multiple-input policy, uncertain-claim recovery and app vault lifecycle
integration remain open. This storage layer itself does not activate Bunk.
The [saved-approval submission/status APIs](BUNK-BITCOIN-SUBMISSION.md) now provide
exact-byte retries and canonical transaction observation while preserving the journal.

Phrase restoration still needs integration with the [bounded chain-history
scanner](BUNK-BITCOIN.md#spent-and-received-history) and an explicit missing-journal
policy. History now finds spent addresses and pending receipts, but cannot recover
never-broadcast approvals or prove that an empty address has never signed. Independent
device databases also require coordinated activation/import; sharing a phrase does
not share the local CAS lock. AEAD binds each record to its key and revision, but
cannot independently detect restoration of an entire old database snapshot.

This record format retains allocations and approvals. It refuses writes above
8 MiB and allocation into the final two derivation indices rather than dropping
history or wrapping. Read-only archival does not compact the active journal;
branch migration and scalable live-history storage are still required before those
limits. These remaining items are part of the full launch scope.
