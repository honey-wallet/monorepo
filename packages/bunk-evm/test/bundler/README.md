# Real bundler acceptance harness

Run from this folder after installing the Solidity sources and running `forge build`
in `packages/bunk-evm`:

```sh
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
python3 run.py --output /tmp/honey-bunk-bundler-evidence.json
```

Install the keyring's existing workspace dependencies from the repo root first:
`pnpm install --filter '@honey-wallet/keyring...' --frozen-lockfile --ignore-scripts`.

Requires Docker, Python 3, Node 22.22.3 and pnpm 10.26.0. Tool dependencies use a
separate workspace/lockfile. The app's dependencies are not changed.

The runner starts a unique, disposable Geth chain and an unmodified Alto 0.0.18
container. Both Docker images are pinned by digest. It exports Geth's complete
dev genesis, preserves its system contracts and explicitly selects Osaka (removes
the later Bogota/Amsterdam activation). Genesis funds only public test keys.
Geth has no peers; RPCs are published only on random localhost ports. No external
RPC URL, production signer or real ETH is accepted by this harness. Containers and
the dedicated network are removed in `finally`; logs remain in the printed temp
folder. On abrupt termination, remove only containers with this run's printed
`honey-bunk-<id>` prefix.

Alto runs with `safe-mode=true`, `dangerous-skip-user-operation-validation=false`,
expiration checks enabled, and EIP-7623 calldata pricing. No validator patch,
whitelist, storage override for the wallet, or disabled opcode rule is used.
The factory and paymaster each stake 1 test ETH with a one-day delay. The paymaster
has a separate deposit and maximum-liability budget.

The test asserts both admission **and actual chain receipts/state**, covering:

- A changed signed gas field is rejected, leaving the account undeployed/nonce zero.
- A deliberately invalid test account using `TIMESTAMP` is rejected by opcode checks.
- A sponsored account with an unstaked factory is rejected by storage/stake checks.
- An unfunded counterfactual account is created and executes a sponsored action.
- A reverting sponsored action consumes the owner and nonce; the next owner acts.
- An already-deployed account funds its own operation through the Safe prefund path.

The administrator/sponsor keys are intentionally public short scalar fixtures.
Wallet deployment and rotating owners now use the public BIP-39 test phrase through
the actual keyring client API. The harness computes configuration, initializer,
prediction, deployment/owner/sponsorship digests and EntryPoint hash locally, compares
each with deployed contract getters, then submits the client-generated signatures.
Node 22's native TS stripping plus a small relative-import resolver loads the exact
keyring source; no crypto or validator implementation is patched. Independent
Python/OpenSSL/Foundry vectors additionally cover chains 1/8453 and account 7.
Account state before signing and after each included operation now passes through
`observeBunkEvmAccount`: code identities, Safe configuration, commitment and nonce
are read at a single finalized hash with EIP-1898 canonical checks. The harness
waits for Geth dev's simulated finality every 32 blocks, including after the reverted
action. The run can take several minutes. This tests the verifier against real
contracts; local hashes learned from the deployment are not a production registry,
and dev finality does not prove production consensus or multi-device safety.

## Isolated recovery protocol probe

After the existing Safe cases, `recovery.mjs` deploys a **test-only standalone**
account implementing the scoped recovery candidate. The owner signs one certificate
with a Merkle root of distinct one-time envelope keys; each fee/grant attempt uses
a fresh leaf. It checks an expired grant rejection, renewed sponsorship consuming
the owner while skipping expired calls, a succeeding next-owner action, and the
reserved final leaf with deterministic self-funded fees and no calls. All envelope
signer addresses are checked for reuse; receipt events distinguish rotation cleanup
from action execution. Typed certificate hashes are compared with the contract.

This is not Safe integration or a production protocol selection. It leaves the
existing Safe contracts, client format and derivation paths unchanged. The probe's
local key scalars are public test values, not a key derivation specification.
Design, limitations and remaining gates: [recovery design](../../../../docs/launch/BUNK-RECOVERY-DESIGN.md).

## Safe recovery version 2 probe

`safe-recovery.mjs` then runs the candidate through a real Safe 1.4.1 proxy,
versioned factory/module and EntryPoint. It independently computes the v2 deployment
prediction and typed certificate hashes, checks all Safe authorities, and rejects
an unstaked factory, changed signed fees and expired sponsorship. Renewed sponsorship
creates the Safe and skips the expired action; the successor executes an action,
and reserved leaf 255 performs self-funded cleanup. A final sponsored operation
withdraws the Safe's entire EntryPoint gas deposit back to the same Safe, checking
both balances and the execution event. Every owner signs one intent and each exact
envelope uses a distinct leaf signer.

The probe uses public scalar fixtures. It does not implement the v2 shared client,
seed derivation, durable intent backup or concurrent-device coordination. The v1
client and original Safe cases remain separate. See the [v2 protocol and gates](../../../../docs/launch/BUNK-EVM-V2.md).

