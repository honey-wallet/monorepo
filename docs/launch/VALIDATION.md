# Launch work validation

Bitcoin was removed from the wallet on 2026-10-22 (Bunk needs addresses that stay
stable under key rotation). Its validation entries and regtest evidence were deleted
with the code; git history keeps them.

## Requested automated-only verification

On 2026-10-19, root `pnpm lint` and `pnpm typecheck` passed, followed by
`VITEST_MAX_WORKERS=1 pnpm test --env-mode=loose --concurrency=1 --force`.
All seven test/build tasks executed without Turbo test-cache hits; the five
typecheck tasks used existing successful cache entries. Results: 589 keyring,
104 API-client, 34 web, 44 extension, 113 mobile and 157 server tests passed
(1,041 total). Existing exclusions: six mobile skips and 119 server infrastructure
ignores. Log: `/private/tmp/honey-requested-testing-root.log`.

Separately, pinned EVM dependencies, formatting and `forge test --offline -vv`
passed all 121 tests across four suites. Solana's offline acceptance runner
passed vectors, formatting, both compiled SBF builds, warnings-denied Clippy
and all 18 runtime tests, with source hashes unchanged. Logs:
`/private/tmp/honey-requested-testing-evm.log` and
`/private/tmp/honey-requested-testing-solana.log`; raw Solana evidence:
`/private/tmp/honey-requested-testing-solana.json`.

No source changes, Docker, blockchain nodes, validators or live RPC were part
of this run. The root test graph built the extension as a test prerequisite.
These checks do not verify production deployment or the excluded infrastructure.

## Registry update retention and current release handoff

`checkBunkReleaseRegistryUpdate` authenticates both previous and proposed artifacts,
requires a newer revision, and rejects removal of any prior deployment identity.
It reports additions and changed policy/label pairs, including reactivation and
Solana in-place code-policy changes. It does not publish or approve a release,
change app pins or verify deployment state. Seven new cases and all 22 focused
registry/resolution tests pass; package typecheck passes.

Required root lint/typecheck/test checks pass: five typecheck tasks, seven test
tasks and 589 keyring tests. Two typecheck tasks and two test tasks used Turbo
cache; changed keyring tests executed. Existing infrastructure ignores and six
mobile skips remain. Log: `/private/tmp/honey-bunk-registry-retention-root.log`.

The [production handoff](RELEASE-HANDOFF.md) records the current public deployment
inputs and app/backend gaps from source inspection. Account register/fetch and
relay submit remain stubs; no Bunk API calls were found in mobile/extension source.
No production manifest/pin was fabricated, no app/backend source was edited, and
no Docker, blockchain nodes or public RPC checks were run. Deployment records,
application integration and the full production launch remain incomplete.

## Offline contract and compiled-program checks

The root Cargo workspace contains only `apps/server`; root `pnpm test` does not
execute either contract workspace. Both were checked separately without Docker,
validators, bundlers or live RPC:

- EVM: pinned dependency source checks, `forge fmt --check`, offline size build
  and `forge test --offline -vv` passed. All 121 tests across four suites passed,
  with no failures/skips. Existing compilation artifacts were current; Foundry
  reported no source changes requiring compilation. Log:
  `/private/tmp/honey-bunk-evm-offline-tests.log`.
- Solana: independent vectors, formatting, both SBF builds, warnings-denied Clippy
  and all 18 compiled-runtime tests passed. The updated runner pins platform-tools
  1.52 and disables SBF tool installation/network access during acceptance, in
  addition to Cargo's locked/offline flags. Its 14 source hashes were checked
  before/after and again when saving [the evidence](evidence/bunk-solana-offline-local.json).
  Log: `/private/tmp/honey-bunk-solana-offline-tests.log`.

The new `.github/workflows/bunk-solana.yml` covers this isolated workspace with
the same local suite, a checksum-pinned Agave 3.1.11 Linux archive and a separate
dependency/tool preparation phase. It starts no Docker service or validator.
Local YAML, trigger/permission and shell syntax checks pass. The workflow has not
been pushed or executed on GitHub; its first hosted run remains unverified.

Required root lint/typecheck/test commands also pass: five typecheck tasks and
seven test tasks, including cached results for the unchanged 582 keyring tests.
Six test tasks used Turbo cache; existing infrastructure ignores/mobile skips
remain. Log: `/private/tmp/honey-bunk-offline-ci-root.log`. These checks do not
replace public-network, app/device, production deployment or independent-review gates.

## Verified Solana mint precision during restore

Token discovery now deduplicates referenced mints per wallet/program and reads
them in finalized batches of at most 100. Results preserve each batch checkpoint,
validate program ownership, initialization, layouts and authority tags, and expose
base decimals, supply and authorities for initialized mints. Null mint results are
explicitly `status: 'missing'`: earlier holdings remain visible without fabricated
precision. Malformed/omitted records and RPC errors still reject the page. Every
mint checkpoint participates in final anchor/freshness/network/cancellation checks.

Twenty-five tests were added, including all 256 distinct mints across batches,
precision bounds, base/extended mint records, missing mints and mint-only failures.
All 66 focused discovery tests and package typecheck pass. Required `pnpm lint`,
`pnpm typecheck` and `VITEST_MAX_WORKERS=1 pnpm test --env-mode=loose --concurrency=1`
pass: five typecheck tasks, seven test tasks and 582 keyring tests. Two typecheck
tasks and two test tasks used Turbo cache; changed keyring tests executed. Existing
infrastructure ignores and six mobile skips remain. Log:
`/private/tmp/honey-bunk-solana-mints-root.log`.

