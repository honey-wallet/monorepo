# Bunk v1: recovery format and integration contract

Status: key derivation and a local Safe/EntryPoint/paymaster implementation are
tested; the complete account protocol remains under validation. See
[EVM-CONTRACTS.md](EVM-CONTRACTS.md). This does not make Bunk available for real funds. Read
[REVIEW.md](REVIEW.md) for decisions and the full launch acceptance checklist.

## Implemented derivation format

`packages/keyring/src/bunk.ts` exports `bunkOwnerPath`, `bunkPrivateKeyFor`,
`deriveBunkOwner`, and `deriveBunkRotation`. Ordinary `PATHS`, `privateKeyFor`,
and existing wallet derivation remain unchanged. Bunk keys must not be passed to
ordinary EOA or website-signing flows as if they were the user's account address.

All inputs derive from a 64-byte BIP-39 seed. The version-one path is:

```text
m/7744'/1'/coin'/network[0]'/.../network[8]'/account'/owner'
```

Each component is hardened. `coin` is 60 (EVM), 501 (Solana), or 0 (Bitcoin).
`network` is the fixed-width, big-endian base-2^31 representation of the network
integer; it always has **nine** components, including leading zeroes. This encodes
a complete 256-bit value without hashing, truncation, or JavaScript precision loss.
The leading component is at most 255. The full path has fourteen child steps.

| Family | Network integer | Derivation | Owner commitment |
| --- | --- | --- | --- |
| EVM | Positive uint256 chain ID, supplied as canonical decimal string | BIP-32 secp256k1 | Keccak-256 of the raw 20-byte recovered signer address |
| Solana | Big-endian integer from the full 32-byte genesis hash, supplied as canonical base58 | SLIP-10 ed25519 | SHA-256 of the raw 32-byte public key |
| Bitcoin | Fixed registry: mainnet=0, testnet=1, signet=2, regtest=3 | BIP-32 secp256k1 | HASH160 of compressed SEC1 public key (20-byte witness program) |

Cluster nicknames, truncated Solana CAIP references, negative/float indices,
noncanonical decimal strings and unknown Bitcoin networks are rejected. A network
change is not an account migration: it derives a different key by definition.
Other Bitcoin test networks require a future explicit registry addition; an unknown
network must not fall back to testnet. Forks that share a chain ID/genesis identity
are outside this separation guarantee.

EVM example, chain 1, account 0, owner 0:

```text
m/7744'/1'/60'/0'/0'/0'/0'/0'/0'/0'/0'/1'/0'/0'
```

Account and owner indices are integers in `[0, 2^31-1]`. The last owner can be
derived for recovery; `deriveBunkRotation` rejects it because no successor exists.
Never wrap to zero. A BIP-32 invalid-child retry is rejected rather than silently
aliasing the next owner's path. A production recovery protocol must specify how
an exhausted branch migrates before allowing the terminal owner to transact.

`deriveBunkOwner` returns public metadata only and clears its temporary private-key
array. `bunkPrivateKeyFor` returns caller-owned secret bytes; the caller must clear
them after signing. JavaScript GC, library-internal copies and bigint storage mean
this is best-effort clearing, not a guarantee against process-memory compromise.
The seed remains caller-owned and is never cleared or mutated by these helpers.

`ownerAddress` means an EOA/ed25519 signer address or Bitcoin receiving address.
It is **not** a Safe/PDA address. The EVM client now predicts Safes and signs
restricted deployment certificates; Solana account prediction remains separate
unfinished work. EVM commitments hash addresses for compatibility with `ecrecover`; their
preimage security is bounded by the 160-bit address space. Bitcoin's commitment
is its native P2WPKH witness program, not a synthetic 32-byte on-chain field.

EVM deployment-only identities use the distinct hardened v1 branch
`m/7744'/1'/2147483647'/60'/account'`. The third component `2147483647` is reserved
for this role and must never be assigned to an owner coin branch. This identity
is chain-independent, while its certificate and each rotating owner remain
network-bound. The signing API and independent vectors are documented in
[BUNK-EVM-CLIENT.md](BUNK-EVM-CLIENT.md).

## Backup and recovery invariants

Persist public `derivationVersion`, exact network identity, `accountIndex`,
deployed account address, deployment version/code identity and last finalized
observation. A cached `ownerIndex` is a scan hint, never authority to sign.
Bitcoin additionally requires all used receive/change indices and UTXO discovery
with a documented gap policy. A recovery phrase alone can regenerate keys, but
cannot cheaply discover arbitrary sparse indices or an unknown deployment registry.
Backup serialization and chain scanning are still to be implemented.

Recover account state from the verified chain, even when Honey's backend is down.
Re-derive the current commitment and require an exact match before exposing a
signing action. Check the contract/program code, execution policy, chain identity,
finality and account binding. Refuse inconsistent state; never search unbounded
indices, silently reset to zero, or trust a backend-supplied next commitment.

Concurrent phone and extension use must bind approval to the same confirmed index
and operation. Stale approval must fail before signing. A chain nonce prevents two
operations from settling at one index, but cannot stop two offline devices from
revealing signatures with that index. Thus literal “a key never signs twice” also
requires a coordinated signing policy and cannot be promised from derivation alone.

## Required EVM operation state machine

