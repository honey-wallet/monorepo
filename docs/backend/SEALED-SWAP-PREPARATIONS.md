# Encrypted swap preparation and recovery

Status, 2026-10-18: immutable **built swap signing requests** can now be encrypted
and atomically persisted, recovered by their owner and used by the existing signed
submission/dispatch/reconciliation repositories. No Uniswap HTTP signing endpoint,
provider build service or automatic swap worker is enabled. Pre-build review/permit persistence is implemented separately in
[SWAP-PERMIT-LIFECYCLE.md](SWAP-PERMIT-LIFECYCLE.md); internal construction is documented
in [UNISWAP-BUILDS.md](UNISWAP-BUILDS.md). HTTP/worker signing remains unfinished.

Implementation: `apps/server/src/preparation/sealed.rs`, preparation/submission
repositories, and migration `202610180008_sealed_preparations.sql`. Decisions D71–D72
record the tradeoffs. No dependency, client response type or environment variable
was added. Existing operator-supplied application data-encryption keys are reused;
these are not wallet signing keys.

## Why transaction encryption was insufficient

The router's PermitSingle command includes an EIP-712 signature before the wallet
signs its Ethereum transaction. Saving that call in `operation_preparations` or
`evm_signing_requests` as plaintext would expose a still-live authorization even
though the later signed transaction is encrypted. Therefore both generic plaintext
preparation entrypoints reject `provider=uniswap`. Plaintext legacy Uniswap records
are not accepted as a recovery/signing source either. Aave/Morpho continue using
their existing immutable representation.

The new `persist_sealed_swap_preparation` entrypoint accepts only Uniswap and
requires complete, structurally valid `PreparedEvm` signing terms. It shares the
existing transaction and job/operation lock order. Owner, chain, action, intent
hash, operation version, live lease, simulation age and expiry are checked before
insertion; lease/expiry are checked again at the final state write. The encrypted
row, `awaiting_signature` transition, completed preparation job and successor job
commit together. Concurrent installs have one winner. An exception rolls back all
of them. Requoting or extending deadlines requires a new reviewed operation.

This repository method is an internal service API, not a financial validator.
The caller still owes full router economics, quote/provenance binding, Permit2
verification, code/account/nonce/allowance checks, simulation and gas policy.

## Representation and authentication

Exactly one database representation is allowed:

| Representation | Persisted data |
| --- | --- |
| Existing Earn/public preparation | Original canonical JSON/hash/expiry; no sealed columns |
| Sealed swap | Null canonical JSON; public summary/hash, full request hash, key ID, 24-byte nonce and ciphertext |

The entire canonical `PreparedEvm` is encrypted, including all calls, embedded
permit, nonce, gas limits and fee terms. It is not duplicated into the plaintext
signing-request table. The original plan integrity hash is preserved for signed
transaction verification and receipt reconciliation.

Encryption uses the existing [RustCrypto XChaCha20Poly1305](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/)
implementation, a fresh OS-random nonce, and a versioned associated-data tuple:

```text
["honey.evm.swap-preparation.v1", operation UUID, user UUID, wallet UUID,
 plan SHA-256, public-summary SHA-256, complete-request SHA-256, key ID]
```

The separate domain prevents substitution with signed-transaction ciphertext.
Operation/principal binding rejects transplantation even when two operations have
identical intent and plan hashes. Binding the metadata and key ID prevents a
privileged database edit from changing execution terms merely by recomputing an
unkeyed checksum or renaming a key with the same bytes.

Opening verifies AEAD, request hash, canonical encoding, signing-term structure,
full plan hash, current wallet/chain identity and exact correspondence with the
stored public summary. Unknown keys, wrong key bytes, tampering or malformed data
fail closed. Key rotation selects a new writer while retaining old decrypt keys;
immutable ciphertext is not rewritten. The existing four-key bound still applies.

