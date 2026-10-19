# Preserving EVM account addresses without reusing rotating owners

Status: locally implemented and tested with actual Safe/EntryPoint sources in
`packages/bunk-evm`. Not deployed or accepted as a security guarantee. Canonical
bundler deployment and recovery remain incomplete; see [EVM-CONTRACTS.md](EVM-CONTRACTS.md).
This advances L03 in [REVIEW.md](REVIEW.md), not its production release gate.

## The conflict

Safe's factory derives its CREATE2 address using its initializer. Putting a
network-specific first-owner commitment directly in that initializer changes the
address. Using the same first owner everywhere instead violates our network
separation. This follows from [Safe's documented deployment inputs](https://docs.safe.global/advanced/smart-account-multi-chain-deployment).

## Proposed separation of deployment and transaction authority

Use a dedicated bootstrap identity to authorize **first deployment only** on each
network. It is a separate hardened branch, never an ancestor of the owner branch,
and has no execution or reinitialization rights after deployment. Its domain is
distinct from owner operations, website signatures and guardian recovery.

The Safe initializer contains identical account identity and module/helper code
references on each compatible chain. A trusted Honey factory supplies the initial
network-specific commitment through a transient deployment record outside the
initializer. Initialization and record consumption occur within one transaction.

1. The client predicts the Safe using the pinned factory/singleton/proxy code,
   identical initializer, and account-identity salt. Use the chain-independent
   Safe factory method; do not accidentally select its chain-specific variant.
2. A bootstrap signature binds the chain ID, Honey factory, predicted Safe,
   identity/account index, contract versions, initial owner commitment, initial
   owner index zero. This is a permanent certificate for the exact configuration;
   it authorizes no transfer, reset or later administrative call. Spending and
   sponsorship approvals retain their independent signed expiry windows.
3. Honey's factory verifies that authorization, rejects an existing deployment,
   and records the exact pending initialization for that predicted Safe. It must
   reject reentrancy; a pending record is not mutable by the caller or another factory.
4. Honey's factory asks the pinned Safe factory to deploy using the constant
   initializer. During Safe setup, an audited delegatecall helper enables the Honey
   module and asks it to initialize the calling Safe from Honey's pending record.
5. The module accepts that record only from the pinned factory and only for the
   exact predicted Safe/configuration. It consumes the record once. Setup asserts
   the final owner/module/fallback/guard policy before returning.
6. The transaction clears the record and emits the full public deployment metadata.
   Any failure reverts both deployment and record changes.

Calling Safe's factory directly with the same initializer must fail when there is
no valid pending record. Otherwise an attacker could reserve the predicted address
with their own authority. This first-claim attack is a mandatory negative test.

## Authority that must not survive setup

The bootstrap key must not become an ordinary Safe owner, module, fallback signer,
guardian or upgrade administrator. There must be no “reset” or reinstall method
that accepts it after deployment. A module used as the sole Safe owner must never
give generic ERC-1271 approval to Safe transactions: that would recreate an owner
execution path outside rotation. Final configuration tests must exercise real Safe
owner signatures, approved-hash signatures, modules, delegatecalls and fallback paths.

Recovery remains a separate design. Reusing the bootstrap key as an unrestricted
recovery signer would invalidate the authority boundary above. Seed restoration
needs no reset: it re-derives the currently committed owner from verified chain state.
Guardian recovery needs its own delay, veto, replay and compromised-device policy.

## Tradeoffs requiring explicit review

- The bootstrap identity may sign once for **each network**. Therefore the product
  claim must refer specifically to rotating transaction owners; “no key signs
  twice” is not true of the whole wallet. The restricted signing API and disjoint
  hardened branch are now implemented in [BUNK-EVM-CLIENT.md](BUNK-EVM-CLIENT.md).
- The deployment certificate does not expire and has no separate cancellation
  mechanism. Relaying it installs only the exact approved initial owner/configuration;
  it cannot be used after initialization.
  The client must derive and verify that configuration independently and explain
  this scope. This removes a timestamp read that canonical bundlers prohibit in
  account creation; it does not relax transaction or gas-sponsorship expiry.
- If this identity is compromised before deployment on another chain, an attacker
  may authorize malicious first deployment there. Do not suggest sending funds to
  a predicted address before verifying that chain's completed deployment. A stolen
  recovery phrase already compromises every derived branch.
- The factory, setup helper and configuration assertions become security-critical.
  Hash commitments alone do not secure initialization.
- Same addresses still require compatible and identically addressed Safe factory,
  singleton, proxy bytecode, Honey module and helper deployments. “Safe exists” is
  insufficient evidence for network support.
- A first-release allowlist must pin the full dependency deployment/code matrix.
  Future networks must pass the same checks; chain names alone are not an allowlist.

## Acceptance tests before integrating this proposal

- Same identity/account produces the same Safe address on two distinct chain IDs,
  while current owner commitments and owner keys differ.
- Changing any network commitment changes the bootstrap signature but does not
  change the Safe address for the same identity/account.
- A certificate cannot cross chains, factories, accounts or versions. A valid old
  certificate can deploy only its exact approved configuration, once.
- Direct factory calls, empty/forged pending records, reentrant setup and a second
  initialization fail; failed setup leaves no deployed account or usable record.
- Bootstrap signatures cannot execute, change owners, enable modules, configure
  fallback/guards, recover funds or reinitialize a deployed account.
- Actual Safe/EntryPoint tests cover successful execution, reverted downstream
  execution, rejected validation, gas exhaustion and concurrent operations.
- Recovery from only the documented backup plus chain reads finds the exact active
  commitment and cannot accidentally take the bootstrap signing path.

The alternative is different Safe addresses per network with initial commitments
directly in the initializer. That is simpler, but changes an explicit requirement
in the supplied brief; it must not be substituted silently.
