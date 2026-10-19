# V3 account signing and restore coordinator

Status: the shared keyring coordinator and encrypted SQLite adapter are implemented.
All 19 coordinator tests and the live bundler/process-death probe pass. Exact scope
and remaining gates are recorded in [validation](VALIDATION.md) and
[local evidence](evidence/bunk-v3-account-local.json). A shared [IndexedDB adapter and
phrase-derived encryption key](BUNK-BROWSER-JOURNAL.md) now pass browser tests.
Shared [paged account discovery](BUNK-ACCOUNT-DISCOVERY.md) is implemented.
Mobile/extension app integration, complete asset discovery, trusted production registry
and deployment remain open.

## One atomic account record

`packages/keyring/src/bunk-evm-v3-account.ts` is the application-facing API. It stores
the finalized checkpoint, recovery plan and current ordinary-owner journal in one
compare-and-swap record. Its key binds chain ID, the complete v3 key scope and account
address. There is no interval in which a separate recovery flag and owner journal can
commit independently. Revisions monotonically increase within the database.

The record has two phases: `restoring` and `ready`. Only `ready` permits ordinary
signing. A nested journal reserves one owner approval and up to 256 envelope leaves,
using `reserved → signing → signed` states. Claims are durable before computation;
signatures are durable before being returned. A restore replaces the account phase
atomically, preventing an in-flight ordinary signer from saving or returning its
signature. It cannot retract bytes that were already returned or stop a transaction
already executing; on-chain epoch cancellation has the limits documented in
[the v3 protocol](BUNK-SEED-RECOVERY-V3.md).

The nested per-owner format is version 2 with Bunk protocol 3 and includes recovery
epoch/root. Existing v2 journal format 1 and signing behavior remain unchanged. The
v3 per-owner primitives are internal building blocks: importing them directly does
not establish that a key is unused. The public keyring export exposes the account
coordinator. Offline v3 crypto primitives remain available for reviewed integrations.

## Restoring with missing history

1. Supply a trusted release configuration, proxy-code identity, account index and
   bounded trusted RPC transport. `startBunkV3Restore` derives deployment identity,
   verifies finalized chain/configuration and persists a fixed next-generation plan.
   It returns the account record key, review digest and whether bootstrap is needed.
   Use this explicit restore entry point after importing a backup **even if an old
   journal database survives**. A missing row never permits an ordinary approval.
2. If undeployed, `readBunkV3Bootstrap` returns only the exact signed factory call.
   The initial owner may already have signed a lost creation approval, so deployment
   alone does not make it safe to sign again. A funded caller deploys the fixed
   bootstrap; the coordinator waits for verified finalized deployment.
3. `signBunkV3Restore` requires the reviewed digest. It reserves the recovery signing
   claim, derives only the next epoch's owner zero and recovery key, and saves the
   signature before exposing the exact module transaction. A caller pays this
   transaction's gas. Honey sponsorship of this direct relay is separate from an
   ERC-4337 paymaster grant; the backend must implement that path and its fallback.
4. `refreshBunkV3Account` opens ordinary signing only after finalized state shows
   exactly the expected next epoch, owner zero, successor commitments and a
   nondecreasing EntryPoint nonce. A relay acknowledgement or submitted transaction
   hash is insufficient. A different generation or an already-advanced new owner
   requires another explicit, verified recovery rather than assuming that key unused.
5. The first resumed approval uses the new generation and the observed nonce. Recovery
   does not reset the EntryPoint nonce. The same Safe address and funds are retained.

This conservative path also applies to a new account with no durable history. It uses
caller-funded bootstrap and reset before the first ordinary sponsored action, rather
than reusing the potentially exposed initial owner. The existing counterfactual
ERC-4337 creation primitives remain tested, but this coordinator does not expose an
unsafe “empty history means new wallet” shortcut. Honey must account for the extra
direct transactions in the launch sponsorship/activation flow. The two transactions
are not an atomic relay batch; races and key-compromise limits still apply.

## Ordinary approval and reconciliation

`reserveBunkV3Approval` snapshots the reviewed call/gas/time fields before any async
RPC, refreshes finalized state and atomically stores one approval. Its returned owner
key must be passed to subsequent signing and envelope APIs. A concurrent owner or
generation change therefore cannot retarget the caller's reviewed approval.

`signBunkV3Approval`, `reserveBunkV3Attempt` and `signBunkV3Attempt` use only the current
journal and fresh verified state. Envelope fees/grants can change only through a new
unused leaf; leaf 255 retains the fixed expired-action cleanup rules. Saved bytes
can be loaded without signing through `readBunkV3Attempt` while that owner is current.

Reconciliation advances the checkpoint only to the recorded certificate's exact
successor, with owner index and EntryPoint nonce each increasing by one in the same
recovery epoch. The consumed journal is then retired. Unknown advancement does not
create a new empty signing journal. Current-state observation also rechecks the
previous finalized anchor's canonical hash, refusing backwards/reorganized history.
Finalized rotation proves consumption, not successful execution of the approved calls;
the application's operation history must still inspect outcome receipts/events.

This serializes ordinary approvals behind finalized rotation. A network's finality
latency therefore becomes user-facing: the UI must show a pending operation and must
not infer an available next key from a merely submitted or unfinalized transaction.
Release acceptance must measure that latency. Optimistic pipelining would require a
separately reviewed rollback/key-use design, not removal of the finalized-state gate.

## Crash reconstruction and persistence limits

Ordinary signing refuses `signing` slots that lack a saved signature. Explicit
`reconstructBunkV3Approval`, `reconstructBunkV3Attempt` and
`reconstructBunkV3Restore` require the reviewed original digest/hash. They compute
identical deterministic signature bytes and persist them before return. This follows
[review L15](REVIEW.md): one distinct approved message per key, not literally one
execution of the signature primitive. Repeated restore initialization cannot erase
an uncertain or signed recovery slot for the same fixed digest.

The existing SQLite adapter now accepts separate v3 owner/account namespaces. It
uses atomic conditional INSERT/UPDATE, WAL and FULL synchronization. XChaCha20-Poly1305
authenticates record key and revision under the unlocked vault key. Existing v2 AAD,
ciphertext format and table remain readable; no database migration is needed here.
Plaintext decoders enforce bounded canonical JSON, strict fields, exact protocol and
key scope, cryptographic signatures and nested-journal/checkpoint agreement.

Encryption and revision checks do **not** detect replacement of the entire database
with a coherent older copy. Backup import must force recovery, and platform rollback
protection remains required. A second device holding the phrase remains an authorized
signer; this local coordinator is not a distributed writer lease or revocation system.
SQLite filesystem power-loss behavior, Expo integration and the packaged extension
still require platform testing. The shared IndexedDB adapter has separate browser
crash evidence. The direct relay and recovery confirmation
must be integrated before enabling a Bunk toggle or moving user funds.

A changed or unavailable saved finalized anchor also fences explicit restore. A
network that rolls back finalized recovery epochs may reintroduce keys already
exposed on the abandoned history; simply clearing the checkpoint and deriving
`epoch + 1` is not a safe resolution. Network finality assumptions, historical-header
availability and catastrophic reorg recovery remain release-policy requirements.