`EvmCall` debug output redacts calldata, and owned calldata strings wipe on drop.
Canonical JSON output and its intermediate string values, decrypted payloads,
decoded signed bytes and comparison buffers are wiped when their owners drop.
This is bounded best-effort memory handling, not a claim that every allocator,
serde/parser intermediate, third-party transaction object or JavaScript copy can
be erased. No signatures or signed bytes belong in telemetry or error messages.

## Recovery and durable submission

The existing authenticated operation recovery route returns the same public
`PreparationSummary`; no client schema change is needed. It reads no ciphertext
and requires no encryption key. Its metadata is checksummed database evidence,
not cryptographically authenticated signing authority: an attacker who can rewrite
both summary and checksum could falsify a display. `executionAvailable` remains
false, and any signing/execution read must authenticate the full encrypted record.

Owner-scoped `load_sealed_swap_preparation` returns historical exact signing terms.
Expired records stay readable for diagnosis/reconciliation without being renewed.
`load_preparation_with_keys` supports both sealed swap and existing Earn records;
submission acceptance and reconciliation now use it. Reads use the existing
recovery query plus one scoped record query, not a chain of recursive loaders.

The signed-transaction repository binds exact bytes to the immutable plan and, for
sealed swaps, independently enforces the persisted nonce, gas limit and both fee
rates. A valid envelope under the overall fee ceiling cannot silently change the
reviewed signing terms. The same exact-term helper is used by Earn. The repository
serializes competing wallet submissions, reserves nonces, encrypts transactions
and atomically journal an initial dispatch. A recorded but unobserved send retains
`unknown` state and the wallet guard. Encryption does not grant retry permission.

## Bounds and migration

The router decoder accepts at most 64 KiB calldata. The original generic 4 KiB call
bound would otherwise silently reject legitimate mixed routes after validation.
Only a Uniswap action now gets the 64 KiB bound; its approval calls and other
providers retain 4 KiB. A Uniswap canonical plan is bounded at 192 KiB and the full
sealed signing request at 256 KiB. Its EIP-1559 envelope is bounded at 65 KiB,
allowing 1 KiB for encoding/signature overhead. Non-swap envelopes retain 8 KiB.
Ciphertext bounds add the 16-byte authentication tag. Eight-call, command, hop,
integer, gas and network-fee bounds remain independently enforced.

Migration 8 is additive for preparation data: it makes the plaintext column
nullable, adds mutually exclusive sealed fields and widens the signed ciphertext
constraint. It does not rewrite existing Earn JSON/hashes or copy them into a new
table. It requires short schema locks and an explicit operator migration. Drain
old APIs/workers before enabling sealed writes because old binaries cannot read
the new representation. Authenticated readiness now requires migration 8.
No migration was applied to a production database during this work.

Encryption increases storage/CPU cost, especially for maximum-size routes, and
missing historical keys block execution recovery. Small typical swaps and bounded
operation frequency must be included in the eventual mixed-user capacity workload.
This implementation adds no 10,000-user capacity claim.

## Verification and remaining work

`tests/sealed_preparations.rs` covers two pure tests and seven disposable-PostgreSQL
tests: plaintext refusal, concurrent installation, restart/key rotation, principal
isolation, exact signed submission, duplicate submission, ambiguous dispatch guard,
reconciliation reconstruction, ciphertext/metadata/key-ID corruption, cross-operation
substitution, immutable rows, transactional rollback, full-size payloads, expiry,
authenticated HTTP redaction and migration with populated Earn records. The
encrypted tests are added to the PostgreSQL CI job. Signed fixtures are generated
offline by existing viem with public scalar 1; they are storage tests, not provider
execution or fresh Permit2 admission evidence.

Next: fresh chain admission, local sequence simulation and reviewed build-to-preparation
transition (review/permit storage and internal build transport are implemented),
fresh chain/simulation admission, then Uniswap HTTP/worker and native signing flows.
The [actual-contract fork harness](UNISWAP-CONTRACT-ACCEPTANCE.md) remains separate;
it must ultimately exercise the full durable service through restarts and finality.
