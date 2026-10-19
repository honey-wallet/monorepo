# Solana signing journal and finalized observer

**Threat-model limitation:** [recovery-target preemption](RECOVERY-TARGET-PREEMPTION.md)
requires control of the current signing key, which already grants spending authority.
Recovery under active key compromise is not a launch guarantee. This finding alone
is not a launch blocker; normal seed restore and interrupted-operation checks remain required.

`bunk-solana-journal.ts` coordinates the shared phrase client through one durable
account record. The existing encrypted SQLite and IndexedDB adapters accept a
separate `bunk-solana-account:<hash>` namespace; existing EVM keys, ciphertext
associated data and stored formats are unchanged. The record key binds genesis,
program and wallet, independent of UI labels and supplied deployment-code metadata.
Changing a release's code or upgrade policy requires explicit migration.

## Verified chain access

`bunk-solana-observe.ts` requires a caller-supplied trusted release: genesis,
program/program-data addresses, exact binary hash/length and expected upgrade
authority (including null for immutable). It reads program, program data and wallet
in one finalized `getMultipleAccounts` response; checks loader/account layouts,
code bytes and padding, upgrade authority and wallet PDA/state; then checks the
returned slot's finalized block hash/time and genesis again. A saved checkpoint
is rechecked before accepting a newer one. Old, missing, changed or future anchors
reject. Prefunded system-owned empty PDAs remain undeployed.
[Account snapshots](https://solana.com/docs/rpc/http/getmultipleaccounts),
[block metadata](https://solana.com/docs/rpc/http/getblock).

This verifies consistency against a trusted RPC; it is not a cryptographic proof
of account state. No trusted production registry or RPC is provisioned by these
primitives. Missing history and unavailable block metadata stop signing. RPC
numbers outside JavaScript's safe integer range reject rather than round; very
large balances require a deliberate lossless RPC transport. Program accounts are
bounded in size, and the observer checks freshness again after its final RPC call.

## Account lifecycle

1. `startBunkSolanaRestore` records a fixed recovery plan. Existing accounts enter
   restoring mode even when older local records survive an explicit import. An
   undeployed account first authorizes its deterministic initialization, then must
   reset to a fresh generation before ordinary signing. This also handles a lost
   pending creation approval without treating missing history as a fresh owner.
2. `signBunkSolanaApproval` verifies the current release/state/checkpoint, atomically
   changes the selected slot from reserved to signing, computes the exact Ed25519
   signature, then saves it before returning the proof and instruction. A CAS loss
   or storage error returns no newly computed signature. Normal calls refuse a
   signing slot without a saved signature.
3. Explicit reconstruction can recompute only that stored digest's deterministic
   signature. It claims another revision and saves the bytes before return. This
   implements the reviewed candidate policy of one distinct digest per key, not a
   claim that a signature can only be computed once across crashes.
4. `refreshBunkSolanaAccount` grants ready status only after finalized state matches
   the planned new generation. It preserves monotonic epoch/nonce/index observations
   and rejects unexpected transitions. Ordinary index/nonce changes do not alter
   the recovery digest; fresh current-owner account metadata is rebuilt without
   changing its digest.
5. `reserveBunkSolanaAction` requires ready status and matching finalized state.
   It snapshots the input, stores one exact action/window/digest and rejects a
   different approval for the same owner. A failed Solana transaction keeps that
   reservation. Retries reuse the saved proof with a separately funded transport.
   Expiry requires independent generation recovery, never a replacement digest.

All bootstrap/recovery/ordinary slots share one CAS revision, so an explicit restore
can invalidate a competing in-flight local signer before its signature is exposed.
Previously returned approvals can still race recovery on chain; adversarial target
preemption is the compromised-key limitation above. State advancement authorizes the next
key; it alone does not prove a particular trade's semantic outcome. Applications
still need transaction/settlement reconciliation for user-facing results.

## Storage and integration limits

The store must implement genuine atomic, durable compare-and-swap across all local
processes. SQLite uses WAL/FULL synchronization; IndexedDB requires strict durability
and resolves writes on transaction completion. Encrypt records with the existing
phrase-derived journal key and destroy the unlocked wrapper when the vault locks.
Authentication covers record key/revision, but does not detect whole-database or
device backup rollback. Different devices with the same phrase can still authorize
competing actions; generation recovery does not revoke a stolen seed or old device.

These APIs do not deploy a release, provide a sponsor, simulate every action, set
transaction fees or prove packet bounds for arbitrary CPIs. Keep program validation,
simulation, fee/rent review and the complete serialized transport in the submission
flow. App/extension adapters, multi-device policy, public-network acceptance,
bounded account/asset discovery and independent review remain required.

Current tests and actual-validator evidence are recorded in [VALIDATION.md](VALIDATION.md).
The [encrypted-backup acceptance run](evidence/bunk-solana-backup-validator-local.json)
also restores sparse account index 10,000 from a version-2 file in fresh processes,
using a separately pinned restore-only release and a new encrypted database. It
preserves the existing crash/retry/reservation-race checks; packaged app integration
and cross-device policy remain open.
