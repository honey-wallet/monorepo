# Browser journal persistence and encryption-key lifecycle

The shared keyring now provides `createBunkJournalIndexedDbStore` and
`deriveBunkJournalEncryptionKey`. These are integration building blocks; the
extension's packaged MV3 worker and mobile vault have not been wired to them.
The [account coordinator](BUNK-V3-ACCOUNT-JOURNAL.md) remains the signing entry point.

## Atomic storage

All wallet labels in one browser origin share database `honey-bunk-journal-v1`,
schema version 1, object store `journal`, key path `key`. Records contain only
`key`, `revision`, and opaque `value`. Existing v2 and v3 account/owner namespaces
are validated. Changing a label must not create another database or reservation.

Compare-and-swap reads and conditionally writes in one IndexedDB readwrite
transaction. It requests and verifies `durability: 'strict'` and resolves only
after transaction completion. Individual request success cannot release a signature:
the transaction can still abort. Unsupported durability, corrupt records, unexpected
schemas and failed writes reject without erasing history. Closing a connection aborts
active transactions and invalidates the handle; version changes do the same.
Open has a bounded timeout and closes any late connection.

Chrome's default durability is relaxed, so relying on the default is insufficient
for this contract. Strict completion requests durable storage, subject to browser,
OS and hardware behavior. See the [Chrome durability change](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed)
and [IndexedDB transaction specification](https://www.w3.org/TR/IndexedDB/).

## Key lifecycle

A newly generated vault data key is not reproducible from a recovery phrase. If
encrypted journal rows survive a password reset or fresh vault import, replacing
that key makes the old records unreadable before the coordinator can recover.
New Bunk integrations must use a stable, dedicated seed-derived journal key:

| Parameter | Fixed value |
| --- | --- |
| Algorithm | RFC 5869 HKDF-SHA256, extract then expand |
| Input | Exact unlocked 64-byte BIP39 seed |
| Salt, UTF-8 | `honey:bunk:journal:extract:v1` |
| Info, UTF-8 | `honey:bunk:journal:encryption:v1` |
| Output | 32 bytes |

This versioned namespace is separate from signing derivation. It is stable across
local passwords, wallet labels, account indices and networks. Existing authenticated
record keys and revisions prevent ciphertext substitution between those records.
The independent Python generator uses standard-library HMAC/SHA256 and the
[RFC 5869 extract/expand definitions](https://www.rfc-editor.org/rfc/rfc5869).
Two public vectors freeze the exact bytes; changes require a deliberate migration.
This does not migrate any existing random-key-encrypted deployment automatically.

After unlocking, open the raw store, derive the journal key, create
`encryptedBunkJournalStore(raw, key, cryptographicallySecureRandom)`, then wipe the
temporary key and seed. The wrapper retains its own key copy. On lock or session
replacement, destroy the wrapper and close the raw store; account operations must
also obey the application's session-generation checks. Never persist the raw key.

The seed-derived key makes history readable; it does not prove the current signing
key unused. Explicit backup import must still call `startBunkV3Restore`, including
when old rows survive. Missing/corrupt history must not be bypassed by silently
deleting rows. Password changes do not revoke a stolen phrase or a second device.

## Verified browser scope

`node packages/keyring/scripts/bunk-browser-journal.mjs <output.json>` builds a
public-fixture page, serves it on loopback, and starts isolated Chrome using a
temporary profile and a private debugging pipe. It never attaches to a user's
browser. Four process starts include two forced process deaths. Every reopen derives
the encryption key again from the public test phrase.

Fifteen cases cover two-tab reservation/update races and concurrent increments,
abort after request success, strict-durability downgrade, ciphertext/AAD, connection
closure, invalid keys/revisions/rows, incompatible schemas, version changes and late
open completion. They also check the coordinator's missing-history fence, actual v3
owner reservation races, and forced browser termination after owner/leaf signature
computation but before final persistence. Fresh processes retain uncertain slots;
normal retry rejects and explicit reconstruction yields the independent golden
signatures and exact 1,120-byte authorization. A final restart reads identical bytes.

[Recorded local evidence](evidence/bunk-browser-journal-local.json) includes the
actual Chrome version, exact source and bundle hashes and case results. Six key
lifecycle tests additionally cover independent vectors, seed/input validation,
buffer ownership, normalized phrase restoration and wrong-key rejection. The new
Ubuntu 24.04 browser CI job is defined locally; GitHub execution is not claimed.

## Remaining release gates

Actual packaged MV3 service-worker suspension/restart, application unlock/import/lock
flows, Expo SQLite filesystem behavior, storage eviction, physical power loss and
cross-device coordination remain unverified. A coherent whole-database rollback is
not detected by encryption or local revision counters. Different origins/profiles
do not share transactions. Phrase-derived encryption does not add phrase entropy.
Trusted account discovery/configuration, relay funding, chain finality, independent
review and app activation remain required. The browser suite exercises the v3
per-owner journal plus the missing-history gate; it is not a live-chain extension
restore test. The prior SQLite/Geth/Alto coordinator proof remains a separate snapshot.
