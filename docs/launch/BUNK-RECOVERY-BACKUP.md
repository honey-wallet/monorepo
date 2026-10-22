# Encrypted Bunk recovery backup

Bitcoin was removed on 2026-10-22, together with the version-3 file that carried
Bitcoin journal archives. Version 2 below is the only Bunk backup format. Importing an
older version-2 file silently drops any `bitcoin-v1` hints and keeps the phrase and
EVM/Solana hints.

## Version-2 discovery backup

`encryptBunkBackup(phrase, hints, password, random)` produces a version-2 Honey
backup containing the normalized phrase and bounded Bunk discovery metadata in one
authenticated ciphertext. `decryptBunkBackup(file, password)` opens this format or
the existing version-1 phrase backup. `isBunkBackup` recognizes and bounds version 2;
existing `isBackup` continues to recognize version 1.

The existing `encryptBackup`/`decryptBackup` APIs and format remain unchanged.
Older applications reject version 2 instead of silently importing its phrase and
discarding Bunk account locations. The new APIs are exported by the shared keyring;
mobile cloud backup and extension vault still use the existing APIs until their
separate integrations are updated.

## What is preserved

`BunkRecoveryHints` has exactly `version: 1` and `accounts`, with at most 1,024
unique account entries. Each entry includes `accountIndex` and one of:

- `family: "evm-v3"`, canonical decimal `chainId`, and the existing 32-byte
  deployment `keyScope`. This identifies the trusted registry configuration without
  relying on a mutable display label or importing contract code hashes as authority.
- `family: "solana-v1"`, the full `genesisHash` and `program` address. This refers
  to wire protocol v1; the existing derivation version is still 2.

Indices span the existing hardened 0–2,147,483,647 range. The validator rejects
duplicates, unknown fields/protocols, invalid identities, sparse JavaScript arrays
and unsupported versions, and copies the validated input. Empty lists mean no
locations were supplied, never that no further accounts or addresses exist.

These are locations to inspect, not trusted owner counters, checkpoints, signatures,
pending approvals, unused-key proofs or a complete inventory. No derivation path
changes. A hint can refer to an account unrelated to the phrase; the existing
discovery/restore code must verify that relationship from the derived identity and
observed authority. The loader never supplies a fallback deployment configuration.

## Encryption and import behavior

Exports use the existing password KDF (`scrypt`, N=65,536, r=8, p=1), 16-byte random
salt, 24-byte random nonce and XChaCha20-Poly1305, with separate associated data
`honey-backup-v2`. Supply a cryptographically secure random callback. The phrase and
all discovery hints are encrypted together. The header's `createdAt` is display
metadata, not authenticated freshness or a safe basis for deciding signing state.

Import bounds the envelope and KDF before expensive password work, requires
canonical base64, and caps decrypted content at 512 KiB. It snapshots the envelope
before awaiting password derivation. Version relabelling cannot authenticate under
the other version's associated data. Wrong passwords/modified ciphertext reject;
authenticated but unsupported payloads also reject rather than drop fields.

Export snapshots hints before asynchronous work and copies random callback buffers.
Version-2 encryption/decryption wipe their temporary byte buffers and derived key
in `finally` paths. JavaScript phrase/password strings and returned contents remain
caller-managed; this is not a guarantee that every copy disappears from memory.

Imported results always carry `inventoryComplete: false` and
`signingAuthorized: false`. Legacy imports have `bunk: null`, distinct from an
explicit empty version-2 account list. Neither kind of import initializes a fresh
signing journal or grants ordinary signing permission.

## Required application restore flow

1. Decrypt after explicit user import. Preserve all hints, including currently
   unsupported network locations, in the app's recovery workflow. Unknown protocols
   require a compatible importer; do not silently discard the file's metadata.
   Retired `bitcoin-v1` hints are the one exception: the importer drops them.
