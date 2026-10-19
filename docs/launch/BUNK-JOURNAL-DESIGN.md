# Bunk v2 durable signing integration

Status: the shared v1 journal format, signing coordinator, encrypted store wrapper
and atomic SQLite adapter are implemented, including explicit reconstruction of
uncertain signatures. Native/extension app storage integration, backup restoration
and device coordination remain open. The reconstruction policy below needs review.
No app activation is claimed. The requirements below remain the integration contract.

## Implemented behavior

`bunk-evm-v2-journal.ts` provides bounded canonical JSON with decimal bigint strings,
strict fields, seed-independent owner/envelope signature verification, certificate/
operation scope checks and an eight-MiB limit. It records the approved configuration,
finalized observation, certificate, public envelope signers and exact operation bytes.
The lookup key is the derived owner commitment, independent of wallet labels and
factory addresses, so another configuration cannot acquire a second reservation
for the same key. Existing reservations are never deleted or reset by these APIs.

Owner and envelope slots move from `reserved` to `signing` to `signed`. Preparation
runs before the atomic claim; only the winning claimant signs. Signed data is
returned only after storage succeeds. A later read reconstructs exactly the saved
bytes without signing. If a write fails after signing, the slot stays uncertain;
normal signing refuses a retry. Explicit deterministic reconstruction is described
below; it does not release the reservation or permit a different approval. A signature save merges only its claimed leaf if another leaf was reserved
concurrently, with bounded storage retries and no repeat signing operation.

`bunk-evm-v2-store.ts` implements SQLite compare-and-swap as single parameterized
INSERT/UPDATE statements with monotonic revisions, WAL and FULL synchronization.
The narrow async interface can be adapted to Expo SQLite; the app adapter is not
yet installed or exercised on a real phone. Tests use actual Node SQLite connections
and separate processes. A shared transactional IndexedDB adapter now passes
[real-browser crash and concurrency tests](BUNK-BROWSER-JOURNAL.md); packaged
extension integration remains open. Browser localStorage/read-then-write is not a replacement.

An optional wrapper encrypts records with XChaCha20-Poly1305 using an unlocked vault
key and authenticates the owner key plus revision. New phrase-restorable integrations
use the [dedicated seed-derived journal key](BUNK-BROWSER-JOURNAL.md).
Locking destroys its key copy.
Wrong keys, substituted owner rows and altered revisions fail authentication. This
does not detect a rollback of the entire database and revision together; independent
backup/chain/device reconciliation remains necessary.

Verification outcomes and live journal-backed bundler evidence are tracked in
[VALIDATION.md](VALIDATION.md).

## Authority and storage boundaries

A journal entry identifies its derivation version, exact network, account index and
owner index, and is keyed by the resulting owner commitment. It must not be keyed only by Safe address:
another factory/configuration can produce another address using the same derivation
tuple. Enforce one approved intent across all such addresses for that tuple.
The commitment is public metadata, never a mnemonic, seed or private key.

Persist a checked configuration identity, account, finalized block/hash, owner
commitment/nonce, canonical action bytes, certificate fields and the public envelope
tree. Public descriptors are not spending secrets, but approved actions and signed
operations are sensitive authorization data and should be encrypted at rest.
A bigint-safe, canonical, bounded serialization format is required; untyped JSON
from backup/relay must not become an approval.

Use storage transactions or compare-and-swap with a monotonically increasing
revision. An in-memory mutex, read-then-write sequence, browser storage event or
backend nonce check does not provide atomic reservation. App and extension storage
adapters must prove the transaction guarantees under concurrent processes/tabs and
crashes. The backend may coordinate public metadata but cannot become the sole
recovery store or hold signing keys.

## Owner and envelope transitions

1. Verify finalized chain/configuration and ensure there is no existing unresolved
   local reservation for the owner. Finality alone does not exclude pending work.
2. Atomically persist the exact user-approved intent preimage and its hash before
   generating a signature. Never overwrite that approval with a different one.
3. Persist the owner signature and public proofs before permitting envelope signing.
   A crash during this transition retains the reservation. The explicit reconstruction
   API can recompute only the identical deterministic signature for the persisted
   preimage under the candidate policy below; it never authorizes a different message.
4. Atomically reserve an ordinary leaf for the exact EntryPoint operation hash and
   bytes before signing. Persist the result before submission or return to a caller.
   Fee/grant changes require a new leaf. A retransmission uses the saved bytes.
5. Reserve leaf 255 only for deterministic post-expiry cleanup. Ordinary attempts
   cannot consume it. Clock/deadline, fees, calls, paymaster and deployment constraints
   remain enforced by the signer and contract. Ordinary cleanup requires an observed
   chain timestamp past the deadline; a fast device clock alone is insufficient.
6. A relay acknowledgement or timeout cannot advance the owner or release a leaf.
   Confirm through trusted receipt/rotation evidence and a finalized observation.
   Distinguish action success, failed action with consumed owner, and expired-action
   cleanup. Keep tombstones for prior reservations; do not reuse them after restore.

