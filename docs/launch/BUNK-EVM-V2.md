# Safe recovery protocol candidate, version 2

The recovery design now has a real Safe 1.4.1 implementation in
`BunkRecoveryModule.sol`, `BunkRecoveryFactory.sol` and `BunkRecoverySetup.sol`.
This is a separately versioned candidate, not a released upgrade. The v1 contracts,
keyring formats and frozen owner/deployment derivation paths remain unchanged.
Do not pass a v2 deployment to the v1 signer or observer: its prediction salt and
signature domains differ. No app activation or public deployment is enabled here.

## Deployment and authority

The factory uses `HoneyBunkAccountV2` for the CREATE2 salt and the
`HoneyBunkDeployment` EIP-712 domain at version `2`. Its permanent certificate still
binds identity, account index, predicted Safe, first owner commitment and exact
configuration hash. It grants no authority after initial setup. Owner intent
certificates use `HoneyBunkOwner`, version `2`, verifying contract = module, and
primary type `BunkOwnerIntent`.

The Safe has exactly one owner and enabled module (the recovery module), threshold
one, the same module as fallback handler, no guard, and the pinned singleton. The
setup helper only runs through delegatecall. Public first-claim attempts without
the factory's pending signed bootstrap record revert. Factory treasury ownership
only controls its EntryPoint stake; it cannot reset a wallet or sign for it.

An owner intent binds EntryPoint, Safe address, nonce, calls hash, verification/call
gas limits, pre-verification gas, maximum gas liability, permitted paymaster, current
owner index, successor commitment, a Merkle root of 256 one-time envelope keys,
start time and action deadline. The owner signs once. Each exact EntryPoint
operation is signed by a distinct authorized leaf, with an eight-node proof.
The canonical authorization occupies 1,120 bytes; calls remain bounded to 16 CALLs
and 6,144 bytes, while the complete ABI operation must fit 8,192 bytes. Large
counterfactual operations can hit the overall limit before the calldata limit.

Only the trusted EntryPoint, authenticated through Safe's appended fallback caller,
can validate or execute. Validation rotates the owner and reserves the exact
operation hash. The nonce is restricted to EntryPoint key zero. Old/current owner
commitments cannot be reactivated. No generic ERC-1271 signer, Safe-owner bypass,
extra module, delegatecall or account self-administration is exposed.

## Expiry and recovery

An action executes only through its signed deadline. Later inclusion skips the
calls and emits `ExpiredActionSkipped`; it still rotates and pays bounded gas.
That event is not a successful trade. A failed live action also retains validation
rotation, while its call effects roll back. Replaying an old operation cannot
consume another owner because its signature/index/nonce are no longer current.

Leaf 255 is reserved for a deterministic recovery envelope after the deadline.
It requires a deployed account, no initCode, no paymaster, no calls, and fixed gas
fees computed from the signed liability ceiling. It can be retried unchanged,
including after funding an account that previously could not prefund. Other leaves
permit fresh gas/sponsorship within the certificate's limits. Honey sponsorship
still uses the existing operation-bound, empty-context paymaster profile: exactly
200,000 paymaster validation gas and zero postOp gas. Self-funding is explicitly
within the owner's signed maximum liability.

## Gas-deposit refunds

Self-funded gas refunds are credited to the Safe's EntryPoint deposit, not returned
to its native balance. Version 2 therefore permits one narrowly scoped EntryPoint
CALL: canonical `withdrawTo(address(thisSafe), amount)` with zero ETH value. Other
recipients, selectors, appended bytes and dirty address padding are rejected during
validation. This is still inside the signed owner intent and exact leaf envelope.
No EntryPoint nonce/admin or arbitrary external-recipient call is exposed.

A sponsored withdrawal can return the entire deposit because Honey pays that
operation's gas. A self-funded withdrawal must leave room for its own gas reservation;
its remaining refund stays available for future gas or a later withdrawal. The client
must display the deposit separately and review the withdrawal amount accordingly.
Tests cover both accounting modes and all rejected forms above.

## Storage and creation gas

The account's current commitment is already stored in `ownerState`. Version 2
records a commitment in `consumedCommitments` only when it is consumed; it does not
also allocate a separate initial-current-key entry during deployment. The public
`usedCommitment(account, commitment)` getter returns true for either the current
commitment or a consumed one, preserving its observable meaning. Zero and unknown
commitments return false. Both map writes and exact-operation reservations retain
the account as the innermost mapping key for canonical bundler storage rules.

The first port exceeded the 500,000-gas verification budget during sponsored
creation. This representation removes a redundant creation-time storage write.
Operation-size checks also calculate the exact ABI length without copying the
entire operation merely to measure it. Canonical authorization/call encoding,
signature checks, proof checks and factory configuration checks remain enforced.
The actual-EntryPoint sponsored-creation test now passes at 500,000 verification gas;
real-provider/network acceptance must be assessed separately.

## Integration contract and evidence

Public state remains `ownerState(account) -> (commitment,index)` and EntryPoint's
`getNonce(account,0)`. `usedCommitment` includes current and consumed commitments.
`reservation(account,userOpHash)` returns execution authorization/deadline; a failed
execution can leave the reservation record, but cannot bypass EntryPoint's nonce.
Indexers must use the **v2 event ABI**, particularly:

- `OwnerConsumed(account,userOpHash,intentHash,consumedIndex,nextCommitment)`.
- `ActionExecuted(account,userOpHash)`.
- `ExpiredActionSkipped(account,userOpHash)`.

All 33 v2 Safe integration tests pass alongside 27 v1 Safe tests and 18 standalone
recovery tests (78 total). They cover exact setup, first-claim rejection, deployment
scope, ordinary Safe signatures, spoofed EntryPoint forwarding, module/admin bypasses,
atomic failures, key reactivation, bounded sponsored creation, Merkle retry scope,
last-leaf recovery, missing prefund, and later funding with identical signed bytes.
The real local v2 Safe bundler run passed sponsored counterfactual creation,
unstaked-factory/changed-signature rejection, expired-grant renewal, successor action
and reserved-key cleanup. The final run also passed a sponsored withdrawal of the
entire EntryPoint gas deposit back to the Safe. The latest client-inclusive run rechecked 45 source and 86 artifact hashes against
the tested tree; the disposable containers and network were removed. See the
[contract results](evidence/bunk-safe-v2-local.json) and
[real bundler evidence](evidence/bunk-bundler-local.json).

The [v2 shared client and recovery format](BUNK-EVM-V2-CLIENT.md) now implement
versioned signing/observation and independent derivation/encoding vectors. Before
activation, finish the [journal’s app/recovery integration](BUNK-JOURNAL-DESIGN.md),
pending-certificate backup/discovery,
concurrent-device policy, receipt/UI integration, migration and independent review.
The seed does not reconstruct arbitrary lost pending-intent fields. Any migration
must preserve frozen paths and prevent previously exposed owner-key tuples from
being reused. These gates remain in [the recovery design](BUNK-RECOVERY-DESIGN.md)
and [launch review](REVIEW.md).