2. Resolve EVM key scopes and Solana program identities against the independently
   trusted [release registry](BUNK-RELEASE-REGISTRY.md), including restore-only
   entries. Missing releases are unresolved accounts, not zero balances. A backup
   does not establish its own registry pin.
   Use `resolveBunkRecoveryHints(contents.bunk, registryJson, appTrustedSha256)`
   after `decryptBunkBackup`. The shared resolver authenticates the registry and
   returns one ordered result per hint: `evm-v3`, `solana-v1` or
   `missing-release`. Matched entries preserve their active/restore-only policy.
   It also retains the full registry for discovery beyond the supplied hints.
   Legacy `null` hints and an empty version-2 list remain distinguishable through
   `hintsPresent`; both return incomplete inventory and no signing authority.
3. Scan explicit pages starting at the supplied sparse indices with the existing
   [discovery APIs](BUNK-ACCOUNT-DISCOVERY.md). Permit additional ranges; hint absence
   and an empty first page cannot prove complete recovery. Inspect other known
   releases and asset types as required.
4. For EVM/Solana, enter the explicit restore coordinator even if old local journal
   rows survive. Observe finalized chain state and complete the generation reset
   before ordinary signing. A backup restored onto an old database is still an import.

Persist updated hints after account/address allocation and refresh the exported
backup when the user chooses. A stale static file can omit later indices; no format
can discover an arbitrary missing sparse index cheaply from a phrase alone.

## Evidence and remaining gates

Eleven new tests cover production-KDF export/import, legacy imports, old-reader
rejection, tampering/passwords/version binding, asynchronous snapshots, malformed
authenticated payloads, bounds, random-buffer copying, terminal/sparse indices,
duplicates and retired Bitcoin hints. The six existing backup tests also
pass. Fixtures contain public test phrases; no live wallet or cloud account is used.

The actual-validator runner also exercises a file export at account index 10,000
and fresh-process import through discovery and the encrypted SQLite restore
coordinator. It generates a local registry from the independently checked deployment,
pins its exact bytes separately from the backup, and marks that release restore-only.
Wrong passwords, modified registry bytes and missing release entries must reject
before a journal file is created. The earlier crash/retry/CPI checks remain enabled.
Run with Node 22 and the existing Solana toolchain from the repository root:

```sh
node packages/keyring/scripts/bunk-solana-validator.mjs /private/tmp/bunk-backup-evidence.json
```

This command uses public fixture keys, a temporary encrypted database and an owned
loopback validator. It creates no cloud files or public-network deployments. Run
results and remaining limits are in [validation](VALIDATION.md) and the
[passing Agave/SQLite report](evidence/bunk-solana-backup-validator-local.json).
That run retains 19,000,000 lamports at the same PDA through generation recovery,
including a deliberately interrupted recovery signature and exact reconstruction.
A local validator
does not establish physical-device, public-provider or app acceptance.

The [EVM bundler runner](../../packages/bunk-evm/test/bundler/README.md) exercises
the same file/registry boundary with the Safe v3 coordinator at index 10,000. Its
worker derives journal encryption from the imported phrase, handles a prefunded
undeployed Safe and lost creation approval, and retains crash/reconstruction,
finalized recovery, deposit/nonce and sponsored-resumption checks. This uses newly
created fixture journals; it does not migrate existing random-key databases.

The new EVM backup coordinator has passed syntax/lint checks only. The attempted
full run stopped earlier in the existing v3 client because its local RPC refused
connections; it never reached this coordinator. No new passing EVM backup evidence
was produced. Further Docker/local-chain runs are deferred at the user's request.

Both chain fixtures now use the shared hint resolver. Seven normal unit tests
cover its matching, missing identities, legacy/empty metadata, independent pins,
duplicate rejection, input copying and a real encrypted-file round trip. The
earlier Solana validator report predates this refactor; neither fixture has been
rerun on a chain with the resolver. No Docker or local nodes are required by these
unit tests.

App hint collection, encrypted local persistence of hints, cloud file selection,
registry resolution, restore UI and packaged-device round trips remain required.
Multi-device coordination and whole-backup rollback policy remain separate gates. Complete wallet recovery and production readiness
still require these integration steps.
