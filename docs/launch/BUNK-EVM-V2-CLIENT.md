# Version 2 EVM client and recovery format

The shared keyring implements explicit v2 deployment, owner-intent and envelope
signing plus finalized account observation. This is a candidate integration, not
app activation. The [durable signing journal and encrypted SQLite adapter](BUNK-JOURNAL-DESIGN.md)
are now implemented in the keyring. Production registry, app storage adapters,
pending-intent backup/discovery and concurrent-device policy are still required.

## Derivation namespace

All components are hardened. The full positive uint256 chain ID is encoded in
nine big-endian base-2^31 components, including leading zero components, exactly
as the existing network parser specifies. Account and owner indices are 31-bit.

| Role | Candidate path |
| --- | --- |
| Owner | `m/7744'/2'/0'/60'/<network[0]>'/.../<network[8]>'/<account>'/<owner>'` |
| Envelope | `m/7744'/2'/1'/60'/<network[0]>'/.../<network[8]>'/<account>'/<owner>'/<attempt>'` |
| Deployment | `m/7744'/2'/2'/60'/<account>'` |

Attempts range from 0 through 255. The deployment identity is chain-independent;
owner and envelope keys are chain-specific. Version 2 never reuses v1 owner,
envelope or deployment branches. Existing v1 paths and bytes remain intact.
Treat these new paths as a persisted candidate format: any later change needs an
explicit version/migration. Never reuse an account/owner/attempt tuple for another
factory or account configuration; the durable reservation key must span deployments.

No private-key derivation API is exported for v2. Descriptors expose public keys,
addresses and commitments only. Temporary BIP32 nodes and private-key buffers are
cleared on success/error as far as JavaScript permits; engine/library copies are
not a memory-erasure guarantee.

## Approval and retry APIs

`signBunkEvmV2Deployment` signs only the exact versioned factory certificate with
owner-zero commitment derived from the seed. `signBunkEvmV2Intent` validates the
observed account/current commitment/nonce and approved calls, derives the next
owner and 256 envelope keys, and signs the intent once. It returns the intent and
public Merkle proofs for durable storage.

`signBunkEvmV2Envelope` verifies the saved owner signature, seed/state/next-owner
binding, signed gas/call scope and the selected eight-node proof. It derives and
signs only the selected envelope leaf; it does not re-sign the owner or rebuild
all 256 keys. Callers must reserve that leaf durably before signing and retain
identical signed bytes for resubmission. These offline functions do not enforce
one-time use across calls, processes or devices. The journal coordinates normal
signing and provides separate explicit reconstruction APIs for uncertain slots;
[the candidate policy](BUNK-JOURNAL-DESIGN.md#explicit-reconstruction-policy-candidate-review-before-activation)
allows recomputing identical deterministic bytes, never a second distinct approval.

The caller chooses `action` or `cleanup` and supplies a checked time. For ordinary
cleanup leaves, use a trusted chain observation whose timestamp is past the deadline;
a device clock running ahead cannot prove the action has expired on chain. Actions
cannot be signed after their deadline; cleanup cannot be signed before it. The
reserved leaf 255 additionally requires an already-deployed account, no initCode,
no paymaster, no calls and exactly the deterministic fee implied by the signed
maximum liability. A chain front-run that deploys the approved account requires a
fresh observation and a fresh ordinary leaf with initCode removed.

Sponsorship is checked against caller-verified paymaster code identity, signer,
epoch and cost cap. The grant must cover the signing time and the complete worst
case gas liability. A renewed grant can have a new lifetime without another owner
signature. Self-funding remains within the same signed maximum liability. This
verification does not establish the paymaster's current budget or pending usage.

Only canonical zero-value EntryPoint `withdrawTo(sameSafe, amount)` calls are
allowed; arbitrary EntryPoint calls and other recipients are rejected. The client
checks the complete 8,192-byte operation bound with the 1,120-byte v2 authorization.

## Backup integration still required

The current `packages/keyring/src/backup.ts` v1 file encrypts only the mnemonic.
It does not contain v2 configuration, pending certificates, leaf reservations or
saved operation bytes. That file must not be presented as a complete Bunk recovery
backup. A separate versioned format and tested restoration path must preserve these
records, and recovery cannot depend solely on Honey's backend. Include crash and
stale-backup cases; a reserved key cannot simply be released after restart.

## Finalized observation

`observeBunkEvmV2Account` uses the same code/configuration/Safe-authority checks as
v1, but predicts with `HoneyBunkAccountV2` and returns explicitly tagged v2 state.
The v1 and v2 observers reject each other's factory predictions. Every state read
is pinned to one finalized EIP-1898 canonical block, followed by chain/canonical
rechecks and freshness enforcement. Undeployed accounts do not receive invented
chain commitments. The caller may derive owner zero locally after that observation.

A trusted RPC and reviewed code registry remain assumptions. Finalized state does
not exclude a pending operation or a competing device, and the observer does not
replace the journal or a consensus proof.

## Independent and live checks

`packages/keyring/scripts/bunk-evm-v2-vectors.py` derives keys using Python/OpenSSL
BIP32 and computes ABI, Keccak, EIP-712 and ECDSA through Foundry. It imports no Honey
TypeScript, Noble, Scure or viem implementation. Three synthetic public-phrase
vectors cover chains 1/8453, accounts 0/7, owners 0/3/2 and leaves 0/254/255. They
include all 256 envelope addresses, selected proofs, deployment bytes, owner
certificates and complete 1,120-byte authorizations. Never fund fixture accounts.

All 225 keyring tests pass, including 20 journal/storage cases. They compare exact bytes and exercise mutated state/certificates,
proofs, sponsorship, gas limits, high-S signatures, version confusion, withdrawals,
expiry and reserved recovery. `test/bundler/client-v2.mjs` adds actual client-generated
sponsored Safe creation and reserved cleanup, with finalized observations before
and after inclusion. Current run outcomes are recorded in [VALIDATION.md](VALIDATION.md);
source-hashed local evidence remains distinct from public-provider acceptance.

Reproduce the independent check after installing the existing Python cryptography
package and Foundry tooling: `python3 packages/keyring/scripts/bunk-evm-v2-vectors.py --check`.
Run shared tests with Node 22 and `pnpm --filter @honey-wallet/keyring test`.
The independent oracle uses many isolated `cast` calls and can take several minutes.
