# Honey launch: decisions and blockers for Swayam

Updated 2026-10-19. Scope: the supplied launch brief, including Bunk mode,
real Swap/Perps/Predict/Earn, the phone browser, and iOS/Android/Chrome releases.
The requested deadline is tomorrow night; no store approval or mainnet readiness
is claimed. Backend and frontend have separate active sessions. This session owns
new Bunk keyring/contracts and this directory; existing app/server work stays with them.

The current [production handoff](RELEASE-HANDOFF.md) lists the missing public
deployment inputs, source-verified app/backend gaps and the restore integration
sequence. No production manifest or trusted app pin has been fabricated.

## Decisions to review

| ID | Finding | Recommendation / decision needed | Work continuing |
| --- | --- | --- | --- |
| L01 | The brief's “stolen or exposed key is already spent” is too broad. A stolen seed derives future keys; the current key remains useful before rotation finalizes. Reorgs and signatures that never land also matter. | Describe Bunk as limiting reuse of **past transaction keys after confirmed rotation**. No seed-compromise, malware, or blanket quantum-resistance claim. | Isolated, versioned owner derivation; explicit failure/recovery model. |
| L02 | A family-only EVM derivation branch reuses a key on independent chains at the same index. | Bind derivation to the exact network. Keep one index per account **and network**. | Network-separated derivation and fixed vectors. |
| L03 | Identical Safe addresses across EVM chains are not automatic. Safe CREATE2 depends on initializer data; network-specific initial owner commitments normally change it. | Preserve this requirement, but require a separately reviewed deterministic bootstrap design. Do not reuse a hot owner across networks merely to get the same address. | [Deployment-only identity and atomic bootstrap](BUNK-BOOTSTRAP-DESIGN.md) now pass local tests; public deployment/bundler acceptance remains open. |
| L04 | A rotating module does not disable Safe owner execution, other modules, recovery, delegatecall, or fallback signature validation. | Review the complete Safe deployment configuration and all execution paths before calling an account protected. | Module design, adversarial tests and finalized account-configuration verifier; complete account integration remains required. |
| L05 | ERC-4337 validation and execution are separate. Reverting a failed swap can undo rotation if rotation occurs only in the reverted execution. | Specify consumption at validation, exact operation binding, failure receipts, cancellation and resubmission. Never advance solely on a local signature or relay response. | State-machine specification and contract tests. |
| L06 | Generic website signatures cannot simply use a rotating owner. ERC-1271 validation is read-only; Solana PDAs cannot produce ordinary ed25519 signatures. | Treat site sign-in, token permits and provider orders as separate compatibility work. Define scoped identity/session signing that cannot execute arbitrary wallet transactions. | Integration contract for frontend/backend owners. |
| L07 | “All chains with Safe” also needs compatible EntryPoint, factory, module, bundler, paymaster and RPC availability. | Supply an initial release chain list and sponsorship budget. Unsupported networks remain visibly unavailable until verified. | Per-network deployment/acceptance matrix. |
| L08 | Post-launch audit and deposit caps do not establish production security. Arbitrary token transfers can bypass a UI deposit cap. | Recommend independent review before unrestricted mainnet custody. If retaining pre-audit launch, specify enforceable scope/limits and who accepts the residual risk. This is a recommendation for review, not a silently changed launch decision. | Local/testnet implementation and adversarial validation. |
| L09 | Seed restoration is underspecified: account discovery, network IDs, derivation version, reorg rollback and pending operations must survive device loss. | Preserve account discovery and the original pending certificate. A static backup predating the latest approval can omit that certificate; the current v2 contract cannot recover it from the seed. Require durable approval replication before signing or separately review on-chain seed-recovery authority. A backend outage must not strand recovery; an archive format alone is insufficient. | [Bounded v3 account discovery](BUNK-ACCOUNT-DISCOVERY.md) scans trusted releases without Honey backend state and checks current phrase authority. [Encrypted sparse-index backups and shared release resolution](BUNK-RECOVERY-BACKUP.md) are implemented. Complete asset discovery, reviewed registry distribution and packaged-app restore integration remain open. |
| L10 | No production URL, store account access, signing identities, legal entity/contact or approved privacy/terms text is supplied here. | Supply these through the appropriate secret/account setup; no secrets in this file. Approve the final deployment/store submission separately. | Reproducible local artifacts and release checklist. |
| L11 | The plan says backend is ready for wiring, but current Hyperliquid and Polymarket paths explicitly describe read-only capability. | Backend session must deliver order authorization, submit/cancel, reconciliation and provider eligibility. Frontend must not imply execution based on catalog/price availability. | Preserve real-trading requirement and require per-provider end-to-end evidence. |
| L12 | Sponsored account creation cannot use a timestamp-based deployment expiry under canonical bundler validation. | Review a permanent, exact-configuration deployment certificate with no spending/reset rights. It may be relayed later and has no cancellation mechanism; transaction/sponsorship approvals still expire. | Sponsored creation passes a real pinned local bundler; current-provider and independent review remain required. |
| L13 | Real bundler testing exposed version/fork limits: Alto 0.0.19's simulation decoder failed, and the default Geth Bogota dev fork exceeded the creation gas budget. | Do not equate Safe availability with Bunk compatibility. Require exact deployment, EVM fork, bundler version and gas evidence per network. This is engineering work, not a request to relax the launch requirement. | Seven positive/negative checks pass on explicit Osaka + Alto 0.0.18; [evidence and limits](EVM-CONTRACTS.md). |
| L14 | Literal “no owner key signs twice” conflicts with expiring operations: if an approved operation never lands before expiry, the chain still requires the same owner but exact-byte retry is permanently invalid. A seed restore does not rotate it. | Specify and independently review recovery for signed-but-unconsumed owners before activation. Do not silently re-sign, clear the journal after expiry, or add bootstrap reset authority. Options require an explicit protocol/security tradeoff, not a UI retry. | Existing real-EntryPoint expiry test proves commitment/index remain unchanged. [One-time retry/recovery experiment](BUNK-RECOVERY-DESIGN.md) now has a [v2 Safe port](BUNK-EVM-V2.md) with 33 integration tests and real local bundler recovery evidence; [v2 client primitives](BUNK-EVM-V2-CLIENT.md) and an [encrypted SQLite signing journal](BUNK-JOURNAL-DESIGN.md) are implemented, while reconstruction-policy review (L15), backup/device handling, app integration and independent review remain open. |
| L15 | A crash after computing a signature but before saving it cannot be distinguished from a crash before computation. Literal “no key signs twice” can strand the owner or final recovery leaf. | Review the candidate guarantee “one distinct approved digest per key”: explicit reconstruction may recompute identical deterministic bytes, while normal retries remain blocked. This is a substantive interpretation of the launch plan, not a claim of literal single computation. No app activation is authorized by these tests. | [Recovery policy and APIs](BUNK-JOURNAL-DESIGN.md) now implement digest-pinned reconstruction with persistence before return; real SQLite fault/restart tests and local contract acceptance evidence are recorded in VALIDATION.md. Backup rollback and device authority remain separate work. |
| L16 | V2 recovery still needs the latest pending certificate, so a phrase or older static backup alone may not restore control. | Review independent phrase-derived recovery authority that resets into a fresh key generation at the same Safe. This adds a second key commitment, a permanent exact reset authorization and caller-funded relay; it must not reuse an old owner branch or execute lost actions. | [Separate v3 Safe candidate](BUNK-SEED-RECOVERY-V3.md) has 43 integration tests and a real-bundler probe. Phrase derivation, independent vectors, a finalized v3 observer and fresh-process local recovery without the pending approval/journal pass. The [v3 account coordinator](BUNK-V3-ACCOUNT-JOURNAL.md) passes 19 coordinator tests and live lost-creation/process-death recovery, including an undeployed bootstrap/reset path. Shared browser storage and bounded v3 discovery are implemented separately; trusted production registry, complete assets, relay funding, app/device integration and review remain open; v2 is unchanged. |
| L17 | A random local vault key is not restored by the recovery phrase; surviving encrypted journal rows can become unreadable after a new vault/password setup. Browser persistence also requires atomic cross-context writes and explicit durability. | Use the versioned seed-derived journal key for new integrations, preserve history, and force coordinator recovery on explicit import. Existing random-key deployments need deliberate migration. | [Shared IndexedDB and key lifecycle](BUNK-BROWSER-JOURNAL.md) pass 15 browser cases and 6 key tests; packaged worker/app/device integration and rollback policy remain open. |
| L18 | Solana transaction failure rolls back state, and changing a recent blockhash changes a transaction signature message. Re-signing each retry with the rotating owner contradicts the one-message policy. A PDA also cannot provide ordinary website signatures. | Implement and test fixed authorization carried by a separately signed transport, exact precompile/CPI binding and independent generation recovery. Do not copy EVM failure-consumption assumptions. | [Solana program candidate](../../packages/bunk-solana/README.md) has compiled runtime and isolated validator acceptance. The [shared phrase client](BUNK-SOLANA-CLIENT.md) now adds versioned deployment/owner/recovery roles, independent vectors, state parsing and unsigned native/CPI/recovery preparation. Integration also added successor-payer rejection. The [durable journal and finalized observer](BUNK-SOLANA-JOURNAL.md) and [bounded phrase discovery](BUNK-ACCOUNT-DISCOVERY.md) now pass local acceptance. Broader dApp compatibility, trusted production release metadata, public-network acceptance, deployment policy and review remain open. |
| L19 | Bitcoin signs each input separately. Multiple payments to one address therefore need multiple signature digests to spend together. | Confirm whether the key may sign all its inputs in one approved transaction while remaining unavailable for a later transaction, or retain the stricter one-digest rule. A question is pending; no signing-policy exception is assumed. | [Construction/observation/Core evidence](BUNK-BITCOIN.md) and [durable allocation/approval storage with SQLite crash/race proof](BUNK-BITCOIN-JOURNAL.md) are implemented. [Strict signing coordination](BUNK-BITCOIN-APPROVAL.md) now observes around durable claiming and persists signatures for one input per owner. Read-only encrypted journal archives now recover known history and exact saved transactions. Multiple-input policy, uncertain-claim recovery, complete history restoration and app integration remain; no signing-policy exception is assumed. |

