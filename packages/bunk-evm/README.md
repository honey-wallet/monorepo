# Honey Bunk EVM contracts

Local implementation of the proposed deployment-only bootstrap, rotating Safe
owner module and bounded Honey paymaster. **Not deployed or approved for real
funds.** Recovery, canonical bundler acceptance and the release network matrix are
incomplete. See [the launch contract status](../../docs/launch/EVM-CONTRACTS.md).

## Reproduce

Requires Python 3, Foundry **1.8.0** and Solidity **0.8.28**. From this directory:

```sh
python3 scripts/dependencies.py --install
forge fmt --check
forge build --sizes
forge test -vv
```

After installing sources/compiler, `python3 scripts/dependencies.py --check` and
`forge test --offline -vv` require no network access. The installer downloads only
contract source files and licenses, verifies the checked-in source-tree hashes,
and executes no downloaded scripts. `lib/`, `out/` and `cache/` are ignored.

The test suite imports the actual Safe and EntryPoint implementations. Source
revisions are pinned in `dependencies.lock.json`: Safe 1.4.1, EntryPoint 0.7 and
OpenZeppelin 5.0.2. Upstream licenses remain in each installed source directory.
The compiler target is Cancun; other EVM targets require their own compatibility
and code-identity verification. This build is not asserted to match bytecode of
any existing public deployment.

The separate `.github/workflows/bunk-contracts.yml` runs these checks when contract
sources or shared recovery fixtures change. Root `pnpm test` does not run Foundry.

## Contracts

- `BunkFactory`: EIP-712 bootstrap approval binds the chain, factory, identity,
  account index, predicted Safe, initial commitment and dependency configuration
  hash. This permanent deployment certificate is consumed during atomic Safe setup.
  It has no spending/reset power and no expiry/cancellation mechanism. The bootstrap
  identity has no post-deployment privilege. Separate treasury administration can
  stake/unstake/withdraw factory stake in EntryPoint but cannot mutate wallet state.
- `BunkSetup`: immutable delegatecall helper enables the module and initializes
  its state from the factory's one-use pending record.
- `BunkModule`: sole Safe owner, sole enabled module and fallback handler. It has
  no ordinary Safe/ERC-1271 signing or reset method. Owner approval covers the
  full EntryPoint operation hash plus index, successor commitment and validity
  window. Successful on-chain validation consumes the owner before execution.
- `BunkPaymaster`: sponsor approval binds every operation field except the two
  signatures themselves. One-use grant nonces, revocation epochs, per-operation
  cost caps and an aggregate conservative budget limit gas liability. Its owner
  controls sponsorship/funding only, with no wallet authority.

Only `CALL` is supported, with at most 16 calls and 6,144 bytes of encoded call
data. Calls to the account, module, factory or EntryPoint are rejected to prevent
administration through the spend path. User-operation size must also satisfy the
chosen bundler's limit; the contract cap alone is not admission evidence.

## Wire formats

`userOp.callData` is `IAccountExecute.executeUserOp.selector || abi.encode(Call[])`,
where `Call` is `(address target,uint256 value,bytes data)`. EntryPoint 0.7 replaces
this with a call passing the full operation and its hash. The module authenticates
the original EntryPoint address appended by Safe's fallback handler.

`userOp.signature` is `abi.encode(Authorization)` (a dynamic tuple, **320 bytes**):

```text
(uint32 ownerIndex, bytes32 nextCommitment, uint48 validAfter,
 uint48 validUntil, bytes signature)
```

The signature is 65-byte low-S ECDSA over `ownerDigest(userOpHash, authorization)`.
The signed validity interval is positive and no more than one hour. EntryPoint
enforces the window; the owner validator does not read the timestamp.

For Honey sponsorship, `paymasterAndData` is:

```text
20-byte paymaster address || uint128 verificationGas || uint128 postOpGas
|| abi.encode(Sponsorship)
```

The grant is a dynamic tuple of **352 bytes**:

```text
(uint48 validAfter, uint48 validUntil, uint128 maxCost,
 uint256 nonce, uint64 epoch, bytes signature)
```

The full field is **404 bytes**. Obtain the sponsor signature first, then the
rotating owner's signature: the owner's operation hash includes the complete
sponsor grant. Any later change requires revalidation. `maxCost` and the budget
are native-token wei; budget consumption reserves worst-case cost and intentionally
does not refund unused allowance. The actual EntryPoint deposit is tracked separately.

## Failure and recovery semantics

- A failed validation/bundle reverts all provisional owner/budget changes.
- A valid operation whose target call reverts or runs out of gas consumes the owner
  and EntryPoint nonce. The action batch rolls back; the next derived owner can act.
- A failed execution can leave its authorization marker in storage because its
  deletion was in the reverted frame. It grants no replay path: only the pinned
  EntryPoint can execute, and its nonce has been consumed. Cleanup/indexer handling
  needs validation before release.
- A chain reorganization can roll back both nonce and commitment. Clients must
  reconcile finalized state, not advance from a relay response or emitted signature.
- Restoring a seed can rederive the current owner. Guardian recovery, migration at
  branch exhaustion and a complete device-loss discovery flow are not implemented.

## Open acceptance work

The first sponsored counterfactual deployment plus execution passes against the
actual EntryPoint in a local test. The factory uses a permanent, exact-configuration
deployment certificate so its creation frame does not need a timestamp read.
Only transaction and sponsorship approvals expire. The certificate can be relayed
later by anyone but cannot change the authorized configuration or reset an account.
This tradeoff requires explicit client review and independent security assessment.
The [real bundler harness](test/bundler/README.md) now verifies seven cases with
unmodified Alto 0.0.18 in safe mode and an explicit local Osaka chain, including
factory stake and opcode rejection. Current-provider and other-fork admission
remain unverified; the harness records observed incompatible configurations.
Direct `handleOps` tests alone are insufficient to prove those rules.

The bootstrap key derivation/client approval flow, production sponsorship service,
on-chain recovery design, code-hash registry, testnet beta and independent security
review remain open. Full launch requirements are preserved in
[REVIEW.md](../../docs/launch/REVIEW.md).
