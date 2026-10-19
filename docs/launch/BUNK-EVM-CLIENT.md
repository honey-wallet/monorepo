# Bunk EVM client signing and integration boundary

Implemented in `packages/keyring/src/bunk-evm.ts`, `bunk-evm-sign.ts` and
`bunk-evm-observe.ts`, exported by
`@honey-wallet/keyring`. No app/backend signing flow has been enabled by this change.

## Frozen recovery branches

The rotating-owner path remains unchanged. Deployment-only EVM identities now use:

```text
m/7744'/1'/2147483647'/60'/accountIndex'
```

The third component `2147483647` is reserved for deployment identities; owner coin
branches remain `0`, `60` and `501`. Every component is hardened. Neither branch is
an ancestor of the other. The deployment identity depends on the account index,
not the network, so compatible deployments can retain one Safe address across EVM
chains. Its certificate still binds a specific chain and exact configuration.
Never repurpose this identity for website signatures, ownership, gas sponsorship,
recovery or resetting an account. The API exposes its public descriptor and
restricted certificate signing, not its private key.

Both branches restore from the same BIP-39 seed. No current owner path/vector was
changed. Future changes to either path require versioned migration.

## API flow

1. Obtain a **trusted** `BunkEvmConfig` from a release deployment registry. It contains
   exact dependency addresses/runtime hashes and Safe proxy creation code. Verify
   those against the intended chain with `observeBunkEvmAccount` (below).
   `bunkEvmConfigHash`, `bunkEvmInitializer` and
   `predictBunkEvmAccount` compute the contract's values offline; accepting a remote
   hash getter alone is insufficient.
2. `signBunkEvmDeployment(seed, config, accountIndex)` derives owner zero, predicts
   the Safe, signs the deployment certificate and returns `factoryData`. The caller
   cannot replace the first owner commitment. The certificate is permanent and may
   be relayed later, only for its approved initial configuration.
3. Build reviewed calls with `encodeBunkEvmCalls`. Only bounded CALL batches are
   supported; self-administration, module, factory and EntryPoint targets fail.
   The decoder requires canonical ABI, so appended bytes and alternative encodings
   cannot disagree with the review payload.
4. Obtain the exact Honey sponsor grant **before** the owner signs. The owner signer
   verifies its low-S signature, paymaster identity, epoch, operation binding,
   validity coverage and cost cap against supplied trusted sponsor state. Changing
   gas or calldata after sponsorship invalidates that approval.
5. `signBunkEvmOperation` checks the seed-derived account, current commitment/index,
   EntryPoint nonce, initialization certificate, call batch and explicit maximum
   gas liability. It derives the successor itself; callers cannot redirect it.
   It returns the packed operation/signature, hashes, public current/next owners,
   decoded calls and maximum gas cost. Temporary private-key bytes are cleared.
   JavaScript clearing is best effort, not a claim of hardware-backed isolation.

There is no generic digest/message-signing API for either Bunk authority. EOA
message/permit signing helpers must not receive these keys. The client targets
EntryPoint 0.7, Safe 1.4.1, nonce key zero, the tested gas/size limits and Honey's
empty-postOp-context paymaster. It does not silently support another account version.

## Finalized account observation

`observeBunkEvmAccount(rpc, input)` requires a caller-trusted release config, the
SafeProxy runtime hash, public deployment identity/index, caller clock and explicit
maximum finalized-block age. The transport supplies raw JSON-RPC results and must
bound request time and response size. It must implement the `finalized` tag and
[EIP-1898 block-hash reads](https://eips.ethereum.org/EIPS/eip-1898); unsupported
providers fail without retrying against `latest` or `safe`.

The verifier checks exact chain ID, pins every code/getter read to one finalized
hash with `requireCanonical: true`, then rechecks the canonical number/hash and
chain ID at completion. Freshness is checked before and after the reads. It checks
all six dependency runtime hashes, their links, factory configuration/initializer,
proxy creation code, predicted address, owner commitment/index and EntryPoint
key-zero nonce. A deployed account additionally needs the pinned proxy runtime,
Safe 1.4.1, sole module owner and threshold one, exactly the expected enabled module,
correct singleton/fallback slots, no guard, and a registered current commitment.
An empty account with nonzero commitment/index/nonce is rejected.

The result discriminates `undeployed` (no invented signing state) from `deployed`
(with exact signing state), and includes its block hash/number/time. For initial
creation, obtain owner zero from the seed and require the undeployed observation.
For deployed signing, compare the returned state against the seed-derived owner via
`signBunkEvmOperation`. Keep the block evidence with the operation journal.

**Trust and latency limits:** a malicious RPC can lie consistently. Registry hashes
must come from a reviewed release artifact, not the same RPC. This primitive is not
a consensus/light-client proof or a network-specific finality policy. A finalized
snapshot also cannot rule out a newer pending/unfinalized operation. It must never
by itself authorize signing twice with the same owner, even if a previous operation
is missing or expired. App integration still needs durable reservations and recovery.
Paymaster signer/epoch/budget/deposit/grant state is not checked by this observer.

## Required caller work still outstanding

The signing APIs are offline primitives. A structurally valid config/state object
is **not** proof of chain state. Before production integration, implement and test:

- A reviewed release registry and network-specific RPC/finality policy, wired to the
  implemented observer. No production registry is supplied here. Local test hashes
  assembled from the dev deployment are not a release trust anchor.
- Persisted observation/reorg handling, encrypted local operation journaling and atomic
  per-account/network approval locks. Persist exact approved bytes before exposing
  a signature. Repeating this pure function produces the same deterministic
  signature; it does not enforce “one signature ever” or coordinate two devices.
  Expiry must not free a signed owner's reservation: see the signed-but-unconsumed
  recovery blocker in [BUNK-PROTOCOL.md](BUNK-PROTOCOL.md). Current expired envelopes
  cannot be retried successfully, while changing them violates the strict policy.
- Sponsor service authentication, grant reuse/deposit/budget checks, staleness and
  validity checks at submission, and receipts tied to the exact operation. These
  offline checks cannot prove an RPC honest or a grant still unspent/funded.
- Backup/discovery and recovery after a failed execution, missing backend or device
  loss. A failed action can still consume the owner; advance from finalized chain
  evidence, never merely from returning a signature.
- Trusted user review of destination, assets, approvals, fees and network; UI
  activation/fund migration; provider-specific contract-wallet compatibility.

## Evidence

`bunk-evm-v1.json` contains three **public test-phrase** vectors for deployment
identity, CREATE2 prediction, initializer, config hash, certificate signature,
operation hash and encoded owner signature. Its synthetic registry is explicitly
not deployable. `scripts/bunk-evm-vectors.py --check` independently derives BIP32
with Python HMAC/OpenSSL and computes ABI, Keccak and ECDSA with Foundry, without
importing Honey TypeScript, Noble, Scure or viem. Existing eleven multichain owner
vectors still pass their separate oracle.

The keyring suite includes 24 codec/signing tests and 37 adversarial observation
tests. The real Geth/Alto
harness also passes all seven mined/rejection cases using this client API and
compares all relevant contract getters. It now observes account state through the
new verifier before signing and after each receipt, waiting for Geth dev finality.
This exercises simulated finality every 32 blocks, not production consensus. Source hashes and receipts are in
[evidence/bunk-bundler-local.json](evidence/bunk-bundler-local.json). Network/bundler
limits from [EVM-CONTRACTS.md](EVM-CONTRACTS.md) remain open.