## Handoffs to the other sessions

**Scope clarification:** [recovery-target preemption](RECOVERY-TARGET-PREEMPTION.md)
is reproduced on Solana and statically suspected on EVM v3. It requires control of
the current signing key, which already permits spending. The user treats that as
wallet compromise; surviving an active key compromise is not a launch requirement.
Keep this limitation documented and continue normal restore/application acceptance.

- Backend: Tier A records need network identity, derivation version, current owner
  commitment/index, finalized observation block/hash, and pending operation identity.
  Register from verified chain state; a client-provided index must not become authority.
  Solana seed discovery now has a shared `discoverBunkSolanaAccounts` API alongside
  the EVM scanner. Frontend restore should select a candidate then call
  `startBunkSolanaRestore`; discovery results do not authorize signing. Both APIs
  have a [pinned release-registry loader](BUNK-RELEASE-REGISTRY.md); production
  deployment entries, app-bundled pins and asset inventory integration remain open.
  `apps/server/src/routes/accounts.rs` and `routes/relay.rs` are still placeholders
  at this inspection. Their implementation belongs to the backend session.
- Frontend: never show Bunk as active merely because a toggle is persisted. Activation
  requires verified deployment/configuration. Show a separate account address and
  explicit fund movement; pending/failed deployment must preserve the ordinary wallet.
  Do not pass rotating owner keys to existing general-purpose message-signing helpers.
  [Version-3 encrypted backups](BUNK-RECOVERY-BACKUP.md) now preserve the phrase,
  sparse Bunk discovery hints and supplied Bitcoin history archives in one file;
  the importer also accepts legacy phrase-only/version-2 backups. Cloud backup/file
  selection still needs app integration; hints must not initialize signing history.
  Use `encryptBunkBackupFromStore` to collect every hinted Bitcoin journal, report
  missing records and reject concurrent changes before returning the backup file.
  `resolveBunkRecoveryHints` now supplies shared pinned-registry resolution with
  explicit missing-release results; use it after decryption and before discovery.
  EVM discovery now accepts a bounded `erc20Tokens` catalog and returns raw balances
  at each verified account block, including token-only undeployed addresses. Supply
  the correct chain's catalog and preserve incomplete coverage; a failed token read
  rejects the page rather than becoming zero. Catalog/metadata integration, unknown
  token discovery and complete asset coverage remain open. Solana discovery now
  supports `includeTokenAccounts: true` for both SPL Token programs, preserving
  separate finalized checkpoints and raw public base balances. Mint reads now
  supply verified decimals/base authorities and explicit missing-mint results;
  format only initialized mints, and retain holdings when later mint details are
  absent. Names/symbols, extension/confidential balances, large inventories and
  app integration remain.
  See
  [account discovery](BUNK-ACCOUNT-DISCOVERY.md#evm-token-balances).
- Shared interfaces remain provisional until contract fixtures agree. No backend or
  frontend file has been changed by this session.

## Authoritative checks behind these corrections

- [Safe multichain deployment](https://docs.safe.global/advanced/smart-account-multi-chain-deployment): factory, singleton, salt, initializer and proxy code affect the address.
- [Safe account concepts](https://docs.safe.global/advanced/smart-account-concepts): owner transactions and module transactions are distinct paths; enabled modules can bypass owner signature checks.
- [Safe ERC-4337](https://docs.safe.global/advanced/erc-4337/4337-safe): its module acts as both module and fallback handler and separates validation from execution.
- [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337): operation signatures bind chain and EntryPoint; validation and execution have distinct responsibilities.
- [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271): contract signature verification cannot modify state.
- [Solana PDAs](https://solana.com/docs/core/pda): PDAs have no private key and sign only through their program's CPI mechanism.
- Current implementation evidence: `packages/keyring/src/index.ts` now exports
  Bunk derivation, while `packages/keyring/src/sign.ts` signs as EOAs/ed25519 keys;
  `docs/backend/HYPERLIQUID-PERPS.md` and `POLYMARKET-READ-ONLY.md` record execution gaps.

## Release evidence still required

- [x] Fixed Bunk derivation/commitment vectors, independent oracle, unchanged ordinary-wallet vectors. See [BUNK-PROTOCOL.md](BUNK-PROTOCOL.md) and [VALIDATION.md](VALIDATION.md).
- [ ] Safe module + complete factory/guard/fallback/recovery deployment, ERC-4337 bundler and paymaster acceptance. Local implementation and remaining gaps: [EVM-CONTRACTS.md](EVM-CONTRACTS.md).
- [ ] Solana program, CPI policy, recovery and real program integration tests. [Local SBF candidate and remaining gates](../../packages/bunk-solana/README.md). Current offline acceptance passes all 18 compiled-runtime tests. A dedicated CI workflow is now prepared; its first hosted run remains unverified. Public-network and app/device acceptance remain open.
- [ ] Bitcoin UTXO selection, change rotation, RBF/reorg handling and restored-wallet scanning. [Construction, UTXO/history discovery, pending observation, fee-policy fetching/budgeting and Core acceptance](BUNK-BITCOIN.md), [durable journal/allocation storage](BUNK-BITCOIN-JOURNAL.md), and [observed approval preparation/reservation](BUNK-BITCOIN-APPROVAL.md) are implemented. Strict signing coordination is implemented for one input per owner. Multiple-input policy, uncertain-claim recovery, restore integration/missing-journal policy, complete backup collection/live-history migration, fee-bump UI and app integration remain. Encrypted archives preserve known history for read-only recovery and exact-byte submission.
- [ ] Authenticated chain-verified account tracking, relay, retries and recovery without backend availability.
- [ ] Phone + extension activation, migration, signing, concurrent-device and restore flows.
- [ ] Live Swap/bridge, Perps, Predict and phone Earn: sign, submit, cancel where relevant, settle, fail and reconcile.
- [ ] Browser provider origin/frame isolation, navigation cancellation, approval binding, scam source and connected-sites revocation.
- [ ] Physical iOS and Android tests against the named dApps; packaged Chrome integration.
- [ ] Production HTTPS, explicit URLs in all builds, secrets, backup/restore, operational capacity and release rollback.
- [ ] Real sign-in, live balances, pairing against production configuration.
- [x] Merge PR #3: [verified merged](https://github.com/honey-wallet/monorepo/pull/3) at `2026-10-18T21:20:33Z`, commit `93f9efeafb7399e68fbef504f6caf4e5ec147ae6`; Rust, JS and CLA checks succeeded.
- [ ] Privacy/terms approved; store listings/screenshots/permission notes/signing.
- [ ] Testnet beta feedback, independent security review, deployment evidence and release decision.

The checklist preserves the full requested scope. Passing a primitive's tests is
not completion of Bunk mode or a production launch.