## Scope and incompatible configurations

This proves interoperability with the pinned historical Alto release on this
explicit local fork. It does not certify current hosted providers, finality across
consensus nodes, production configuration, other networks or an audit.

Two exploratory checks remain release gates:

1. Geth 1.17.8's default dev genesis activates Bogota. Direct creation estimated
   1,288,547 gas and the 500,000-gas sponsored creation validation failed AA13.
   The explicit Osaka run estimated 401,296 gas. Do not silently assume a new
   EVM fork preserves the validation budget.
2. Published Alto 0.0.19's safe validator tried to decode the nested
   `DelegateAndRevert(bool,bytes)` selector `0x99410554` using a simulation ABI
   without that error. The actual trace contained a successful simulation payload,
   but the bundler rejected the request before admission. Its installed simulation
   bytecode was identical in the package's `contracts/` and `esm/contracts/` trees.
   No workaround or validation bypass was applied. Current-provider acceptance
   remains required; 0.0.18 is test tooling, not a production service selection.

Unsponsored counterfactual creation also exceeded the 500,000 verification gas
budget in the exploratory Osaka test because it adds the prefunding path. The
launch requires Honey-sponsored creation; this harness separately tests
self-funded operations only after deployment.

## Seed-derived v2 client probe

Finally, `client-v2.mjs` loads the actual shared keyring v2 signer and observer using
Node's TypeScript loader. It derives public test-phrase owner/deployment/envelope
keys, signs one owner intent for sponsored creation, then a different owner intent
for reserved-leaf recovery after expiry. Offline factory, intent, sponsor and
EntryPoint digests are compared with contract getters. Finalized observations verify
full Safe authorities and owner/nonce state before and after the receipts. This
adds local finality waits, so the complete harness takes several minutes. The probe now persists approvals and leaf reservations through the encrypted
SQLite journal, saves signatures before submitting, and reopens the database to
compare exact operation bytes. It deliberately rejects the owner signature save
before sponsored creation and the reserved-leaf signature save before cleanup,
then reconstructs each explicitly from the pinned journal digest. Receipt/finality
checks therefore exercise the reconstructed signatures on real contracts. It does
not provide metadata backup/device recovery,
actual app storage integration or a production registry.

The runner captures source and compiled-artifact SHA-256 manifests before creating
the local chain, and compares them again before writing successful evidence. A
changed tree aborts evidence publication. This matters in a shared working tree;
run from a clean, stable checkout for release verification. The client probe also
records the seed-fixture and keyring entrypoint hashes it read.

## Version 3 independent recovery authority probe

`seed-recovery.mjs` deploys a separate versioned Safe factory/module with account-keyed
transient bootstrap commitments. It tests unstaked-factory rejection, sponsored
creation at the existing 500k verification limit, an independently signed fixed
recovery certificate, unchanged Safe funds/deposit and EntryPoint nonce, rejection
of the dropped old-owner operation and successful next-generation signing. It checks
Safe configuration and a finalized local snapshot. The probe uses public scalar
fixtures; phrase derivation, observer/journal/app restoration remain separate work.
See [v3 design and limits](../../../../docs/launch/BUNK-SEED-RECOVERY-V3.md).

## Version 3 encrypted-backup restore

Validation status: the following describes implemented assertions, not a passing
backup acceptance run. Syntax/lint checks pass, but the attempted full run stopped
in the earlier v3 client with local RPC `ECONNREFUSED`, before this coordinator.
No new backup evidence was published; Docker/local-chain reruns are deferred.

`coordinator-v3.mjs` exports a version-2 encrypted backup for account index 10,000
before simulating a lost counterfactual creation approval. Each recovery worker
decrypts the file, resolves its hint against a separately pinned local release
registry and derives the journal encryption key from the recovered phrase. The
worker receives neither a plaintext phrase nor an encryption key. The local
registry marks the release restore-only; it is not a production deployment registry.

Wrong passwords, modified registry bytes and missing trusted releases reject before
database creation. Imported discovery retains a prefunded undeployed Safe and its
EntryPoint deposit without creating a journal. Explicit recovery then bootstraps
the Safe, survives process death after signature computation, reconstructs the
fixed recovery approval and resets the generation before ordinary signing. The
probe checks unchanged funds and EntryPoint nonce across reset, rejection of the
lost old creation operation, a journal-backed sponsored action, exact persisted
operation reload and finalized owner/nonce advancement.

Final fresh-process discovery retains the recovered wallet, the next prefunded
undeployed account and an empty address; it leaves the journal revision unchanged.
Backup and registry bytes are rehashed. All top-level keyring sources and the root
dependency lockfile are included in the source manifest. Existing v1/v2/v3 admission,
recovery and finality checks remain enabled in the full runner. The resulting
`coordinatorV3.backupImport` evidence is local chain/storage acceptance, not a cloud
upload, packaged-device test, legacy random-key database migration or app activation.