1. **Observe:** verified account has `(index=i, commitment=C_i)` on a specific chain.
2. **Prepare:** bind account, chain ID, module/EntryPoint version, index, next
   commitment, complete calls, amounts, fee policy, expiry and operation nonce.
   Any paymaster or operation mutation needs revalidation before signing.
3. **Approve/sign:** show the actual operation and derive only `i`. Record the exact
   signed payload locally before attempting delivery; submitting it twice must be
   idempotent. The derivation helper itself changes no persistent state.
4. **Validate:** authenticate the exact operation under `C_i`. The proposed
   ERC-4337 design consumes this owner and reserves one authorized execution during
   successful on-chain validation, binding its reservation to the full operation.
   Bundler simulations do not count as on-chain consumption.
5. **Execute:** execute only the reserved operation. Do not allow an arbitrary
   caller, another operation, or a fallback path to consume that reservation.
   A failed downstream call must have an explicit receipt and must not restore
   authority to a revealed owner if the validation transaction was retained.
6. **Reconcile:** distinguish validation failure, execution failure with consumed
   owner, dropped operation, replaced operation and chain reorganization. Refresh
   authoritative state before retrying or advancing the local index.

### Signed-but-unconsumed recovery remains unresolved

The current owner authorization expires within one hour. If it is signed but never
included, expiry does not rotate the owner or advance the nonce. The existing
`testInvalidSignatureAndExpiredWindowRollBackValidation` test demonstrates this
against the actual EntryPoint. Replaying those exact bytes is no longer valid;
changing the validity, gas or sponsorship requires a different owner authorization.

Therefore a literal one-signature-per-owner policy plus current expiring envelopes
has a liveness gap. Deleting a journal reservation on expiry or seed restore would
silently break that policy. Seed derivation, finalized observation and the permanent
first-deployment certificate cannot repair an already-deployed account's state.
Recovery for signed-but-unconsumed owners needs an explicit reviewed protocol:
possible redesigns separate one-time owner consent from renewable execution envelopes
or add narrowly constrained recovery authority, each with different replay, censorship
and trust risks. A test-only scoped Merkle retry candidate is now described in
[BUNK-RECOVERY-DESIGN.md](BUNK-RECOVERY-DESIGN.md); it is not integrated into the
Safe/client protocol or approved for release. Treat this as a launch blocker,
including sponsorship revocation, missing journal data and gas-price changes.

A local adapter now targets actual EntryPoint 0.7 and Safe 1.4.1, with tests for
multiple operations, downstream failure, gas exhaustion and bounded sponsorship.
The pinned local Alto/Geth harness now verifies storage/staking admission and
opcode/signature rejection; current-provider and per-network acceptance plus
reservation cleanup remain open. The paymaster returns an empty context,
so no custom post-operation handler is invoked. Do not treat direct `handleOps`
tests as canonical mempool acceptance.

Safe installation must close ordinary owner execution and unauthorized module,
delegatecall, fallback and recovery routes. Restricting one entry point is not
sufficient. Recovery must not introduce an unreviewed permanent execution key.
The same-address requirement remains open pending a deterministic bootstrap design
that does not reuse rotating owners across networks or permit first-claim takeover.

## Solana, Bitcoin and off-chain signatures

The Solana program needs a signed, network/account/index-bound operation, verified
owner commitment, atomic successor update, strict CPI account/privilege checks,
and PDA authorization. CPI failure/transaction rollback must be specified honestly:
rollback can leave an exposed current owner in place. A PDA cannot replace an
ordinary dApp ed25519 signer without provider/program compatibility work.

Bitcoin needs actual UTXO spend/change policy. Receiving new coins at an old address
can require later use of its key. Multi-input spends, replacements, failed broadcasts
and reorgs invalidate a blanket one-signature-per-key promise. New change addresses
alone do not implement coin selection, recovery, replacement policy or no-reuse.

Do not sign SIWE, arbitrary personal messages, permits, CLOB orders or perps-agent
authorizations with the current rotating owner by default. Define a separate scoped
identity/session scheme and test each provider's account model. ERC-1271 cannot rotate
state during signature validation; compatibility needs a separate design, not an
extra call to `signEvmTypedData`.

## Evidence

- `packages/keyring/src/fixtures/bunk-v1.json`: eleven fixed vectors from the public
  BIP-39 “abandon … about” phrase, covering chains, successor indices, the maximum
  EVM chain ID, terminal owner index, Solana and four Bitcoin networks.
- `packages/keyring/scripts/bunk-vectors.py --check`: independent HMAC/PBKDF2 and
  OpenSSL key derivation with Foundry `cast keccak`; no Honey/Noble/Scure imports or
  network calls. Requires Python `cryptography` and `cast` on PATH.
- `packages/keyring/src/bunk.test.ts`: vectors, isolation, bounds, public metadata,
  invalid-child rejection and native address/commitment encodings.
- Existing ordinary-wallet address/signing/backup tests remain in the keyring suite.
- Standards: [BIP-32](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki),
  [SLIP-10](https://github.com/satoshilabs/slips/blob/master/slip-0010.md), and the
  Safe/ERC-4337/ERC-1271/Solana sources linked in [REVIEW.md](REVIEW.md).

No contract deployment, backend tracking, Bunk-enabled UI, device test or mainnet
acceptance is implied by these primitive tests.
