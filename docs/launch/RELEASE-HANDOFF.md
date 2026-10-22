# Production release handoff

Checked against the working tree on 2026-10-19. The full launch brief remains the
target: Bunk, real trading, the phone browser, and iOS/Android/Chrome release.
Local test success is not evidence that those product flows are launched.
This document separates missing public release inputs from implementation owned
by the parallel sessions; it does not change the launch scope.

## Verified completed release work

[PR #3](https://github.com/honey-wallet/monorepo/pull/3) is merged, as verified
through GitHub on 2026-10-19. It merged at `2026-10-18T21:20:33Z` as
`93f9efeafb7399e68fbef504f6caf4e5ec147ae6`; its Rust, JS and CLA checks succeeded.
This closes the brief's PR merge item, not the remaining release requirements.
Neither the merge commit nor PR head `35819dbd3307bc4fd6038edbfdea40aed5f7deb7`
is an ancestor of current local `HEAD`
(`7a27ec4741f3b5f7c2f30bf5eb922564c1720a79`). The PR head and merge commit have
identical trees. Some PR behavior is present in the working changes, so missing
ancestry alone is not evidence that all PR changes need reapplying. A comparison
found this concrete remaining difference for the frontend owner:

- PR #3 creates approval windows at 393 × 600 and passes `h=600` to `boot.js`.
  Current [background.ts](../../apps/extension/src/worker/background.ts) uses
  the 393 × 852 `PHONE` size for `openApprovals`; current
  [boot.js](../../apps/extension/public/boot.js) forces window content to 852px
  and does not read `h`. The manifest's toolbar popup and expand-message support
  are present. Preserve the separate expanded-window behavior when reconciling.
- Current worker tests mock `openApprovals`; they do not exercise this window
  sizing or the boot script. Passing the automated suite therefore does not prove
  the PR's approval-window behavior is preserved in the release build.

Before producing a release build, the frontend owner should reconcile this
specific behavior and verify popup, approval and expanded-window sizes. The
shared dirty worktree was not pulled, merged or reset during these checks.

The latest automated-only run passed root lint/typecheck and all seven forced
test/build tasks: 1,041 application/keyring/server tests, plus 121 offline EVM
tests and 18 offline Solana runtime tests. Existing exclusions remain: 119 server
infrastructure tests and six mobile tests. No Docker, blockchain nodes,
validators or live RPC were used. See [the run details](VALIDATION.md).

## Public release inputs needed

| Input | Why it is needed | Owner |
| --- | --- | --- |
| Reviewed target network list and per-network release records | Safe availability alone does not identify a compatible Bunk deployment. The brief's all-supported-Safe-chain requirement needs a verified network matrix. | Release owner |
| EVM v3 factory, singleton, proxy factory, EntryPoint, module and helper addresses; runtime hashes; proxy creation bytes and proxy runtime hash | Required by the existing release registry and finalized verifier. Use actual deployment/build records, not the synthetic fixtures. | Contracts/release owner |
| Solana genesis, program and ProgramData addresses, exact compiled code hash/length, upgrade-authority policy | Required to bind recovery derivation and authenticate the deployed program. The local fixture binary is not a production release. | Contracts/release owner |
| Approved public RPC/bundler endpoints and deployment/fork versions | Needed for actual per-network acceptance and app routing. Endpoints remain separate from release identities. | Backend/release owner |
| Sponsorship policy, treasury/admin/sponsor public addresses and approved gas budget | Needed to prepare concrete funding/staking/relay configuration. This document requests public configuration, not private signing material. | Release owner |
| Production HTTPS URL, legal/store contacts and approved release identities | Needed by app configuration, legal documents and store preparation. Account/secret setup stays in its normal secure channel. | Release owner/app owners |

No reviewed production Bunk manifest or app-trusted pin was found in this tree.
The existing EVM deployment script under `test/bundler` accepts only a loopback
test RPC and uses deterministic public fixture keys; it is not a production
deployment command. Production transaction preparation must use the approved
network and public administration inputs above. Deployment/store submission
remain separate concrete review steps.

## Current implementation evidence

| Requirement | Current evidence | Remaining work |
| --- | --- | --- |
| Bunk derivation/contracts/program | Fixed vectors, 121 EVM tests and 18 compiled Solana runtime tests pass; [validation](VALIDATION.md). | Production deployment identities, provider acceptance, beta and independent review. |
| Account tracking and relay | `accounts.register`, `accounts.fetch` and `relay.submit` still return `NotImplemented` in [accounts](../../apps/server/src/routes/accounts.rs) and [relay](../../apps/server/src/routes/relay.rs). | Backend session: authenticated tracking and submission/reconciliation. |
| App/extension Bunk integration | No Bunk API imports/calls found under `apps/mobile/src` or `apps/extension/src` in this inspection. Shared discovery, backup and restore coordinators exist. | Frontend session: activation, funding, durable journals, signing, restore and device coordination. |
| Perps and Predict execution | [Hyperliquid route](../../apps/server/src/routes/hyperliquid.rs) exposes account reads; [Polymarket route](../../apps/server/src/routes/polymarket.rs) identifies a catalog without trading capability. | Backend/frontend sessions: real order authorization, submission/cancellation and reconciliation. |
| Swap/bridge and phone Earn | Signed-submission routes exist for [swaps](../../apps/server/src/routes/swaps.rs), [Aave](../../apps/server/src/routes/aave.rs) and [Morpho](../../apps/server/src/routes/morpho.rs); bridging is a [NEAR Intents](../backend/NEAR-INTENTS.md) quote preview only. | Implementation presence is not proof of live execution; owners must supply configured end-to-end evidence. |
| Phone browser and device/store release | No `react-native-webview` dependency/use or phone browser route found; no `apps/mobile/eas.json` found. Store/device state has not been verified externally. | Frontend/release owners: browser, physical-device tests, signed builds and store artifacts. |
| Deployment registry | Exact-byte loader and hint resolver exist. The new offline update check rejects dropped historical identities and reports policy changes. | Reviewed public artifacts/pins, publishing integration, app-bundled trust and historical retention. |

These are current source findings, not a claim that the parallel sessions have
stopped or that an external service cannot exist. Recheck their files before editing
or declaring a gate complete. No frontend/backend source was changed in this work.

## App restore handoff

1. Import through [the encrypted backup APIs](BUNK-RECOVERY-BACKUP.md). Preserve
   discovery hints; do not initialize signing history from hints.
2. Resolve hints with `resolveBunkRecoveryHints` using the app's independently
   trusted registry pin. Keep missing-release results visible. Scan active and
   restore-only deployments, including known sparse indices.
3. Use [account discovery](BUNK-ACCOUNT-DISCOVERY.md). EVM token catalogs are
   explicit; Solana token/mint reads have separate finalized checkpoints and
   missing-mint results. Preserve incomplete coverage and raw amounts until valid
   formatting metadata is available.
4. Pass the selected EVM or Solana account to `startBunkV3Restore` or
   `startBunkSolanaRestore`. Their fresh observations and durable recovery state,
   not discovery output, govern subsequent signing. Clear session-owned secrets
   and cancel pending work when the vault locks.

No new network/node runs are part of this handoff. The current constraint is
normal automated tests only. Full asset coverage, extension-adjusted/confidential
balances, browser/provider compatibility, device authority, real-user beta and
production release evidence remain open.
