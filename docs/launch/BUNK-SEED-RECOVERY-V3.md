# Version 3 seed-recovery authority candidate

Status: separate Safe module/factory/setup contracts and local integration tests are
implemented, together with the offline phrase client, independent derivation vectors
and finalized observer. V1/v2 contracts and derivation formats remain unchanged.
The [v3 account journal/restore coordinator](BUNK-V3-ACCOUNT-JOURNAL.md) is implemented.
Shared [SQLite/IndexedDB storage and a phrase-derived journal key](BUNK-BROWSER-JOURNAL.md)
are available, along with [bounded v3 account discovery](BUNK-ACCOUNT-DISCOVERY.md).
Complete asset/release discovery, mobile/extension app integration and activation
are **not implemented**. Local client probes do not establish a device restore flow.

## Why another version is necessary

V2 can reconstruct an interrupted signature when its approved certificate survives.
It cannot reconstruct arbitrary lost calls, gas caps and deadlines from the phrase.
Its reserved cleanup leaf still requires that certificate. A static backup made
before the latest approval may therefore strand recovery. Exporting a richer file
alone does not satisfy the brief's one-backup restoration requirement.

V3 adds an independent recovery-key commitment and a generation number (`epoch`).
Normal owner keys continue rotating within a generation. Recovery consumes the
current recovery key and moves to a fresh generation of owner/envelope keys at the
same Safe address. The versioned candidate derivation separates generations and roles;
it never resets an owner index into an old key branch.

This introduces additional on-chain authority beyond the original single owner-key
hash. [Review L16](REVIEW.md) records that tradeoff; it is not a silent v2 upgrade or
proof of production readiness. Existing accounts cannot switch modules through the
current restricted call policy; migration requires an explicit versioned account
and fund-transfer plan.

## Exact recovery authorization

`BunkSeedRecoveryModule.recoverFromSeed(account, epoch, nextOwnerCommitment,
nextRecoveryCommitment, signature)` verifies EIP-712 domain `HoneyBunkOwner`, version
`3`, chain ID and module address. Its `BunkSeedRecovery` struct binds the EntryPoint,
Safe address, current recovery epoch and both successor commitments.

The message deliberately excludes the current ordinary owner index, EntryPoint
nonce, pending transaction, fee/grant and time. The phrase client must deterministically
choose only generation `epoch + 1`, owner index zero and its next recovery key. This
makes the same recovery authorization usable when ordinary transactions race ahead
within the current epoch, without signing a different message under the recovery key.
The contract authenticates the chosen commitments; it cannot prove their derivation
from a phrase. That constraint belongs in the reviewed client and its fixed vectors.

Any funded EOA can relay the exact authorization. The relay transaction pays gas;
recovery does not reimburse the caller or debit the Safe/EntryPoint deposit. Honey
can operate a relay, but has no privileged reset key and is not required for inclusion.
A user-controlled ordinary account is a possible fallback. Funding, RPC/network
availability and transaction inclusion remain liveness requirements.

There is no expiry or cancellation of an issued recovery certificate within its
epoch. A copied certificate can trigger that exact reset before its original relay;
it cannot change successors or execute calls. Once consumed, the epoch/key change
rejects replay. A compromise of the recovery private key **before consumption** can
choose attacker-controlled successors; this does not protect against phrase theft.
Repeated deterministic reconstruction retains the L15 computation-count tradeoff.

## State and execution rules

- Bootstrap atomically installs distinct nonzero owner and recovery commitments.
  The permanent deployment signature binds both, the account/index and exact config.
- Normal validation consumes the owner and reserves the exact operation, as in v2.
  Each reservation records the current recovery epoch. Recovery does not reset the
  EntryPoint nonce. Owner index resets to zero only in the fresh generation.
- Recovery tombstones both the superseded owner and recovery keys. A shared consumed
  commitment map prevents either role from reusing a previously exposed key. Current
  owner/recovery commitments cannot become successor keys or alias each other.
