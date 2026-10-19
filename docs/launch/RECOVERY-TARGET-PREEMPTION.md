# Recovery limitation after active signing-key compromise

Status: **reproduced against the compiled Solana candidate; unresolved limitation**.
EVM v3 has analogous checks by static inspection, without runtime reproduction.

Scope clarification: the user treats theft of the active signing key as wallet
compromise. That key already authorizes spending. This finding does not establish
an additional theft capability or a failure of ordinary lost-device/seed restore.
Recovery while an attacker actively controls that key is not an agreed launch
requirement, so this finding alone is not a launch blocker. Do not promise recovery
under active key compromise. Preserve the reproduction as evidence of this limit.

## Reproduction and consequence

1. The wallet has current owner A and independent recovery authority R. Its fixed
   recovery certificate commits to next owner B and next recovery authority S.
2. Someone with A's signing key sees the certificate's public target commitments.
   Before recovery lands, they authorize an ordinary action with successor B or S.
   They do not need either incoming private key. The existing program permits this
   successor because it is neither currently active nor previously consumed.
3. The unchanged recovery certificate now fails: its target is the current owner.
   Solana also aliases the current-owner tombstone with an incoming tombstone, which
   fails the common control-account uniqueness check. No generation reset occurs.

`packages/bunk-solana/tests/runtime.rs` now contains
`known_recovery_target_preemption_blocks_fixed_certificate`, covering **both**
incoming commitments. It confirms ordinary advancement succeeds, the exact recovery
proof remains unchanged, recovery fails without changing state, and epoch stays 0.
The test **characterizes the limitation**; a passing result is not security acceptance.
Run/log: `/private/tmp/honey-solana-recovery-preemption.log`.

Solana rejection paths are `common`'s control uniqueness and `successor`'s exclusion
of the current owner, used by `recover` in `packages/bunk-solana/src/lib.rs`.
EVM `BunkSeedRecoveryModule.sol` uses `_usedForEitherRole` both for ordinary successors
and incoming recovery roots: ordinary execution can make the published target
current, after which `recoverFromSeed` rejects it. The latter statement is static
evidence only until the corresponding EntryPoint test is executed.

An ordinary owner's ability to advance index/nonce safely was tested earlier;
adversarially choosing the recovery targets was not. The broad claim that ordinary
advancement cannot invalidate a fixed recovery certificate is therefore unproven
for arbitrary owner-authorized successors and contradicted by this Solana case.
Changing only the client to refuse these successors is insufficient: an exposed
current key can authorize a custom transaction outside Honey's client.

## Priority and possible future hardening

Continue normal seed restore, lost-device recovery, interrupted-transaction handling,
and application integration. Validate those flows against the stated threat model.
This scope clarification does not certify production readiness or waive their checks.

If recovery under active signing-key compromise becomes a product requirement,
redesign and verify the protocol before making that guarantee. Preserve one approved
digest per key and permanent protection against consumed roots; merely relaxing
uniqueness checks or re-signing a different recovery digest is not a validated fix.
Keep the existing characterization test and historical evidence unchanged.
