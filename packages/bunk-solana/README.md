# Honey Bunk Solana candidate

**Threat-model limitation:** [recovery-target preemption](../../docs/launch/RECOVERY-TARGET-PREEMPTION.md)
can prevent a fixed reset when an attacker controls the current signing key.
Recovery under active key compromise is not a launch guarantee. Normal seed restore
and interrupted-operation validation remain required.

Native Rust program for stable-address owner rotation and independent generation
recovery. This is an isolated workspace: root Cargo commands do not test this
program. No production program ID, deployment, upgrade authority, client activation
or audit approval is supplied.

## Local acceptance

Pinned direct dependencies: `solana-program 2.3.0`, `solana-system-interface 1.0.0`;
runtime tests use `LiteSVM 0.7.1` with locked Agave 2.3.13 and `solana-sdk 2.3.1`.
The lockfile belongs to this workspace. The test helper is not a deployment artifact.

With dependencies cached (`cargo fetch --locked` in this directory if needed),
Solana SBF CLI 3.1.11, platform-tools 1.52, Python 3 and OpenSSL available (install
the platform tools separately with `cargo build-sbf --install-only --tools-version v1.52`):

```sh
python3 scripts/acceptance.py --output /tmp/honey-solana-evidence.json
```

This checks three independent Python/OpenSSL vectors, Rust formatting, both SBF
builds, Clippy with warnings denied, and runtime tests. It records source hashes,
binary hashes and tool versions. Tests load the actual `.so` into LiteSVM, with
transaction and Ed25519 precompile verification enabled. They do not substitute a
native processor. The command makes no network or deployment calls.
Both SBF builds pin platform-tools 1.52 and disable tool installation/network
access; missing tools must be prepared before running acceptance.