No Docker or blockchain nodes were started. Mint names/symbols, extension-adjusted
or confidential balances, full asset coverage and app integration remain open.
Independent token and mint checkpoints do not establish one atomic snapshot or
signing authority. See [the API handoff](BUNK-ACCOUNT-DISCOVERY.md#solana-discovery).

## Solana token accounts during restore discovery

`includeTokenAccounts: true` now queries both SPL Token programs after wallet/code
and phrase-authority verification. Each program result retains its own finalized
checkpoint; `minContextSlot` is a floor, not a shared-bank pin. Returned public base
amounts retain zero/frozen accounts and authority fields. Bounded sliced account
data is validated, duplicate/oversized inventories reject, and all token anchors
participate in the final freshness/network/change/cancellation checks.

Thirty tests were added; all 41 focused discovery tests pass using the real wallet
observer with mocked RPC. Required `pnpm lint`, `pnpm typecheck` and
`VITEST_MAX_WORKERS=1 pnpm test --env-mode=loose --concurrency=1` pass: five typecheck
tasks, seven test tasks and 557 keyring tests. Two typecheck tasks and two test tasks
used Turbo cache; changed keyring tests executed. Existing infrastructure ignores
and six mobile skips remain. Log: `/private/tmp/honey-bunk-solana-tokens-root.log`.

No Docker or blockchain nodes were started. Historical validator evidence predates
token discovery. Mint decimals/metadata, extension/confidential balances, large
inventories and app integration remain open. The scanner does not claim complete
assets, token spendability or signing authority. See
[the restore handoff](BUNK-ACCOUNT-DISCOVERY.md#solana-discovery).

## EVM token balances during restore discovery

The v3 scanner accepts up to 32 explicit ERC-20 addresses and returns raw balances
for every candidate, including undeployed/zero-native-balance accounts. Token code
and calls use the verified account block hash; final anchor/network/freshness checks
cover the added reads. Invalid lists, missing/malformed code, malformed balances,
reverts and cancellation reject the page without fabricating zero amounts. Token
identity and catalog completeness remain caller responsibilities; this adds no
signing authority, metadata service or global token enumeration.

Seventeen tests were added, including two compositions with the real observer and
mocked RPC. All 85 focused discovery/observer tests and package typecheck pass.
Required `pnpm lint`, `pnpm typecheck` and
`VITEST_MAX_WORKERS=1 pnpm test --env-mode=loose --concurrency=1` pass: five typecheck
tasks, seven test tasks and 527 keyring tests. Two typecheck tasks and two test tasks
used Turbo cache; the changed keyring suites executed. Existing infrastructure
ignores and six mobile skips remain. Log:
`/private/tmp/honey-bunk-erc20-discovery-root.log`.

No Docker or blockchain nodes were started. Historical live acceptance predates
this addition. App catalog integration, Solana token inventory and complete wallet
restore remain open; see [the API handoff](BUNK-ACCOUNT-DISCOVERY.md#evm-token-balances).

## Shared recovery release resolution

`resolveBunkRecoveryHints` connects authenticated backup hints to an independently
pinned registry. It retains missing releases, sparse indices, active/restore-only
policy and the full registry for further discovery. Legacy absent hints remain
distinct from empty metadata. Resolution grants neither signing authority nor
complete inventory. Both EVM and Solana backup fixtures use this shared function.

Seven focused tests pass, including an actual encrypted-file round trip, wrong
network/deployment matches, registry pin changes, duplicate identities and copied
inputs. Required normal checks also pass: `pnpm lint`, `pnpm typecheck` and
`VITEST_MAX_WORKERS=1 pnpm test --env-mode=loose --concurrency=1`. All five typecheck
tasks and seven test tasks pass, including 478 keyring tests; two test tasks used
Turbo cache. Existing infrastructure ignores and six mobile skips are unchanged.
Log: `/private/tmp/honey-bunk-recovery-resolve-root.log`.

No Docker or blockchain nodes were started. The prior Solana live report records
the code before this refactor; live acceptance of the shared resolver is unverified.
App integration and reviewed production release metadata remain open.

## Earlier normal automated checks

`pnpm lint`, `pnpm typecheck` and
`VITEST_MAX_WORKERS=1 pnpm test --env-mode=loose --concurrency=1` exited successfully.
All five typecheck tasks and seven test tasks passed; six test tasks reused Turbo
cache. Existing infrastructure ignores and six mobile skips remain unchanged.
Log: `/private/tmp/honey-bunk-normal-checks.log`. No Docker or blockchain nodes
were started for these checks. Further node-based acceptance is deferred at the
user's request.

The new EVM encrypted-backup coordinator has syntax/lint validation, but no passing
live acceptance report. The attempted full runner stopped in the preceding v3
client with local RPC `ECONNREFUSED`, before reaching the new coordinator. Its owned
containers/network were cleaned up. This does not invalidate earlier recorded runs
or establish that the new backup scenario passes.

## Solana encrypted-backup recovery on the actual local validator

[The Agave 3.1.11 run](evidence/bunk-solana-backup-validator-local.json) exports a
version-2 encrypted file for account index 10,000. Fresh Node processes decrypt
that file and resolve its hint through a separately pinned local registry marked
restore-only. Discovery finds the same PDA with 19,000,000 lamports and retains the
empty next index; no journal approval exists after discovery and signing remains
fenced until explicit recovery. The backup predates an ordinary owner rotation.

Wrong passwords, altered registry bytes and a trusted registry missing the requested
release all reject before a journal file is created. The imported phrase/hint,
rather than the fixture's caller-supplied release/index, drive restore. With a fresh
encrypted SQLite database, recovery reaches epoch 2, owner 0, nonce 1 at the same
wallet. Old-generation authorization rejects. Three intentional process deaths,
exact-byte retries, included rollback, native/SPL CPI checks and the two-process
reservation race remain enabled and pass.

The backup and registry files were rehashed unchanged. All 69 shared-client and 14
program source/dependency hashes were checked before/after, as was the client bundle;
the deployed immutable program matched the freshly built binary and the earlier
fixture binary was preserved. The owned validator stopped. Log:
`/private/tmp/honey-bunk-solana-backup-validator.log`. This is local program/journal
acceptance, not packaged-device, cloud backup, public-provider or app certification.

Required checks pass: `pnpm lint && pnpm typecheck && VITEST_MAX_WORKERS=1 pnpm test --env-mode=loose --concurrency=1`.
Lint, all five typecheck tasks and all seven test tasks pass, including 471 keyring
tests and the extension build. Existing infrastructure ignores/mobile skips remain
unchanged; no assertion or timeout was relaxed. Full log:
`/private/tmp/honey-bunk-solana-backup-root.log`.

## Encrypted sparse-account discovery backup

[The version-2 backup APIs](BUNK-RECOVERY-BACKUP.md) preserve the phrase and sparse
EVM/Solana discovery hints in one authenticated ciphertext. Old version-1
APIs/formats remain unchanged; new imports explicitly distinguish legacy files with
no hints and never grant signing authority. Eleven new tests, all six existing
backup tests and package typecheck pass. App integration and actual-device restore
acceptance remain open.

Required checks pass: `pnpm lint && pnpm typecheck && VITEST_MAX_WORKERS=1 pnpm test --env-mode=loose --concurrency=1`.
Lint, all five typecheck tasks and all seven test tasks pass, including 471 keyring
tests and the extension build. Existing infrastructure ignores/mobile skips remain
unchanged; no assertion or timeout was relaxed. Full log:
`/private/tmp/honey-bunk-backup-root.log`.

## Pinned Bunk release metadata

[The registry loader](BUNK-RELEASE-REGISTRY.md) verifies exact UTF-8 artifact bytes
against an independently trusted app pin before parsing, applies bounded strict
release validation, rejects conflicting deployment identities and retains
restore-only entries. Eight new tests and package typecheck pass. Production
deployment entries, reviewed pins, distribution and packaged-app integration
remain open; these tests use synthetic existing contract fixtures.

Required checks pass: `pnpm lint && pnpm typecheck && VITEST_MAX_WORKERS=1 pnpm test --env-mode=loose --concurrency=1`.
Lint, all five typecheck tasks and all seven test tasks pass, including 460 keyring
tests and the extension build. Existing infrastructure ignores/mobile skips remain
unchanged; no assertion or timeout was relaxed. Full log:
`/private/tmp/honey-bunk-release-registry-root.log`.

## Solana seed account discovery and package relocation

`discoverBunkSolanaAccounts` now provides bounded account discovery through a trusted
release and finalized RPC without Honey backend records or an existing signing
journal. Eleven tests pass for deployed/empty/prefunded addresses, authority checks,
pagination limits, stale/changed observations, cancellation and caller-input mutation.

The [local validator report](evidence/bunk-solana-discovery-validator-local.json)
adds actual-chain discovery after the existing crash/restore cases. A fresh database
finds account 10 at epoch 2, owner index 0, nonce 1 and 19,000,000 lamports, plus an
empty account 11. It returns cursor 12, retains `inventoryComplete: false` and
`signingAuthorized: false`, and leaves the new database without an account journal.
Both candidate checkpoints are finalized; the scanner is not an atomic whole-wallet
snapshot or token inventory. The run rechecked 14 program/runner source hashes,
34 shared-client/dependency hashes and the bundle hash. The owned validator stopped.
Log: `/private/tmp/honey-solana-discovery-validator-final.log`.

Contract projects now live in `packages/bunk-evm` and `packages/bunk-solana` with
isolated Foundry/Cargo builds. After the move, all 121 EVM tests and 18 compiled-SBF
runtime tests passed, along with the encrypted SQLite restart/crash runner. Older
evidence retains its original paths and hashes. No public deployment or app
activation was performed.

Required root lint, typecheck and tests passed on the final run (all 365 keyring
tests). Command: `pnpm lint && pnpm typecheck && VITEST_MAX_WORKERS=1 pnpm test --env-mode=loose`.
One Vitest worker avoided the repeated 20-second timeout in an existing EVM journal
test; no assertions or timeouts changed. Earlier attempts encountered restricted
loopback sockets and transient formatting/compilation errors in concurrently edited
app/server files; their owners corrected those files. Explicitly ignored integration
tests remain ignored. Log: `/private/tmp/honey-solana-discovery-root-serial.log`.

Scope correction: recovery while an attacker controls the active signing key is
not an agreed launch guarantee. The preemption finding remains documented as a
compromised-wallet limitation, without blocking ordinary seed/lost-device restore.
Its characterization test is unchanged; this is not a claim that the protocol was fixed.

## Solana durable journal, finalized observation, and recovery scope

The [Solana journal/observer](BUNK-SOLANA-JOURNAL.md) now verifies trusted release
bytes/upgrade authority, genesis, finalized account state, checkpoint continuity
and freshness before signing. It uses one encrypted CAS account record for
bootstrap, recovery and ordinary approvals. Claims precede signature computation;
signature persistence precedes return. A failed action retains its exact digest,
and uncertain signing requires explicit deterministic reconstruction. Missing
history or explicit import requires a fresh-generation reset before ordinary use.

**14 new unit tests** pass (34 with the prior client tests), covering release and
state substitution, stale/changed anchors, races, signature-save failures, committed
but unacknowledged writes, ciphertext/revision tampering, expiry, input snapshots,
rollback and lost history. The [actual Agave/SQLite run](evidence/bunk-solana-journal-validator-local.json)
passes **26 finalized transactions**, including four expected failures, and ten
negative simulations across the accumulated program/client/journal cases.

The journal case starts in a fresh process for every step and opens task-owned
SQLite with WAL/FULL synchronization and phrase-derived encryption. Three processes
exit with code **73** after computing bootstrap/owner/recovery signatures but before
saving them; normal retries refuse each uncertain claim. Explicit reconstruction
and persisted exact-byte retries succeed on the real validator. A new empty DB
cannot sign ordinarily, then recovers at the same PDA to **epoch 2, owner index 0,
nonce 1**, preserving **19,000,000 lamports**. Two separate processes racing distinct
approvals yield one reservation and one CAS conflict. The final encrypted record
is revision **6** with that new owner reserved. This is real SQLite/process evidence,
not packaged mobile/extension persistence or a whole-device rollback guarantee.

The actual-genesis immutable binary is **122,112 bytes**, SHA-256
`2cfc96d28ad1a3b86a6a274c2723bd36538a88f7b3d0cb223d6c941c69ffa87b`.
The run rechecked **14 program/runner** and **32 client/dependency** source hashes
plus the bundle hash; the fixture binary was preserved. Owned validators stopped
and ledgers were removed. Log: `/private/tmp/honey-bunk-solana-journal-validator.log`.

**A subsequent adversarial test reproduced a recovery-target preemption
limitation after active signing-key compromise.** A current owner can select either published incoming recovery commitment
as its ordinary successor; the unchanged recovery certificate then rejects.
The new characterization test passes by confirming that failure, not by showing a
fix. See [the limitation and threat-model scope](RECOVERY-TARGET-PREEMPTION.md) and
[reproduction evidence](evidence/bunk-solana-recovery-preemption-local.json).
Only `tests/runtime.rs` was added to after the frozen validator run; the existing
validator source snapshot therefore predates that characterization. The successful
journal scenarios do not establish adversarial recovery liveness. EVM v3 has an
analogous statically identified path that still needs runtime reproduction.

The required root `pnpm lint && pnpm typecheck && pnpm test` passes on the final run.
An initial backend-owned `identity.rs` formatting failure was corrected by that
session; this session did not edit it. Logs:
`/private/tmp/honey-bunk-solana-journal-root.log` and
`/private/tmp/honey-bunk-solana-journal-root-final.log`. Explicitly ignored
infrastructure tests remain ignored. Newly copied evidence was separately checked
with Biome. No production readiness, audit, public-network or application activation
is claimed. Normal restore and application integration remain priorities; recovery
under active signing-key compromise is outside the agreed launch guarantee.

## Shared Solana phrase client and successor-payer checks

The [shared phrase client](BUNK-SOLANA-CLIENT.md) now implements versioned
deployment/owner/recovery derivation, canonical PDA/state parsing and unsigned
initialization/native/CPI/recovery preparation. **20 client tests** pass, including
four independent scopes, 28 role-key descriptors and 16 instruction/digest/signature
vectors regenerated with Python/OpenSSL. Existing version-one and ordinary-wallet
paths are unchanged. The package entry point exports no raw-key signing primitive.

Integration uncovered a successor-payer gap: the next authority could sign the fee
transaction before becoming current. A new compiled regression **failed before**
the change, then passed after both program and client rejected selected successor
keys as payers. All **17 SBF runtime tests**, independent program vectors, Rust
formatting and Clippy pass. See [runtime evidence](evidence/bunk-solana-client-runtime-local.json)
and `/private/tmp/honey-solana-successor-payer-before.log`. The prior program snapshots
below predate this correction; they are historical evidence, not current hashes.

The actual **Agave 3.1.11** acceptance also passes using the bundled shared TypeScript
client and public phrase fixtures. **20 transactions finalized** (three expected
included failures) and **nine negative simulations** rejected, including three
successor-payer cases that reached the program and returned its authority error.
The client initializes a separate phrase-derived PDA, exercises native rollback
and identical-authorization retry, reconstructs byte-identical recovery in a fresh
process after owner advancement, and executes an actual SPL-token CPI in the new
generation. Its final state is epoch **1**, owner index **1**, nonce **2**, with
**19,000,000 lamports**; token amounts reconcile to source 0/destination 100.
Fixture-only signing is not a claim of durable journal or app integration.

The isolated actual-genesis program is immutable and its deployed bytes match
the **122,112-byte** artifact, SHA-256
`999769bc77d4e8787b3cdb9bd6c5d0bd6d8744fd62c1304aa9b0de39d907a83c`.
The newly rebuilt fixture-genesis program is **122,048 bytes**, SHA-256
`b34079503c5cf62e67171010d43622dd1c505e44e780fe915af6967daedb4b69`;
validator acceptance preserves it. **14 program/runner source hashes**, **nine
shared-client/dependency source hashes** and the compiled client bundle hash were
rechecked. Tested packets fit **731 bytes** maximum; maximum observed consumption
is **34,468 CUs**. These are case measurements, not all-CPI bounds.

See [validator/client evidence](evidence/bunk-solana-client-validator-local.json),
`/private/tmp/honey-bunk-solana-client-validator.log` and
`/private/tmp/honey-bunk-solana-client-runtime.log`. Owned validators stopped and
their disposable ledgers were removed. No public network, private user key or
backend/frontend source was modified. Durable signing claims/reconstruction,
trusted finalized observer/discovery, broad dApp compatibility, sponsorship,
release registry, app integration, public-network/beta acceptance and review remain.

The required root `pnpm lint && pnpm typecheck && pnpm test` passes after the
backend session corrected its in-flight `identity.rs` formatting. This session
left that file untouched. The fresh test run executes all **340 keyring tests**;
the final full-chain run uses cached results for unchanged JS tests. Explicitly
ignored infrastructure tests remain ignored. Logs:
`/private/tmp/honey-bunk-solana-client-root-types-tests.log` and
`/private/tmp/honey-bunk-solana-client-root-final.log`. The first full-chain failure
is retained separately in `/private/tmp/honey-bunk-solana-client-root.log`.

## Solana isolated Agave validator acceptance

The new [validator runner](../../packages/bunk-solana/scripts/validator.py) passes
against **Agave 3.1.11, feature set 1620780344**, using only public fixture keys,
loopback RPC and its own CLI configuration. It reads the new ledger's actual
genesis, compiles a matching binary into a separate temporary directory, deploys
it locally with no upgrade authority, and reads back the executable/program-data
accounts to compare the exact bytes. The old `07…07` fixture binary is unchanged.
This tests a real validator and immutable local deployment; it does not establish
public-network provenance or select the production upgrade policy.

**12 transactions finalized**, including two intentionally included failures.
The logs prove native execution succeeded before a later instruction failed, and
the actual SPL-token program rejected an insufficient-balance CPI. Both failures
preserve the prior wallet state and leave no consumed-key tombstone. Retrying each
identical owner authorization with a different recent blockhash succeeds. A fixed
recovery certificate signed before ordinary advancement still resets the generation
at the same PDA; a new-generation action then succeeds. **Four negative simulations**
reject wrong genesis, an invalid Ed25519 signature, a stale generation and recovery
replay; these are not described as included failures.

Final state is epoch **1**, owner index **2**, nonce **3**, with **18,000,000 lamports**
and the expected live owner/recovery commitments. Both SPL fixture accounts hold
50 raw token units, and all five consumed authorities have permanent tombstones.
Tested packets are **215–731 bytes**; successful Bunk calls consume
**15,988–31,327 CUs**. These measurements cover these cases, not every allowed CPI.

All **13 source hashes** were rechecked. The actual-genesis binary is **121,592
bytes**, SHA-256 `be99da5d2df10e45c66469c8e20e17dc51c25d6f55287581026d30b6b423262e`.
See [source, deployment and transaction evidence](evidence/bunk-solana-validator-local.json)
and `/private/tmp/honey-bunk-solana-validator.log`. The owned validator exited and
its disposable ledger was removed; logs/artifacts remain at the evidence path.

The required root `pnpm lint && pnpm typecheck && pnpm test` now passes: Biome
checks 587 files, Rust formatting/Clippy pass, all five typecheck tasks are cached,
and all seven test tasks succeed (six cached). The newly copied evidence also passes a separate
Biome check. Explicitly ignored infrastructure tests remain ignored. Root log:
`/private/tmp/honey-bunk-solana-validator-root.log`. This supersedes the earlier
root formatting failure below; the shared tree is still changing in other sessions.

Phrase-derived client roles, durable signing claims, chain observation/discovery,
broader dApp/CPI compatibility, sponsorship, public-network acceptance, production
deployment policy, application integration, beta and independent review remain
open. The other sessions' frontend/backend source files were left untouched.

## Solana program candidate and compiled runtime acceptance

An isolated [native Solana candidate](../../packages/bunk-solana/README.md) now
implements stable PDA initialization, native transfers, signed CPI execution,
permanent consumed-key records and independent generation recovery. Fixed Ed25519
authorizations exclude the fee payer and transport blockhash. The program checks
canonical precompile data and rejects invocation through CPI. Recovery preserves
funds/nonce, resets owner index in a new epoch and cannot execute arbitrary calls.
The genesis identity is required at build time and checked at initialization.

**16 runtime tests pass on the compiled SBF**, including a separately compiled
adversarial wrapper. They use LiteSVM 0.7.1/Agave 2.3.13 with transaction and real
Ed25519 precompile verification enabled. Cases cover prefunded initialization,
native rotation, old/cross-role keys, malformed precompiles/sysvars, altered actions,
CPI entry rejection, forged tombstones, rent and counter boundaries, expiry,
independent recovery after ordinary advancement, stale-generation rejection and
recovery replay. A real SPL-token transfer first fails for insufficient funds,
rolls back state/tombstones, and succeeds with the identical owner authorization
after funding. A later failing transaction instruction likewise rolls back a
successful earlier action; reusing the same authorization with a fresh fee-payer
transaction succeeds. The tests do not claim rotation survives transaction failure.

Three independent Python/OpenSSL vectors match the PDA/bump, spent-key PDA, state
encoding, instruction bytes, message hashes and exact Ed25519 precompile bytes.
The acceptance runner passes vector regeneration, formatting, both SBF builds,
workspace Clippy with warnings denied and all program tests. **12 source hashes**
and both binary hashes were rechecked. The wallet binary is **121,528 bytes**;
the adversarial test helper is 27,000 bytes. Tested transactions fit the 1,232-byte
legacy packet bound and successful tested calls remain below 200,000 CUs.
See [local evidence](evidence/bunk-solana-local.json) and
`/private/tmp/honey-bunk-solana-acceptance.log`.

Repository `pnpm typecheck && pnpm test` passes: five typecheck tasks (one cached)
and seven test tasks (one cached, the unchanged 320-test keyring suite). Explicitly
ignored infrastructure tests remain ignored. **The required full command does not
pass yet:** `pnpm lint` reports formatting in concurrently edited
`packages/api-client/src/polymarket.test.ts`. This session fixed its own fixture
formatting and left the other session's file untouched. Logs:
`/private/tmp/honey-bunk-solana-root-final.log` and
`/private/tmp/honey-bunk-solana-root-types-tests.log`.

The candidate still needs phrase-derived client roles, durable claims/reconstruction,
chain observer/discovery, broader dApp/CPI compatibility, sponsorship, real validator
and network acceptance, trusted deployment/upgrade policy, CI, app integration,
testnet beta and independent review. Its fixture genesis is not a production
network identity. Current CPI policy uses a read-only wallet authority and one
action; no claim of general trading compatibility or complete Solana Bunk is made.

## Phrase-derived v3 account discovery

The shared [discovery scanner](BUNK-ACCOUNT-DISCOVERY.md) now scans an explicit
range of up to 20 indices in one trusted v3 release, without Honey's backend or a
local signing journal. It verifies deployed owner/recovery commitments against the
phrase, reads native balances and EntryPoint deposits at each finalized block, and
rechecks page anchors, chain and freshness before returning. It retains undeployed
and zero-balance addresses, exposes the next range cursor, and grants no signing
authority or claim of complete asset discovery. Any failed range remains incomplete.

All **19 discovery tests** pass, including sparse indices, pinned balances/deposits,
wrong authority, invalid bounds and RPC data, changed anchors/chain, staleness,
cancellation and input/seed snapshots. The required `pnpm lint && pnpm typecheck &&
pnpm test` passes: **573 Biome files**, Rust fmt/Clippy, five typecheck tasks (five
cached), seven test tasks (five cached), and all **320 keyring tests executed**.
Explicitly ignored infrastructure tests remain ignored. Root log:
`/private/tmp/honey-bunk-discovery-root.log`.

The complete isolated Geth 1.17.8 / Alto 0.0.18 Osaka suite passes, including all
earlier admission/rejection, recovery and journal probes. The new discovery case
finds account index 4 after recovery and rotation at epoch 1/owner 1/nonce 1 with
1 test ETH and a 0.5 test ETH EntryPoint deposit. Index 5 remains undeployed with
0.01 test ETH and a 0.02 test ETH deposit. Index 6 is undeployed and empty but remains
in the result. The next cursor is 7, inventory/signing flags stay false, and the
signing journal remains at revision 20. This exercises the real observer and RPC.

All **70 source and 95 artifact hashes** match the tested files. Disposable containers
and network were removed and cleanup confirmed. See [discovery evidence](evidence/bunk-discovery-v3-local.json)
and [this complete run](evidence/bunk-discovery-bundler-local.json). Log:
`/private/tmp/honey-bunk-discovery-bundler.log`. Earlier evidence files retain their
own historical snapshots; no old source manifest was rewritten to claim a new run.

Trusted production registry distribution, token/NFT inventory, sparse-index backup
format, packaged app restore and mismatch investigation remain open. A mismatch may
still be recoverable through the independent recovery authority; it is never an
empty-account result. Solana program discovery remains required.
[Solana requirements](BUNK-SOLANA-DESIGN.md) now record transaction rollback,
precompile and CPI constraints for the next program workstream. No production
activation, public deployment or complete launch is claimed.

## Browser persistence and phrase-derived journal encryption

The shared [IndexedDB adapter and key lifecycle](BUNK-BROWSER-JOURNAL.md) pass
**15 real-browser acceptance cases** on isolated Chrome **155.0.8059.80**. Four
browser process starts include two hard terminations after owner/leaf computation
but before signature persistence. Reopening derives the encryption key again from
the public fixture phrase. Uncertain slots remain fenced; explicit reconstruction
returns golden bytes, including the exact 1,120-byte authorization. The final
signed journal has revision 7 and survives another full browser restart.

Two tabs exercise CAS contention, forty concurrent increments, encrypted reads,
wrong-account ciphertext rejection and actual v3 approval races. Other cases cover
abort after request success, strict-durability downgrade, closure, corrupt rows,
invalid schemas, version changes, late open completion and the account coordinator's
missing-history gate. The adapter never silently clears incompatible history.

The dedicated HKDF-SHA256 key namespace preserves journal readability across phrase
restoration and local password changes. Six tests cover two independent Python
vectors, input/seed validation, buffer ownership, normalized phrase restoration and
encrypted-store reopen/wrong-key rejection. Existing signing paths are unchanged;
explicit import still requires the coordinator's fresh-generation recovery.

`pnpm lint && pnpm typecheck && pnpm test` passes: **570 Biome files**, Rust fmt/Clippy,
all five typecheck tasks (two cached), all seven test tasks (two cached), and all
**301 keyring tests executed**. Explicitly ignored infrastructure tests remain
ignored. Logs: `/private/tmp/honey-bunk-browser-root.log` and
`/private/tmp/honey-bunk-browser-journal.log`.

[Browser evidence](evidence/bunk-browser-journal-local.json) pins **29 source hashes**,
the bundle hash, browser version and locally defined CI job. Independent vector
regeneration matches. The job has not run on GitHub. Test-owned Chrome processes
and loopback server exited; the temporary profile was removed.

This is a shared storage/browser milestone. Actual packaged MV3 worker suspension,
app/device unlock/import/lock integration, Expo storage, physical power loss,
eviction, coherent rollback and multi-device coordination remain open. The earlier
62-source/95-artifact Geth/Alto result below is its original tested snapshot; it was
not rerun or relabelled as covering the new adapter/key helper. No Bunk activation,
public deployment or production launch is claimed.

## V3 durable account journal and restore continuation

The [v3 account coordinator](BUNK-V3-ACCOUNT-JOURNAL.md) now stores recovery status,
finalized checkpoint and current owner journal under one encrypted SQLite CAS key.
Missing history requires a fresh-generation reset, including an undeployed account
whose first creation approval may have been lost. An undeployed restore first exposes
only its exact bootstrap; ordinary signing remains fenced until the reset is finalized.
Reviewed owner-key and recovery-digest pins prevent async state changes from retargeting
an approval. Existing v2 records and ciphertext remain compatible.

**295 keyring tests pass**, including **19 new coordinator tests** using real SQLite
and a controlled observer for state transitions. They cover missing and undeployed
history, exact golden recovery bytes, reopened encrypted signatures, concurrent
connections, owner/leaf/recovery persistence failures, pinned reconstruction, restore
racing with in-flight signers, canonical-anchor rollback, unknown advancement,
strict record decoding and approval-input snapshots. The existing 49 observer tests
and independent v3 signing vectors also pass. Test log:
`/private/tmp/honey-bunk-v3-coordinator-keyring.log`.

`pnpm lint && pnpm typecheck && pnpm test` passes: 563 Biome files plus Rust fmt/Clippy,
all five typecheck tasks (two cached) and all seven test tasks (two cached).
The 295 keyring tests executed in the full run. Disposable localhost fixtures were
allowed; explicitly ignored infrastructure suites remain ignored. Full log:
`/private/tmp/honey-bunk-v3-coordinator-root.log`.

The complete local Geth/Alto suite passes with the new coordinator probe. It signs
and loses a creation approval while the account remains undeployed, then funds that
counterfactual address and its EntryPoint deposit. A fresh process opens an empty
encrypted SQLite account record. Ordinary signing remains blocked both before and
after exact direct bootstrap. A recovery worker exits with code 73 after signature
computation but before its final save; another process reconstructs and persists the
fixed recovery. The module reset preserves wallet funds, deposit and nonce zero.
Only finalized epoch 1/index 0 enables ordinary signing. A journal-backed sponsored
action then executes, reaching epoch 1/index 1/nonce 1, and reconciliation retires the
consumed journal at account revision 20. Reopening SQLite before submission returns
the exact saved operation. The lost creation operation is rejected with AA10 because
the sender is already deployed; the other v3 probe separately verifies AA24 rejection
of an old deployed-generation operation.

All **62 source and 95 artifact hashes**, plus both v2 client input hashes, matched the
tested coordinator snapshot. Later browser/storage changes are recorded separately
above. Disposable containers and network were removed and cleanup confirmed.
All earlier contract/client acceptance probes passed in the same run. See
[account-coordinator evidence](evidence/bunk-v3-account-local.json) and
[the complete run](evidence/bunk-bundler-local.json). Log:
`/private/tmp/honey-bunk-v3-coordinator-bundler.log`.

Platform adapters, trusted release configuration/account discovery, relay funding,
app/device restore, rollback/multi-device policy and independent review remain open.
This does not prove physical power-loss durability or public-provider acceptance.
Normal signing waits for finalized rotation; real-network latency remains a release
acceptance item. The unchanged 121-test Solidity proof remains in the contract
milestone, with every compiled artifact rehashed during this run.

## V3 phrase client and finalized observation continuation

The [v3 candidate](BUNK-SEED-RECOVERY-V3.md) now includes phrase-derived deployment,
ordinary owner/envelope signing, and fixed-successor seed recovery. Spending and
recovery paths bind the complete network, deployment configuration, account and
recovery generation; deployment identity retains its separate network-independent
branch. Existing v1/v2 derivation formats are unchanged. The observer reads owner,
recovery and nonce state at the same finalized canonical hash and verifies the
configured code and Safe authorities before returning it.

**276 keyring tests pass**, including **96 targeted v3/client-observer tests**.
The independent Python/OpenSSL/Foundry oracle reproduces all three v3 fixtures:
network IDs 1, 8453 and maximum uint256; generation/index/nonce separation; 256
public envelope leaves per vector; exact deployment, intent, envelope and recovery
signatures/calldata. `--check` passes. Logs:
`/private/tmp/honey-bunk-v3-client-tests.log` and
`/private/tmp/honey-bunk-v3-vectors-check.log`.

`pnpm lint && pnpm typecheck && pnpm test` passes: 557 Biome files, Rust fmt/Clippy,
all five typecheck tasks (two cached), and all seven test tasks (two cached).
The 276 keyring tests executed in the full run. Localhost fixture access was allowed;
explicitly ignored infrastructure suites remain ignored. Test log:
`/private/tmp/honey-bunk-v3-client-root-test.log`.

The complete local Geth/Alto suite also passes. The new phrase-client probe creates
and executes a sponsored account operation, signs a pending operation that is never
submitted, then wipes the original seed buffer. A fresh process receives only local
RPC/configuration and account discovery inputs, loads the public test phrase fixture,
reads finalized state, and derives fixed recovery without receiving the pending
approval or journal. A caller-funded transaction resets the account to epoch 1/index
0 while preserving its address, funded balance, EntryPoint deposit and nonce 1.
The old operation is rejected with AA24; a new-generation sponsored operation executes,
with finalized state epoch 1/index 1/nonce 2. This demonstrates local control recovery,
not the device application's restore flow.

That phrase-client milestone matched **57 source and 95 artifact hashes**, plus
both v2 client input hashes; the latest manifest is recorded above.
The harness removed its disposable containers and network. The prior v1/v2/scalar-v3
acceptance cases also passed. [Phrase-client evidence](evidence/bunk-v3-client-local.json)
and [complete run](evidence/bunk-bundler-local.json) retain the exact local scope.
Log: `/private/tmp/honey-bunk-v3-client-bundler.log`.

The later account-coordinator milestone above covers durable restore and lost first
approval while undeployed. Account discovery, production registry/provider acceptance,
recovery relay, device flows and independent review remain open. A missing journal must never authorize
reusing an old-generation key. The unchanged 121-test Solidity proof is recorded
in the preceding contract milestone; this run rechecked all its artifact hashes.

## V3 independent recovery authority continuation

A separate [v3 Safe candidate](BUNK-SEED-RECOVERY-V3.md) now recovers control without
the pending owner's certificate. It consumes an independent recovery key and resets
the owner index into a new generation at the same account. Its fixed typed certificate
binds chain/module/EntryPoint/account/epoch/successors, while ordinary owner/nonce
advancement cannot change it. Direct relay pays its own gas; no wallet calls or
refund authority are introduced. Old operations and already-validated/residual batch
calls are cancelled on generation mismatch. Existing v1/v2 contracts are unchanged.

**43 v3 integration tests and all 121 Solidity tests pass.** These include the v2
regression cases, lost approval/empty-wallet recovery, permanent certificate replay
rules, signer/domain/successor/role substitution, high-S rejection, bootstrap
consumption, later-generation signing and recovery during real EntryPoint bundles.
The tests use public scalar fixtures, not a completed phrase-restoration client.
Log: `/private/tmp/honey-bunk-seed-recovery-forge-all.log`.

Persistent bootstrap storage initially exceeded the 500,000-gas creation validation
bound. Transaction-local account-keyed bootstrap slots and a shared consumed-key
map now pass the unchanged bound. Transient storage and exact bundler/fork support
are release requirements. V3 runtime/init sizes are 11,570/12,710 bytes (module),
8,193/23,624 (factory), and 488/644 (setup), within EVM code limits.

Root lint, all five typechecks and all seven repository test tasks pass; three test
tasks were cached, including the unchanged 225-test keyring suite. Backend loopback
fixtures were allowed; explicitly ignored infrastructure tests remain ignored.
Log: `/private/tmp/honey-bunk-v3-root-tests.log`.

The full local Geth/Alto run passes, including the new v3 probe: unstaked-factory
rejection, sponsored counterfactual creation, exact independent recovery signed before
ordinary owner/nonce advancement, unchanged funded Safe balance and EntryPoint deposit,
stale-operation rejection, and successful next-generation signing. Finalized local
state confirms recovery epoch 1 and owner index 1. Direct deployment estimated 383,210
gas; the UserOperation retained its 500,000 verification limit. That contract milestone matched **50 source and
95 artifact hashes**, plus both v2 client input hashes; the newer client manifest
is recorded above.
Disposable containers/network were removed. [V3 evidence](evidence/bunk-seed-recovery-v3-local.json)
and [complete local run](evidence/bunk-bundler-local.json). No public-provider claim
is made. Review L16, v3 journal/restore coordination and
app integration remain open; the phrase client and observer are recorded above. No Bunk app activation or deployment is claimed.

## Interrupted-signature reconstruction continuation

The journal now exposes explicit reconstruction of an uncertain owner signature or
reserved envelope. It pins the original intent digest / operation hash, checks the
seed and stored approval, fences the revision before computation, and returns only
after the exact signature is durable. Normal signing still rejects uncertain slots.
The signer explicitly disables extra entropy so the independent golden bytes remain
identical. This adopts the candidate **one distinct approved digest per key** policy;
it does not satisfy a literal one-computation limit. [Review L15](REVIEW.md) and
[the policy](BUNK-JOURNAL-DESIGN.md) require review before app activation.

All **225 keyring tests pass**, including **20 journal/storage tests**. Six new cases
exercise owner/leaf reconstruction, wrong digests/seeds, unclaimed slots, repeated
storage failure, concurrent persistence, expired actions and the fixed cleanup leaf.
The separate-process smoke exits abruptly at the owner and envelope signature-save
boundaries, then fresh processes recover and read the exact golden authorization.
Both recovered journals reach revision 6; ordinary saved-byte restart remains at
revision 5. These are real SQLite process-death checks, not power-loss or device tests.

`pnpm lint && pnpm typecheck && pnpm test` passes: 547 Biome files, Rust formatting/
Clippy, all five typecheck tasks and all seven repository test tasks. The keyring's
225 tests run within that full suite. Localhost fixture access was allowed; explicitly
ignored database/Redis tests were not enabled. Final test log:
`/private/tmp/honey-bunk-reconstruction-root-tests.log`.

The complete local Geth/Alto run also passes. Before sponsored creation, the owner
signature save is deliberately rejected; before cleanup, the leaf-255 signature save
is rejected. Each uncertain slot is explicitly reconstructed, persisted and submitted.
Actual receipts and finalized observations confirm both rotations, and reopened
SQLite records return identical bytes. Both records reach revision 6. There are two
distinct owner approvals and two distinct envelope operations; each role performs
three signature computations because one identical signature is reconstructed.
The raw `ownerIntentSignatures: 2` evidence field counts distinct signatures, not
computations. [Journal evidence](evidence/bunk-journal-local.json) records both counts.

All **45 source and 86 compiled-artifact hashes**, plus both client input hashes,
match the current files after the run. Disposable containers/network were removed.
[Complete local bundler evidence](evidence/bunk-bundler-local.json) remains specific
to the pinned local Osaka/Alto setup, not public-provider acceptance.
Backup/archive restoration, rollback detection, approval replication, device authority,
actual app adapters and review remain open. A static backup predating the latest
approval can omit its certificate; the existing v2 contract cannot derive it from a
mnemonic. No app activation, public deployment or production completion is claimed.

## Durable v2 signing journal continuation

The [journal and SQLite adapter](BUNK-JOURNAL-DESIGN.md) now persist owner approvals
and exact leaf/hash reservations before signing, save signatures before returning
submission bytes, and retain uncertain claims after interrupted signature writes.
Canonical bounded serialization checks the certificate, scope, public Merkle tree,
owner/envelope signatures and exact operation hashes. Encryption authenticates the
owner row and revision; compare-and-swap prevents competing local writers from
claiming the same owner or leaf. Independent leaf writes are merged without signing
again or overwriting another reservation.

All **219 keyring tests pass** in the standalone run, including 14 journal/storage
tests. These use actual SQLite, two connections and separate competing processes.
A separate writer-exit/reader-start smoke check also passes and reconstructs the
independent fixture's exact signed bytes at revision 5. This tests process restart,
not sudden power loss or a real Expo/Chrome storage adapter. CI now includes the
restart smoke command; the GitHub workflow has not been run here.

The complete local Geth/Alto run passes with the v2 client going through encrypted
SQLite reservations/signing. Both sponsored creation and reserved cleanup survive
reopening the journal and return identical saved operations. The two owner records
each reach revision 5, with finalized observations verifying rotation and nonce.
All **45 source hashes and 86 compiled-artifact hashes** match before/after the run;
the client fixture/index hashes also match. [Complete bundler evidence](evidence/bunk-bundler-local.json).

Root lint, all five typecheck tasks and **all seven repository test tasks pass**.
Localhost fixtures required an unsandboxed test run. The final repository-only run
also passed all 219 keyring tests; earlier overlapping crypto runs caused timeout
failures, and keyring test concurrency is now bounded to two workers. The frontend
sign-in failures from earlier continuations now pass in the shared tree. No app/
backend source was edited here. Explicitly ignored infrastructure tests remain
outside the default test result. [Journal evidence](evidence/bunk-journal-local.json).
Final log: `/private/tmp/honey-bunk-journal-root-tests-final.log`. Disposable bundler
containers/network were removed, and all published source/artifact hashes rechecked.

Pending gates: uncertain-owner signature reconstruction policy, versioned backup/
restore and rollback detection, single-writer device handoff, actual app/extension
storage adapters and activation. Existing mnemonic-only backups are still insufficient.

## Version 2 shared-client continuation

The [v2 keyring client](BUNK-EVM-V2-CLIENT.md) adds a separate hardened derivation
namespace, one-time owner-intent signing, proof-verified envelope signing and
explicit finalized v2 observation. Three independent Python/OpenSSL/Foundry vectors
match all 256 envelope addresses and selected proofs, deployment/typed digests,
exact signatures and 1,120-byte authorizations. V1 paths/formats remain unchanged.

Retry signing verifies the saved eight-node proof and derives one leaf, avoiding
regeneration of the entire public tree. Tests cover changed certificates/state,
wrong proofs, high-S signatures, gas/size caps, sponsor grants, expiry, reserved
recovery and canonical EntryPoint withdrawal. All **205 keyring tests pass**.
The full local bundler run also passes: original v1 cases, standalone recovery,
actual v2 Safe recovery/withdrawal, and seed-derived client sponsored creation plus
reserved cleanup. Both client receipts have finalized observations confirming the
expected owner commitment/index and nonce. [Client evidence](evidence/bunk-v2-client-local.json)
and [complete bundled evidence](evidence/bunk-bundler-local.json).

The runner now captures source/artifact hashes before execution and refuses to
publish success if they differ afterward. The final run rechecked **40 source files
and 86 compiled artifacts**, plus the client fixture/index inputs. All hashes match
the current tree. Disposable containers/network were cleaned up. Local finality and
pinned Alto 0.0.18 acceptance are not public-network/provider certification.

Root lint and all five typecheck tasks passed. Default tests still fail the two
frontend-owned `WalletSignIn` profile-mismatch tests, cancelling other Turbo tasks.
Log: `/private/tmp/honey-bunk-v2-client-root-tests.log`. No backend/frontend source
was changed. Durable signing reservations, metadata backup/discovery, concurrent
devices, app activation and public-provider/network acceptance remain open.

## Safe recovery version 2 continuation

The [separately versioned Safe candidate](BUNK-EVM-V2.md) now passes 33 integration
tests, alongside 27 v1 Safe tests and 18 standalone recovery tests: **78 total**.
The checks include one-time retries, expiry cleanup, sponsored creation within
500,000 verification gas, exact Safe authorities, bootstrap/caller/signature
bypasses, atomic failure, key reactivation and EntryPoint deposit withdrawals.
The v2 module runtime is 9,907 bytes; factory runtime is 7,744 bytes. Formatting
and size checks passed. [Contract evidence](evidence/bunk-safe-v2-local.json).

The full real local bundler run passed all original v1 and standalone cases,
then actual v2 Safe sponsored counterfactual creation with expired-action cleanup,
a successor action, reserved-leaf cleanup and sponsored gas-deposit withdrawal.
Expired sponsorship, altered signed fees and an unstaked v2 factory were rejected.
The withdrawal returned 7,422,209,090,166,870 wei from EntryPoint to the same Safe;
the probe checked both balances and the execution event. Each owner signed one
intent, and envelope signer addresses were unique. All 25 source hashes match the
tree. [Bundler evidence](evidence/bunk-bundler-local.json). Owned disposable
containers/network were cleaned up. This certifies only the pinned local setup.

Latest root lint and all five typecheck tasks passed. Default tests still fail
the two frontend `WalletSignIn` profile-mismatch tests described below; Turbo
interrupted other work. A separate keyring run passes **156 tests**. The full
repository test result remains **not green**. Logs:
`/private/tmp/honey-bunk-safe-v2-root-tests.log` and
`/private/tmp/honey-bunk-safe-v2-keyring.log`. No backend/frontend source was changed
in this continuation. V2 client/observer integration, independent derivation
vectors, durable pending-intent backup, device coordination and release review
remain open; the v1 signer/observer cannot be used with v2 addresses.

## One-time retry/recovery experiment

The current Safe protocol is unchanged. A test-only account/certificate design
now proves fee/grant retries with distinct Merkle-authorized envelope keys and a
reserved deterministic, self-funded recovery after action expiry. All 45 Foundry
tests pass: 27 existing Safe tests and 18 recovery tests, including 256 certificate
mutation fuzz runs and exhaustion of 255 ordinary leaves followed by recovery.
[BUNK-RECOVERY-DESIGN.md](BUNK-RECOVERY-DESIGN.md) records authority, backup and
adoption limits; this is not complete Safe/client integration or release approval.

Root lint and all five typecheck tasks passed. The shared default test run failed
two `WalletSignIn` profile-mismatch UI tests: both expected the sign-in button after
the UI had entered its retry state. Keyring tests passed (152 total in this shared
tree); other tasks were interrupted by Turbo after the web failure. These frontend
files belong to the parallel frontend session and were not changed here. Latest
full default test status is therefore **not green**. Explicitly ignored
infrastructure tests were not enabled. Local run log:
`/private/tmp/honey-bunk-recovery-root-tests.log`.

The first real recovery probe encountered Alto's five-second validAfter safety
margin. The fixture now uses a ten-second margin, preserving normal validation and
expiry checks. The refined real-bundler run passed with validation enabled: the seven existing
Safe cases plus expired-grant rejection, fresh-leaf sponsored cleanup, next-owner
action and reserved-leaf self-funded cleanup. The expired intent used one owner
signature and distinct envelope leaves 0/1; the final recovery used leaf 255 of a
separate owner's tree. Receipt events and unique signer addresses are recorded in
[bunk-bundler-local.json](evidence/bunk-bundler-local.json), with standalone contract
results in [bunk-recovery-local.json](evidence/bunk-recovery-local.json). Source hashes
were checked against the tree. Disposable containers/network were cleaned up.
This standalone candidate does not change the Safe protocol or resolve backup,
coordination and release-review gates.

## Finalized account verifier continuation

`packages/keyring/src/bunk-evm-observe.ts` adds finalized-block code/configuration,
Safe authority, commitment/index and nonce verification. All state reads use one
EIP-1898 block hash with canonical checking; chain ID and canonical block are
rechecked, and caller-defined freshness is enforced. There is no latest fallback.
Thirty-seven new tests cover valid undeployed/deployed states, malformed responses,
code/configuration mismatches, bypass authorities, stale/future blocks, canonical
changes and endpoint switches. The keyring suite passes 141 tests.

Root `pnpm lint`, `pnpm typecheck` (five tasks) and `pnpm test` (seven tasks) passed
under Node 22.22.3. Explicitly ignored infrastructure suites remain ignored.
The local bundler harness is extended to use the verifier before signing and after
receipts, waiting for Geth dev's simulated finality every 32 blocks. All seven cases passed with the verifier; four included operations each record
finalized block/hash evidence in [bunk-bundler-local.json](evidence/bunk-bundler-local.json).
The source hashes match this tree and owned Docker containers/network were cleaned
up. The existing Foundry expiry regression also passed separately, confirming that
an expired, unconsumed operation leaves the original owner active (review L14).

This is a caller-trusted-RPC consistency check, not a consensus proof. A reviewed
release registry, per-network finality policy, durable signing journal, concurrent
device coordination and sponsor state verification remain integration gates. No
app/backend activation, production deployment or root lockfile change was made.

## Shared EVM client continuation

The keyring now implements deployment-only identity derivation, local Safe
prediction/configuration encoding, complete EntryPoint/owner/sponsor hashes and
restricted deployment/operation signing. Three new independent Python/OpenSSL/
Foundry vectors match; all eleven original multichain vectors still match.
The keyring suite passes 104 tests (24 new). The real seven-case bundler harness
passes using these exact seed-derived client signatures and compares the local
values with deployed contract getters. Updated source hashes and receipts are in
[bunk-bundler-local.json](evidence/bunk-bundler-local.json).

Final checks passed under Node 22: repository lint, all five typecheck tasks,
all seven default test tasks, and all 27 Foundry tests. Explicitly ignored
infrastructure tests remained ignored. No root dependency/lockfile change was made.

No app/backend flow is enabled. The signer requires trusted config, observed state
and user-approved operation inputs. The later observer above verifies canonical
RPC account state; pending-operation persistence and device coordination remain open. Those required integration gates
are explicit in [BUNK-EVM-CLIENT.md](BUNK-EVM-CLIENT.md).

## Real bundler continuation

The isolated Docker harness passes seven checks against Geth 1.17.8 with an explicit
Osaka genesis and unmodified Alto 0.0.18, with safe mode enabled. Four operations
were admitted and mined; altered signatures, banned opcodes and missing factory
stake were rejected. Source hashes, code identities, receipts and configuration:
[bunk-bundler-local.json](evidence/bunk-bundler-local.json). Reproduction:
[bundler harness](../../packages/bunk-evm/test/bundler/README.md).

This run exposed three limits: default Bogota creation gas exceeded the budget;
Alto 0.0.19's simulation decoder rejected its nested result; unsponsored
counterfactual creation exceeded Osaka's verification budget. These configurations
are not accepted. Current hosted-provider and network-matrix testing remains open.
The new test dependencies use an isolated pinned lockfile; app dependencies remain
unchanged. Docker cleanup completed. The CI workflow includes this harness but
has not been pushed or run remotely.

Final continuation checks passed: `forge fmt --check`, all 27 Foundry tests,
repository `pnpm lint`, `pnpm typecheck` and Node 22 `pnpm test` (seven configured
tasks, six cache hits). Explicitly ignored infrastructure tests remained ignored.
Both saved evidence files' source hashes still match the current contract sources.

## EVM continuation

The isolated `packages/bunk-evm` package now has a Safe factory/module/setup helper
and bounded paymaster. Current local evidence: **27 passing contract tests**, with
256 wrong-owner fuzz inputs; source hashes and size measurements are recorded in
[bunk-evm-local.json](evidence/bunk-evm-local.json). The tests include sponsored
counterfactual deployment and first execution, one-time rotation, failure recovery,
alternate Safe paths, replay/domain binding and treasury stake/sponsor limits.

The dependency installer passed a clean temporary checkout/download/build/test run.
`forge fmt --check` and dependency hash verification pass. A separate contract CI
workflow is present locally; it has not run on GitHub. Root `pnpm lint`,
`pnpm typecheck` and `pnpm test` also passed again during this continuation, with
localhost access for server fixtures. Explicitly ignored infrastructure tests were
not enabled. Backend/frontend source edits remain with their other sessions.

Permanent deployment-certificate semantics are now explicit: only initial exact
configuration is authorized, without expiry/reset/spending rights. Spend and sponsor
approvals still expire. Production-provider acceptance, recovery, client integration and
independent review remain open in [EVM-CONTRACTS.md](EVM-CONTRACTS.md).

## Initial keyring slice

2026-10-19, this session's changes only:

- Added `packages/keyring/src/bunk.ts`, its public export, 34 targeted tests,
  eleven recovery vectors and an independent fixture generator.
- Added launch review and protocol docs under `docs/launch`.
- No backend or frontend source edits, commits, pushes, deployments or submissions
  were made by this session. Repository-wide checks also built the ignored Chrome
  extension output as required by the existing test dependency graph.

## Results

Commands use Node 22.22.3 from the installed NVM toolchain.

| Check | Result | Scope/limit |
| --- | --- | --- |
| `python3 packages/keyring/scripts/bunk-vectors.py --check` | PASS, 11 vectors | Python HMAC/PBKDF2 + OpenSSL curves + local Foundry Keccak, independent of JS implementation |
| `pnpm --filter @honey-wallet/keyring test` | PASS, 80 tests | Includes 34 new Bunk tests and all ordinary keyring tests |
| `pnpm exec biome check` on changed TS/JSON | PASS | New code formatting/lint |
| `pnpm typecheck` | PASS, all five configured package tasks | API-client and web results were Turbo cache hits; keyring/extension/mobile ran |
| `pnpm lint` | PASS on latest run | Biome plus Rust fmt/clippy; earlier in-flight backend formatting failure was resolved by its owning session |
| `pnpm test` | PASS, all seven configured tasks | Latest server run completed outside sandbox to allow disposable localhost listeners. JS: keyring 80, extension 27, mobile 88 passed + 6 optional skips; API-client 101 and web 29. Latest rerun used JS cache hits from the preceding successful checks |

The initial root test attempt observed an in-flight backend compile error that
was resolved by its owning session. The next sandboxed attempt could not bind four
local Uniswap test listeners. The authorized rerun outside the sandbox passed.
Database/Redis/other explicitly ignored integration tests were not enabled here;
the backend session retains responsibility for their isolated infrastructure runs.

These results describe a shared worktree at check time, not an immutable release
candidate. Re-run root checks after the backend/frontend sessions stabilize.
No new dependency or lockfile modification was required for the initial keyring slice.

## Next acceptance work

1. Verify a current production bundler and each release network, resolving the
   recorded decoder/fork/gas gaps; independently review certificate/recovery policy.
2. Connect signing and the implemented canonical state verifier to a reviewed release
   registry and durable operation journal; complete finalized-state recovery.
3. Implement/test the Solana account program.
4. Hand verified contract fixtures to backend/frontend owners; integrate account
   observation, authorization, pending operation recovery and activation UX.
5. Complete each remaining release item in `REVIEW.md`. None is waived by passing
   these keyring tests.
