# Solana Bunk implementation requirements

Status: an isolated [native program candidate](../../packages/bunk-solana/README.md)
now implements initialization, native/CPI execution, consumed-key tombstones and
independent recovery. Compiled SBF/runtime, isolated Agave validator and independent encoding evidence is
recorded in [validation](VALIDATION.md). Client integration, activation and production
acceptance remain unfinished. The local validator run verifies immutable deployment
bytes and finalized rollback/retry/recovery; it does not validate a public cluster
or broaden the current single-action, read-only-wallet CPI policy. The installed local tools
report Agave CLI/SBF 3.1.11, platform-tools 1.52 (Rust 1.89.0), and Anchor 0.30.1;
those versions are observations, not a claim that they form a validated release stack.

## Constraints the launch brief omits

Solana transaction failure reverts the transaction's state changes. A rotation
written in a transaction that ultimately fails cannot be claimed as consumed.
Retrying with a new recent blockhash also changes the transaction message. Having
the rotating owner sign each replacement transaction conflicts with the one-message
per-key policy. These differ from the EVM validation/execute construction and need
explicit program tests. [Solana transaction semantics](https://solana.com/docs/core/transactions).

Candidate direction: the rotating key signs a fixed, versioned authorization
independent of the transport blockhash. A separate fee payer signs and retries the
transaction carrying that same authorization. The program verifies and consumes
the authorization together with its successful action and owner transition.
Expired or lost approvals require an independent phrase-derived recovery authority
and a fresh generation; never silently sign a different action with the same key.
This is a proposed implementation direction, not a completed security guarantee.

Ed25519 verification must be an actual precompile instruction; the precompile is not
callable by CPI. Its offsets can refer to data in other instructions. The wallet
program must validate the exact precompile program ID, signature count, offsets,
public key and message binding, using the real instructions sysvar. A canonical
self-contained encoding should reject alternative cross-instruction layouts.
[Solana precompiles](https://solana.com/docs/core/programs/precompiles).

The program-derived wallet address authorizes downstream calls through
`invoke_signed`; it cannot provide an ordinary ed25519 website signature. CPI
permissions propagate from the caller, so the wallet must bind and constrain the
ordered downstream program/account/data privileges it grants. Self-invocation,
state-account mutation, signer escalation, token delegation and upgrade authority
need deliberate policies. [Solana CPI rules](https://solana.com/docs/core/cpi).

## Required implementation and acceptance

1. An isolated Cargo workspace under `packages/bunk-solana`, with pinned dependencies
   and an actual SBF build. Do not edit the concurrently owned backend workspace or
   root lockfile. Choose native Rust or compatible Anchor from verified dependency
   evidence; an installed CLI alone does not dictate the dependency version.
2. Freeze account state, instruction and certificate encodings with independent
   fixtures. Bind protocol, full genesis identity, program, stable PDA, account index,
   epoch, owner index, monotonic nonce, action and successor authority. Bound every
   length/index and reject exhaustion. Preserve existing derivation vectors; new
   deployment/recovery/epoch roles require separate versioned paths.
3. Authorize initialization at the stable PDA without creating a permanent spending
   bypass. Cover prefunded PDA addresses, duplicate creation, malicious initialization,
   lost first approvals and rent preservation. Program upgrade policy is part of
   the trust model and must be visible in release verification.
4. Execute native SOL and SPL-token actions with exact account/privilege binding.
   Exercise a real downstream program, failed action, duplicate account metas,
   self-call/reentrancy, forged sysvars, wrong owner and altered successor. A Rust
   state-machine test alone is insufficient for runtime privilege guarantees.
5. Independently authorize a fixed next-generation recovery at the same PDA, with
   no arbitrary action or fee-refund authority. Test old approvals after recovery,
   concurrent ordinary/recovery transactions, repeated recovery and lost journals.
6. Prove actual precompile verification and blockhash-refresh retries in a local
   validator/SBF test, including forged offsets and bad signatures. Verify exact
   packet/compute limits for the chosen transaction format and validator features.
7. Add the client derivation, durable claims, chain observer/discovery and explicit
   recovery coordination. Integrate sponsorship, app/browser semantics and testnet
   acceptance before enabling the toggle. Seed theft and multi-device authority
   remain separate from historical-key rotation.

The full requested Solana behavior remains required. A transfer-only demonstration,
host-only tests or a PDA address helper must not be presented as completion of the
program, CPI trading support or production launch.