`.github/workflows/bunk-solana.yml` runs this suite for program/workflow changes.
Its setup verifies the Agave 3.1.11 Linux archive against the SHA-256 published in
the [official release assets](https://github.com/anza-xyz/agave/releases/expanded_assets/v3.1.11),
then prepares tools and locked dependencies before the offline test phase. It
starts no Docker service or validator. The workflow's first hosted run still
needs verification after push; local acceptance is not evidence that CI has run.

The runner explicitly compiles with `BUNK_SOLANA_GENESIS_HEX=07…07` (32 bytes), a
**public fixture identity**, and uses public deterministic fixture keys. Never fund
these keys. A manual build must supply the intended full 32-byte genesis hash as
64 hex digits; an absent/zero/malformed value fails the build. Real release builds
must pin a distinct trusted program deployment per cluster and verify the actual
RPC genesis. The program has no native runtime query proving its host's genesis.
Copying a binary to another cluster does not establish correct network provenance.

For an actual isolated Agave validator run, also install `solana-test-validator`
3.1.11 and run from this directory:

```sh
python3 scripts/validator.py --output /tmp/honey-solana-validator-evidence.json
```

This starts an owned loopback validator with public fixture keys and an isolated
CLI configuration, reads its genesis, rebuilds into a temporary output directory,
and deploys an immutable **local-only** program. It verifies the deployed bytes
and absent upgrade authority, then checks finalized native/recovery/SPL transactions,
rollback and identical-authorization retries with different recent blockhashes.
Negative simulations are explicitly distinguished from included failures. Each
serialized transaction must fit 1,232 bytes. Source hashes are checked before/after;
the earlier fixture binary is preserved. The runner stops its validator and deletes
its disposable ledger, retaining logs and build artifacts. It never reads a user's
CLI keypair or connects to a public cluster. See [validator evidence](../../docs/launch/evidence/bunk-solana-validator-local.json).

## Account and message format

Wallet PDA seeds: `wallet-v1`, deployment identity (32 bytes), account index (u32 LE),
canonical bump. Spent-key PDA seeds: `spent-v1`, wallet PDA, commitment (32 bytes),
canonical bump. A commitment is SHA-256 of the raw Ed25519 public key. Account/epoch/
owner indices cannot exceed `2^31-1`; counters never wrap.

Wallet data is exactly 157 bytes: magic `HNYBUNK1`, genesis (32), identity (32),
account index (4), epoch (4), owner index (4), nonce (8), owner commitment (32),
recovery commitment (32), bump (1). Integers are little-endian. A consumed-key
account contains exactly `HNYSPNT1` and has no close/reset instruction.

An authorization signs SHA-256 of the concatenation:

```text
"HoneyBunkSolanaV1" | program(32) | wallet(32) | genesis(32) |
instruction_length(u32 LE) | instruction_bytes |
action_key_count(u16 LE) | ordered_action_public_keys(32 each)
```

It excludes payer and recent blockhash. The immediately preceding top-level
instruction must be the canonical one-signature Ed25519 precompile, exactly 144
bytes with inline public key/signature/32-byte digest. External offsets, padding
variants, extra accounts/bytes, wrong sysvars and invocation through CPI reject.
The transaction runtime verifies the signature before the wallet instruction.

| Tag | Instruction bytes following the tag |
| --- | --- |
| 0 Initialize | genesis(32), identity(32), account index(u32), owner(32), recovery(32) |
| 1 Execute | epoch(u32), owner index(u32), nonce(u64), first valid slot(u64), last valid slot(u64), next owner(32), action |
| 2 Recover | epoch(u32), next owner(32), next recovery(32) |

Initialization uses the deployment identity's signature and accepts a prefunded
system-owned empty PDA. The payer tops up rent; allocate/assign preserves existing
funds. Existing state cannot be reinitialized. The deployment identity is never a
spending/recovery successor. Owner and recovery roots must be distinct.

Execution consumes the owner into a permanent tombstone, records the successor and
increments owner index/nonce. Native action tag 0 contains an amount u64 and one
destination account; rent must remain in the wallet. CPI action tag 1 contains an
account count u8, one signed flag byte per account (bit 0 writable, bit 1 signer),
data length u16 and data. Ordered action keys are target program followed by those
accounts. Only the wallet PDA may be a CPI signer; it must be read-only to the
callee. Other control accounts, duplicate metas and self-targets are rejected.

The fee payer funds consumed-key accounts. Recovery consumes both the current
owner and recovery key; it increments epoch, sets owner index zero and preserves
nonce, funds and stable PDA. Its fixed certificate has no action, ordinary index,
nonce, deadline or fee-refund authority, so ordinary index/nonce changes alone do
not change it. Adversarial successor selection can still block it as described
above. A relayer updates derived control-account metas to current state without
changing that certificate. Used roots cannot return in either role. Tombstones
are permanent and their rent is a real sponsorship/storage cost.

Current deployment/owner/recovery keys and the selected successor owner/recovery
keys cannot pay transaction fees. A successor used as payer would otherwise sign
the transport before becoming active. This guard does not identify every other
phrase-derived key; clients must keep sponsorship separate from rotating keys.

## Failure and integration semantics

A failed action or later failing transaction instruction rolls back rotation,
tombstones and transfers. The owner remains current. The client must durably claim
one exact authorization before signing and only retry those same bytes in a new
fee-payer transaction. Expiry or lost approval requires independent recovery;
on-chain nonce checks alone do not prevent conflicting off-chain signatures.

Recovery cannot undo completed calls, revoke token allowances/delegates created by
an earlier approved action, protect a stolen phrase or revoke another device with
that phrase. Arbitrary CPI targets have their own semantics and upgrade risk. The
program binds the selected target/accounts/data; it does not prove a swap price or
interpret every target program's behavior.

Current CPI policy requires a read-only wallet authority and one action per
authorization. Broader dApp flows, writable-wallet requirements, native wrapping,
multi-step trading and supported token extensions need explicit compatibility
work. The instruction bounds do not prove every maximum-size CPI fits a transaction;
runtime tests assert actual tested packets fit 1,232 bytes and successful tested
transactions consume fewer than 200,000 CUs.

The [shared phrase client](../../docs/launch/BUNK-SOLANA-CLIENT.md) implements new
versioned roles, independent path vectors, account parsing and unsigned instruction
preparation. Its package entry point exposes no raw-key signing helper.

Remaining: durable journals/reconstruction, trusted finalized observer/discovery, sponsorship, app/extension
flows, public-network acceptance, deployment/upgrade policy, CI,
testnet beta and independent review. LiteSVM's tested feature set is not a claim
about current public-cluster features. Full launch requirements remain in
[the launch review](../../docs/launch/REVIEW.md).