- Recovery has no Safe call, transfer, fee reimbursement or administrator bypass.
  The Safe keeps the same singleton, sole module/owner, threshold, fallback and guard.
- EntryPoint validates the bundle before executing its actions. An earlier execution
  can relay recovery after later operations were validated. Those later reservations
  are cancelled on epoch mismatch. Recovery triggered by a called contract also stops
  the remaining calls of the current batch. `RecoveryCancelledAction` distinguishes
  these outcomes from execution and expiry cleanup.
- Recovery cannot undo already-executed actions or stop the internals of an external
  call already in progress. Previously granted token allowances and authority on
  external protocols are separate from owner-key rotation.
- Epoch and owner indices stay within the hardened 31-bit namespace. Exhausted
  ordinary owner indices may recover into the next generation; the maximum recovery
  epoch cannot advance further.

The bundle ordering comes from [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337).
Safe modules are execution authorities, so retaining exact Safe configuration is
part of the test scope. [Safe module documentation](https://docs.safe.global/advanced/smart-account-modules).

## Atomic bootstrap and gas compatibility

Persistent storage for both pending commitments exceeded the existing 500,000-gas
sponsored validation bound. V3 instead uses two account-keyed EIP-1153 transient
slots during factory deployment. Only the configured module may consume them, and
consumption clears both before returning. The factory verifies that both are empty
and asserts the complete resulting Safe configuration. Initialization and deployment
failure revert the entire operation; no durable bootstrap/reset record remains.

Transient storage requires Cancun/EIP-1153 support. It is not a blanket expansion
of network compatibility: [ERC-7562 OP-070](https://eips.ethereum.org/EIPS/eip-7562)
applies storage rules to transient slots too. Real bundler admission, including
unstaked-factory rejection, remains required on each release network/fork/provider.
[EIP-1153](https://eips.ethereum.org/EIPS/eip-1153) defines transaction lifetime and
rollback behavior. The ordinary verification gas limit has not been raised.

## Frozen candidate client namespace

`packages/keyring/src/bunk-evm-v3-sign.ts` implements the following fully hardened
paths. `network9` and `scope9` each encode all 256 bits as nine big-endian 31-bit
components, preserving leading zeros. Every component below has a hardened suffix.

| Role | Path components after `m` |
| --- | --- |
| Ordinary owner | `7744 / 3 / 0 / 60 / network9 / scope9 / account / epoch / owner` |
| Envelope leaf | `7744 / 3 / 1 / 60 / network9 / scope9 / account / epoch / owner / attempt` |
| Deployment identity | `7744 / 3 / 2 / 60 / account` |
| Recovery | `7744 / 3 / 3 / 60 / network9 / scope9 / account / epoch` |

The scope is `keccak256(abi.encode("HoneyBunkKeysV3", factoryAddress,
factoryCodeHash, configHash, keccak256(proxyCreationCode)))`. It binds the factory
identity and all configured dependency addresses/code hashes as well as proxy code.
Network ID is separately encoded in the path. A new deployment configuration,
network or recovery generation therefore derives different spending/recovery keys.
The deployment-only identity remains network-independent. Identical Safe addresses
across networks still require identical deployment addresses and initializer/code.
These paths and vectors must not change without a new version/migration.

The recovery signer accepts the verified account/index, epoch and recovery root.
It derives only the next epoch's owner zero and recovery key. It accepts neither
caller-selected successors nor an arbitrary signing digest. No pending approval,
ordinary owner index or EntryPoint nonce is required by this primitive. Ordinary
signing verifies both current owner and recovery commitments against the seed.

`observeBunkEvmV3Account` verifies dependency code/configuration and Safe authorities,
reads both states and the EntryPoint nonce at one finalized EIP-1898 canonical hash,
then rechecks the canonical mapping and chain. It does not authenticate the supplied
release registry or make a dishonest RPC trustworthy. A caller must enforce trusted
RPC policy and registry provenance. Offline signers do not provide durable locking.

## Integration handoff (not yet wired)

Public account records need protocol version 3, network/config identity, deployment
identity/account index, recovery epoch and commitment, current owner index and
commitment, EntryPoint nonce, and finalized observation block/hash. Recovery epoch
and ordinary owner index are independent; neither may be inferred from the nonce.

A recovery relay accepts the already-signed exact module calldata and pays its own
transaction gas. It must not replace successor commitments or require the lost
ordinary certificate. A regular ERC-4337 `relay.submit` route is not automatically
this direct-transaction relay. Treasury budgets, admission limits, receipt tracking
and a user-operated fallback are separate backend integration work.

The client must verify the exact module/factory/Safe configuration and finalized
recovery state before signing. Confirmation requires the recovery event and the
expected finalized generation/commitments, followed by a fresh nonce observation.
A relay acknowledgement cannot unlock ordinary signing. Restore must choose a new
key generation; an absent journal entry must never authorize reusing an old branch.

An account that is still undeployed needs a separate recovery path. Its first owner
may already have signed a lost creation approval, even though the chain has no state.
An empty journal plus an undeployed observation must therefore not authorize a new
approval under that key. The factory permits exact deployment by an external caller;
the implemented restore coordinator deploys the fixed bootstrap and requires a reset
into a new generation before enabling ordinary signing. Caller-funded direct relay,
ordering/races and application activation must be integrated; current acceptance
evidence is linked in [the coordinator design](BUNK-V3-ACCOUNT-JOURNAL.md).

## Current evidence and next work

All 43 v3 Safe integration tests pass, including the 33 v2 behavior cases ported to
the versioned contracts and 10 seed-authority cases. All 121 Solidity tests pass
across v1, the standalone recovery experiment, v2 Safe and v3 Safe. New cases cover
lost pending approvals, empty wallets, non-expiring exact recovery, ordinary-owner
advancement, replay/domain/role substitution, high-S signatures, repeated bootstrap
consumption, subsequent generations and cancellation within real `handleOps` batches.

The live `seed-recovery.mjs` probe passes on isolated Geth/Alto: transient-bootstrap
sponsored creation, unstaked-factory rejection, independent reset with unchanged
funded wallet/deposit/nonce, old-operation rejection and new-generation signing.
Finalized local state confirms the resulting generation and owner. That coordinator
suite snapshot rechecked 62 source and 95 artifact hashes; later browser/storage
changes have separate evidence. [V3 evidence](evidence/bunk-seed-recovery-v3-local.json) and
[validation details](VALIDATION.md) preserve the exact local scope and remaining gates.

The phrase-derived client now passes 276 keyring tests and three independent
Python/OpenSSL/Foundry vectors. Its separate `client-v3.mjs` probe additionally
passes sponsored creation, a fresh recovery process receiving no pending approval or
journal, unchanged wallet/deposit/nonce across reset, rejection of the dropped old
operation and resumed signing in the new generation. Finalized observations show
`(epoch,index,nonce)` changing from `(0,1,1)` to `(1,0,1)` to `(1,1,2)` at the same
account. [Client evidence](evidence/bunk-v3-client-local.json) records this local scope.
The probe uses a test-only write-ahead reservation file; it does not implement an
application journal, backup rollback defense or multi-device coordination.

The [account coordinator](BUNK-V3-ACCOUNT-JOURNAL.md) adds 19 SQLite/fault tests,
bringing the keyring suite to 295. Its live probe covers a lost creation approval
while still undeployed, a prefunded account, direct bootstrap, actual recovery-signer
process death and reconstruction, finalized reset and resumed sponsored execution.
[Coordinator evidence](evidence/bunk-v3-account-local.json) records the resulting
state and matching source/artifact manifest. This is separate from the earlier
primitive-only phrase probe and its test-only reservation file.

Next: integrate the implemented account coordinator with account discovery, trusted
release configuration, funded recovery relay and app/device restore flows. A restored v3 wallet should recover
into a fresh generation before ordinary signing resumes. That still does not revoke
another device holding the same phrase: multi-device writer authority remains open.