If persistence fails after signing, return an explicit uncertain state and do not
expose an operation as ready for submission. Cancellation/expiry does not delete an
approval. Recovery of uncertain state must use the same persisted approval and
reviewed deterministic-reconstruction policy, not a fresh approval under that key.

## Explicit reconstruction policy (candidate; review before activation)

The brief's literal “no key signs twice” cannot simultaneously promise recovery
from a crash between computing a signature and saving it: storage cannot determine
whether the cryptographic computation happened. A database transaction alone cannot
make a JavaScript cryptographic computation atomic with durable storage.

This candidate guarantees **one distinct approved digest per derived key**, allowing
explicit recomputation of the same deterministic signature bytes. This is a change
to the literal computation-count guarantee, not a claim that it was already met.
Normal `signReservedBunkV2Intent` / `signReservedBunkV2Envelope` still refuse an
uncertain slot. The app must not silently route retries through reconstruction.
Review decision [L15](REVIEW.md) remains open before activation.

- `reconstructBunkV2Intent(store, seed, key, expectedIntentDigest)` loads the original
  approval, validates the seed/account/next owner/public tree, and requires its exact
  digest. A `reserved` slot is rejected; use normal signing for its first claim.
- `reconstructBunkV2Envelope(store, seed, key, attempt, expectedUserOpHash, now, sponsor?)`
  loads the exact reserved operation and checks the expected hash. Call, fee, grant,
  initCode and purpose replacements cannot be supplied. Existing seed/proof/time/
  sponsorship checks still apply. An expired ordinary action or grant may therefore
  require a fresh leaf or reserved cleanup, rather than reconstructing that envelope.
- Both functions fence the loaded revision with CAS before computation, preserve
  the uncertain slot on failure and return only after the exact signature is durable.
  A competing recovery can compute identical bytes; a saved different signature or
  approval cannot be accepted as its result. Leaf persistence preserves other leaves.
- The pinned signer explicitly uses RFC6979 without extra entropy, low-S ECDSA and
  fixed recovery encoding. Independent golden bytes and restart tests pin this
  behavior; a signer/library upgrade must retain it or version the recovery policy.
  A saved signature is reused without cryptographic recomputation.

Owner reconstruction remains useful after expiry because the certificate supports
cleanup. Leaf 255 reconstruction retains the fixed no-calls/no-paymaster operation
and on-chain post-expiry restriction. Neither API advances the owner, submits an
operation, certifies current chain state, detects a rolled-back database, nor revokes
another device's signing authority. Backup/device rules below still apply.

`packages/keyring/scripts/bunk-journal-restart.mjs` tests three separate-process
paths: ordinary saved-byte replay, abrupt process exit at owner signature persistence,
and abrupt exit at envelope signature persistence. A fresh process recovers the
original golden bytes, then another reader verifies the saved result. This exercises
process death and SQLite reopening, not physical power loss or real mobile storage.

## Backup and devices

A [separate v3 Safe authority candidate](BUNK-SEED-RECOVERY-V3.md) now explores
recovery into a fresh generation without the lost certificate. Its phrase client and
[account restore coordinator](BUNK-V3-ACCOUNT-JOURNAL.md) are implemented separately;
platform/app/device integration remains open. This v2 journal cannot activate v3.


The existing v1 mnemonic-only backup is insufficient. A v2 recovery artifact must
preserve configuration/account discovery, approved certificate/signature, exact
reserved leaf hashes and signed operation bytes, with authenticated versioning and
bounded decoding. Restoring an older artifact must not silently unlock consumed or
reserved keys. Validate against chain state and newer durable replicas before use.
The reserved recovery envelope still needs its original certificate; seed derivation
alone cannot reconstruct arbitrary call hashes, gas caps and deadlines. A new archive
format by itself does not solve this: a static backup made before the latest approval
can omit the only usable certificate. A complete design must durably replicate that
approval before its first signature, or introduce a separately reviewed on-chain
recovery authority. Replica outages, backup lag and loss of the latest device must
be tested explicitly; exporting a file after signing does not close this gap.

Restoration must never treat missing leaf records as unused keys. If complete,
current reservation history cannot be established, ordinary leaf signing must remain
disabled. Exact saved operations and the certificate's deterministic leaf-255 cleanup
are candidates for recovery, subject to current finalized account state and funding.
This still requires the original certificate and does not establish exclusive device
control. A stale archive is evidence to reconcile, not authority to reset the journal.

A single active writer per derivation tuple is the initial integration target.
Pairing another device must transfer/acknowledge the complete journal and revoke
old writing authority before signing resumes. A device that may still sign offline
cannot be safely revoked merely by changing a Honey database flag. Do not claim
multi-device safety without a concrete coordination or on-chain authority protocol.
Read-only observation on other devices remains possible.

## Required evidence

Test racing intent allocations, racing leaves, restart at every persistence/sign/
submission boundary, storage rejection, duplicate submission, changed fee/grant,
expired approvals, all ordinary leaves exhausted, reserved recovery, stale backup,
conflicting device records, chain reorg/finality change and next-owner reconciliation.
Exercise the real storage adapters as well as the state machine. A memory-only test
store proves the transition logic, not durable app behavior.
