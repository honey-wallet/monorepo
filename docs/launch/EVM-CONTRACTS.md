# Bunk EVM implementation and remaining acceptance

Latest seed-loss recovery work is a separate [v3 Safe candidate](BUNK-SEED-RECOVERY-V3.md),
with a [durable account signing/restore coordinator](BUNK-V3-ACCOUNT-JOURNAL.md).
It adds independent recovery authority; phrase/client restoration and activation are
still pending. The v1/v2 evidence and constraints below remain version-specific.

2026-10-19. Implemented in `packages/bunk-evm`; no chain deployment was made.
This session owns that package and `docs/launch`. Backend/frontend source files
remain with their separate sessions.

Both contract projects now live in `packages/bunk-evm` and `packages/bunk-solana`.
Foundry and the Solana Cargo workspace remain independent of the backend build.
Historical evidence retains the paths and source hashes captured when it ran;
those records predate the directory move and have not been rewritten.

## Separately versioned recovery candidate

The [version 2 Safe implementation](BUNK-EVM-V2.md) adds one-time Merkle envelope
retries, expiry cleanup and a restricted withdrawal of EntryPoint gas deposits back
to the Safe. It passes 33 additional actual-Safe integration tests. Its domains,
prediction salt and event ABI differ from v1. The [v2 shared client](BUNK-EVM-V2-CLIENT.md)
now passes independent vectors and real local bundler checks; pending-intent backup,
device coordination, app integration and release review remain open. The
following original implementation and client evidence describes **v1**.

## What is now demonstrated locally

The package builds real Safe 1.4.1 and EntryPoint 0.7 from commit-pinned source.
Its module, factory, setup helper and paymaster pass 27 integration tests, including
256 fuzz inputs for unauthorized owner keys. The contracts use the independent
keyring commitment vectors rather than inventing a second commitment encoding.
The exact local source hashes, results and compiled sizes are saved in
[bunk-evm-local.json](evidence/bunk-evm-local.json).

A separate real Geth/Alto run now passes **seven acceptance/rejection checks**.
Unmodified Alto 0.0.18 in safe mode admits and mines sponsored creation, failed
execution, the next owner's recovery action and a self-funded deployed account.
Changed signatures, forbidden `TIMESTAMP` and an unstaked factory are rejected.
The harness checks receipt hashes, sender, EntryPoint, owner commitment and nonce;
it uses an explicit local Osaka genesis and disposable containers. See
[reproduction and limitations](../../packages/bunk-evm/test/bundler/README.md) and
[source-hashed evidence](evidence/bunk-bundler-local.json). This is local historical
bundler interoperability, not acceptance by a current production provider.
The [failed-configuration record](evidence/bunk-bundler-limitations.json) preserves
the observed errors and available diagnostic/source hashes.

The latest harness uses the actual shared keyring client API with seed-derived
deployment and owner keys. Offline initializer, configuration hash, CREATE2
prediction and every signing digest match the deployed contract getters. Three
independent Python/OpenSSL/Foundry signing vectors and 24 new keyring tests also
pass. The finalized account observer adds 37 adversarial tests (keyring total 141),
and the real harness now checks code, complete Safe configuration, commitment and
nonce before signing and after each receipt at one canonical finalized hash.
Geth dev finality is simulated every 32 blocks. See
[client signing and its integration boundary](BUNK-EVM-CLIENT.md).

- One deterministic account address survives a chain-ID change in an isolated EVM
  snapshot while initial owner commitments differ. This is a local deployment
  invariant, not two public-chain deployment receipts.
- Bootstrap signatures cannot change accounts, commitments or chains, and cannot
  execute ordinary Safe transactions after setup. Direct Safe factory first-claim
  attempts fail and leave the predicted address undeployed.
- Owner signatures bind the complete EntryPoint operation hash. Changed gas fields,
  successor commitments, chains, accounts, expired windows and high-S signatures fail.
- Safe's ordinary EOA, contract-owner and approved-hash signature paths cannot
  bypass rotation. Unapproved modules, account self-administration and spoofed
  fallback callers are rejected.
- Success consumes one owner. A downstream revert rolls back the call batch while
  retaining validation's rotation; execution out-of-gas has the same owner outcome.
  The next owner can recover. Rejected bundles and failed prefunding restore state.
- Multiple sequential owners can validate in one bundle; conflicting owner indices
  revert the whole bundle. Previously used commitments cannot be reactivated.
