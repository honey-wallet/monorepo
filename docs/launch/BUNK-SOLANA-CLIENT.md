# Solana phrase client

**Threat-model limitation:** [recovery-target preemption](RECOVERY-TARGET-PREEMPTION.md)
requires control of the current signing key, which already grants spending authority.
Recovery under active key compromise is not a launch guarantee. This finding alone
is not a launch blocker; normal seed restore and interrupted-operation checks remain required.

The shared client in `packages/keyring/src/bunk-solana.ts` prepares initialization,
native/CPI execution and independent recovery for the candidate Solana program.
It derives public roles, predicts wallet/spent-key PDAs, validates account encoding,
binds ordered action accounts/privileges and constructs the canonical Ed25519 proof
from an already-produced signature. These are protocol primitives; application
signing still requires a durable journal and a trusted finalized chain observer.

## Recovery format

The new **derivation version 2** is separate from **wire protocol version 1**.
Existing `bunk.ts` version-one paths and ordinary Solana paths are unchanged.
There is no automatic migration or reinterpretation of an existing account.

Every component is hardened:

```text
m/7744'/2'/role'/501'/genesis[9]'/program[9]'/account'/[epoch']/[ownerIndex']
```

`genesis[9]` and `program[9]` each encode the full 32-byte value as nine big-endian
base-2^31 digits, including leading zeros. Role 2 is deployment identity with no
epoch or owner index. Role 0 is owner with both epoch and owner index. Role 3 is
recovery with epoch only. Indices are 0 through 2^31−1. SLIP-10 uses the BIP-39
64-byte seed and Ed25519 hardened derivation. Secrets and intermediate buffers
are cleared after use, subject to JavaScript's garbage-collector/copy limitations.
[SLIP-10 specification](https://github.com/satoshilabs/slips/blob/master/slip-0010.md).

Genesis and program separation apply to every role. The deployment identity and
wallet PDA stay constant through ordinary rotation and generation recovery within
that release. A different program or network intentionally produces a different
identity and address. A release registry and account backups must preserve the
exact scope; a phrase alone does not discover which releases were used.

## Preparation and authority checks

Account parsing verifies exact 157-byte layout, program ownership, non-executable
status, network, identity/account index, canonical PDA/bump, counters and distinct
nonzero roots. Parsing does not establish RPC honesty, freshness or finality.
Execution additionally checks phrase-derived deployment, owner and recovery keys;
the next owner is deterministically derived. Recovery requires matching deployment
and recovery authority, and can repair an unknown current owner without signing
with it. The new epoch's owner/recovery keys are deterministic and distinct.

The recovery digest omits ordinary owner index, nonce, current-owner tombstone,
payer and blockhash. A relayer can refresh the current-owner tombstone after an
ordinary advance without changing the certificate. Replay fails once the epoch
changes. Execution binds epoch, index, nonce, slot window, next commitment and
the ordered action program/accounts/flags/data. Slot/nonce/amount fields use bigint;
lossy JavaScript numbers are rejected at the u64 boundary.

The client mirrors the candidate's current single-CPI policy: only the wallet may
be a downstream signer, with read-only state; duplicate/control accounts, other
signers and self-invocation reject. This does not complete broad trading, native
wrapping, token-extension or website-signature compatibility. Instruction bounds
also do not establish full transaction packet size or resource requirements.

Both program and client reject using current deployment/owner/recovery authorities
or the selected successor authorities as the transport payer. The successor check
was added after a compiled regression demonstrated that a next owner could sign
the transport before becoming current. This is a local structural guard, not proof
that a payer is unrelated to every historical or future phrase-derived key. An
integration must use a distinct sponsorship identity and durable signing history.

## Acceptance and remaining work

An independent Python/OpenSSL generator freezes four network/program/account scopes,
28 role-key descriptors and 16 initialization/native/CPI/recovery encodings, hashes
and signatures. Public phrase fixtures are intentionally unsafe for funds. Native
and CPI vectors signed at the same index are alternative test cases; applications
must never issue both approvals.

The package entry point exports public derivation and unsigned preparation, not
the internal raw-key primitive used by isolated fixture tests. No app receives an
unconditional new signing API. A persisted one-digest claim, exact reconstruction,
finalized observation, lost-history recovery and production registry verification
must be connected before activation. The [journal and finalized observer](BUNK-SOLANA-JOURNAL.md)
now implement local persistence/reconstruction and release/state checks; app
integration and trusted registry distribution remain. Active-key-compromise recovery
has the documented limitation above.
Seed theft, old-device authority, whole-store
rollback and previously approved token delegates remain separate concerns.

The full launch scope remains in [REVIEW.md](REVIEW.md), and current measurements
and test outcomes belong in [VALIDATION.md](VALIDATION.md).
