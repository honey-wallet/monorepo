# Bunk signed-but-unconsumed recovery

Status: experimental protocol work for launch blocker L14. A separately versioned
[Safe implementation](BUNK-EVM-V2.md) now passes 33 integration tests. The v1 Safe
module, deployment configuration and keyring signature format are unchanged.
Nothing here enables Bunk in an app or authorizes production funds.

## Failure that must be handled

The current owner signs the complete EntryPoint operation, including fees,
initialization and expiring sponsorship. If the operation expires before inclusion,
the on-chain owner does not change. Repeating its bytes cannot succeed; changing
those bytes needs another owner signature. A relayed deployment certificate can
also create the account before the operation lands, making its original initCode
invalid. These are ordinary retry cases, not exceptional seed recovery.

The desired outcome is one owner authorization, at most one on-chain consumption,
renewable delivery within approved limits, and a way to discard an expired action
while rotating to the next owner. Expired action cleanup must have distinct receipt
evidence: rotation success is not trade success.

## Candidate authority split

The owner signs a typed certificate binding chain/domain, EntryPoint, account,
nonce, calls hash, fixed verification/call/pre-verification gas, maximum total gas
liability, permitted paymaster, current index, successor commitment, Merkle root of retry keys,
start time and action deadline. That certificate cannot be widened by a relayer.

A delivery envelope signs the exact EntryPoint userOpHash. Account validation checks
both the certificate and envelope. It consumes the owner and reserves that exact
operation hash before execution, retaining rotation if execution later fails.
Only fees within the approved ceiling and approved sponsorship/funding may vary.
Gas limits and calls cannot be lowered/changed to force an early cleanup. Omitting
initCode after separately verified deployment must not require another owner signature.

The action deadline is enforced in execution, where timestamp reads are permitted.
Before the deadline the approved calls run; afterwards they are skipped, a distinct
`ExpiredActionSkipped` event is emitted, and only rotation/gas payment occur. The
certificate itself remains usable for this bounded cleanup. `validAfter` is still
enforced by EntryPoint, so a relay cannot consume it before the approved start.
A funded account can fall back from Honey sponsorship within its explicitly signed
gas budget. The UI must disclose that liability even when Honey normally pays.

## Preserve one-time transaction keys

A reusable envelope key is a useful execution baseline, but does **not** satisfy
the brief's literal no-key-signs-twice requirement. It must not be adopted silently.
The implemented test candidate uses a certificate-bound Merkle root of 256 distinct one-time
envelope keys. Each attempt carries its leaf index, public signer, proof and one
signature over the exact operation. Fresh fees or grants use a fresh leaf; the
rotating owner certificate stays identical. Each owner index/network needs a
separate derived leaf set. No derivation path is frozen by this document.

The candidate reserves the final leaf for deterministic, self-funded recovery after the action
expires. It uses no paymaster, no initialization, no action calls, and a fixed
fee derived from the signed liability ceiling. It has no expiring sponsor grant
and can be rebroadcast unchanged. The account must already be deployed and funded.
This avoids spending the last leaf on an envelope that itself expires. Finite retry
capacity, future chain/gas-rule changes and network fees above the approved ceiling
remain explicit limits; no transaction scheme guarantees inclusion under censorship.

## Recovery data and coordination are still required

A local journal must reserve the owner certificate and each leaf atomically before
revealing any signature. Two devices must not allocate the same leaf to different
operations. A dropped or expired operation cannot release that reservation.
An on-chain nonce prevents double settlement but cannot prevent two offline signatures.

The seed reconstructs keys, not arbitrary approved call data or the certificate's
intent fields. Losing all pending-intent metadata is still a recovery gap. Before
activation, specify independent encrypted backup/replication or durable on-chain
certificate publication; a Honey-only database cannot be the sole recovery source.
The reserved recovery envelope can omit original call data, but still needs the
owner certificate and proof. Do not claim seed-only recovery until this is solved.

## Verification and remaining adoption gates

The test-only standalone account in `packages/bunk-evm/test/recovery/` passes
18 tests against real EntryPoint 0.7 and the existing Honey paymaster, including
256 fuzz cases over certificate fields. Tests assert unique envelope-key allocation,
all 255 ordinary leaves followed by reserved recovery, unchanged-byte rebroadcast,
fee/grant renewal, deployment races, deadline behavior, failed execution and successor
action. All 27 existing Safe tests also pass. It is not a Safe deployment,
bootstrap design, production registry or client implementation. Existing Safe tests
continue independently. The local real-bundler probe lives in
`packages/bunk-evm/test/bundler/recovery.mjs`. The pinned Geth/Alto safe-mode run
passed expired-grant rejection, fresh-leaf sponsored cleanup, next-owner execution
and reserved-leaf self-funded cleanup. The expired intent has one owner signature;
all four envelope signatures use distinct keys. See
[contract evidence](evidence/bunk-recovery-local.json) and the `experimentalRecovery`
section of [bundler evidence](evidence/bunk-bundler-local.json).

Existing derivation paths stay frozen. A new deployment/protocol must not silently
reuse a previously exposed owner at the same seed/network/account/owner tuple.
Any migration from an already-used account needs a fresh account index (or an
explicitly versioned derivation migration), with backup metadata preserving both.
No production history or migration is inferred from these public test fixtures.

Before adopting the candidate:

- Prove one-time retry allocation, last-leaf recovery, proofs and all certificate
  scope checks; compare independently encoded typed hashes/signatures.
- The [v2 shared client](BUNK-EVM-V2-CLIENT.md) now implements separate owner/envelope
  signing and finalized Safe observation. Complete its durable app integration while
  preserving all bypass, failure and replay controls.
- Re-run real sponsored counterfactual creation, gas/size/fork checks and current
  production-provider acceptance; a standalone account passing is insufficient.
- Independent v2 derivation/signature vectors now exist. Complete durable journals,
  backup/discovery, two-device coordination, receipt outcomes, user review and
  migration/activation.
- Obtain independent review of the permanent bounded recovery authority and retry
  scope. Existing expiry behavior cannot change silently for a deployed account.

Reference: [ERC-4337 account interface](https://eips.ethereum.org/EIPS/eip-4337)
describes exact operation signatures and separate account validation/execution.
This implementation targets the locally pinned EntryPoint 0.7 sources; a later
specification or bundler is not assumed compatible without testing.