- Honey's paymaster can pay for an unfunded wallet. Its operation binding, grant
  replay guard, signer epoch, aggregate budget and per-operation cap are enforced.
  Failed actions still consume gas budget and rotate the owner.
- A sponsored operation deploys a previously nonexistent Safe and executes its
  first action under the actual EntryPoint. The factory's stake lifecycle also
  passes, with treasury administration unable to mutate the Safe.

The dependency installer also passed a fresh temporary-directory download,
source-hash verification, compilation and the then-current 22-test suite. Three
additional negative tests, smaller calldata/gas limits, permanent deployment
certificates and staking were subsequently added; the current 27-test suite passes.

Compiler output (Solidity 0.8.28, optimizer 200, Cancun):

| Contract | Runtime bytes | Creation bytes |
| --- | ---: | ---: |
| BunkFactory | 7,744 | 17,571 |
| BunkModule | 5,987 | 7,113 |
| BunkPaymaster | 6,742 | 8,598 |
| BunkSetup | 488 | 644 |

These measurements fit the usual EVM contract size limits. They do not establish
compatibility with every chain or existing Safe factory deployment.

## Engineering gaps, not requests for user approval

1. **Canonical bundler deployment:** [ERC-7562](https://eips.ethereum.org/EIPS/eip-7562)
   prohibits `TIMESTAMP` in validation, including account creation. The factory now
   uses an explicit permanent certificate for one exact initial configuration;
   owner/sponsor spend approvals retain expiry. Sponsored creation and the first
   action pass through the pinned local bundler, but current production-provider
   admission and independent assessment of certificate semantics remain required.
   No validation rule is disabled.
2. **Bundler/storage/stake evidence:** the module now places account addresses in
   the innermost mapping key, giving sender-associated final storage slots. The
   real local tracer accepts this call graph with staked factory/paymaster and
   rejects the unstaked control. Current-provider and per-chain evidence remain
   open: Alto 0.0.19 hit a simulation-decoder error; Geth's default Bogota dev fork
   exceeded the creation gas budget. Unsponsored creation also exceeded the Osaka
   verification budget; sponsored creation and deployed self-funding passed.
3. **Recovery:** seed derivation is available, but public metadata backup/discovery,
   guardian delay/veto policy and terminal-index migration are incomplete. The
   bootstrap identity intentionally cannot reset a deployed wallet. An owner-signed
   operation that expires before inclusion leaves that owner active. The current
   contracts cannot resolve this while preserving literal one-time signing; see
   [signed-but-unconsumed recovery](BUNK-PROTOCOL.md#signed-but-unconsumed-recovery-remains-unresolved).
4. **Client integration:** bootstrap derivation, offline prediction/encoding and
   restricted signing are implemented and cross-checked. A trusted deployment
   registry, implemented canonical chain/configuration verifier, operation journal, review,
   two-device coordination and finalized-state recovery are not connected to apps yet.
5. **Operating service:** the paymaster needs a bounded authenticated grant issuer,
   operator key handling, funded/staked deployments, treasury alerts and revocation
   handling. Contract-only funding tests do not establish service availability.
6. **Independent review:** Foundry's static linter reports broad warnings around
   event recognition, pinned-factory initialization, loops and upstream
   short-string fallback storage. These are not a substitute for an independent
   attack-path review. No clean security-audit claim is made.

## Integration requirements for the other sessions

- Track `(network, Safe, module, derivationVersion, ownerIndex, commitment)` with
  the finalized block/hash and code identities. Do not accept client-provided state
  as chain evidence. Publish the relevant `OwnerConsumed` and EntryPoint receipt
  together: failed execution may still consume an owner.
- Preserve the exact signed operation bytes and sponsor grant for retry. Do not
  modify gas, paymaster, calldata, nonce or successor commitment after owner approval.
- Reject a deployment configuration that leaves another owner/module or changes
  the fallback handler. This prototype uses only the module as Safe owner and module.
- Do not enable ordinary website/permit signing for this account. No generic
  ERC-1271 or rotating-owner message-signing capability exists here.
- Treat production sponsored deployment as unavailable until actual bundler
  admission is verified. This is an unfinished original requirement, not a scope reduction.

Concrete wire formats, commands and failure semantics are in the
[contract README](../../packages/bunk-evm/README.md). The separate local CI workflow
has been written but has not run on GitHub; no commit/push/PR was performed.
