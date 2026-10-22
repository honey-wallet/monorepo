# Launch questions and checklist

One list of everything the other docs say launch is waiting on. Built on 2026-10-21 from the
docs listed at the bottom. Where a doc's claim was checked against code, the code path is cited too.
Tags: **[Blocker]** = can't launch without it. **[Before public]** = needed before real users at
scale. **[Later]** = fine after launch.

## Summary (plain language)

1. **Nothing is hosted yet.** No server, database, Redis cache, domain or HTTPS exists, so the apps have nothing real to talk to.
2. **Bunk mode isn't live.** Its contracts aren't deployed on any real chain, the server routes that track Bunk accounts are still empty stubs, and the apps show it as "Coming soon" with the switch off.
3. **Real-money trading isn't there.** Perps and Predict can only read data. Swap, bridge and Savings only run against a local test chain.
4. **The phone app still has demo pieces.** There's no in-app browser, and Apple/Google/email sign-in (Supabase Auth) is built but has no Supabase project yet, so it stays hidden.
5. **Stores, legal and security review haven't started.** No store accounts, no published privacy policy or terms, and no independent security review. You also need to answer the questions below.

---

## Already decided or already done (no action needed)

- Bunk mode ships at launch, opt-in (off by default). You decided this on 2026-10-19.
- Until it's live, the apps show Bunk mode as "Coming soon": a row under Settings → Privacy and security, with its switch turned off. Flip `BUNK_LIVE` in apps/mobile/src/lib/bunk-mode.ts:28 to activate it (2026-10-21).
- The audit happens after launch, with a deposit cap. Question 5 asks how the cap is enforced.
- Honey pays Bunk gas through its own paymaster (a contract that pays users' gas). Question 12 covers the budget.
- The EVM smart account is built on Safe and targets every chain where Safe is deployed. Question 3 asks for the first-day list.
- Perps (Hyperliquid) and Predict (Polymarket) launch with real orders. Savings is phone-only. The phone gets an in-app browser.
- Recovery when an attacker already has your current key isn't a launch requirement. You treat that case as a compromised wallet. Source: docs/launch/REVIEW.md:39-43.
- Bridging uses NEAR Intents; Across was removed on 2026-10-21 (decision 14).
- Bitcoin removed 2026-10-22: Bunk needs stable addresses under key rotation; supported chains are EVM, Solana and NEAR.
- PR #3 is merged. Source: docs/launch/RELEASE-HANDOFF.md:11-14.
- The extension's approval window size has been fixed (393 × 600, reads `h`), so RELEASE-HANDOFF.md:22-34 is out of date. Checked in apps/extension/src/worker/background.ts:82 and apps/extension/public/boot.js:18.
- `apps/mobile/eas.json` exists with preview and production profiles, so RELEASE-HANDOFF.md:69 ("no eas.json") is out of date.

---

## Decisions only you can make

1. **Where will the backend run, in which region, and on what monthly budget?** Every server checklist item waits on this. The docs don't pick a vendor. *Recommended:* one managed host with managed Postgres and Redis, starting with one "combined" server. Source: docs/backend/ARCHITECTURE.md:1181, docs/backend/DEPLOYMENT-READINESS.md:59.
2. **Which domains?** You need a public API URL and one sign-in origin (the exact website address wallets trust). The apps also already link to `https://honeywallet.app/terms` and `/privacy`. Is `honeywallet.app` the real domain? Source: docs/launch/REVIEW.md:26, CONTRIBUTING.md:112-114; apps/mobile/src/app/(settings)/disclosures.tsx:6-7.
3. **Which chains are in Bunk mode on day one?** "Every Safe chain" also needs a compatible bundler (a service that submits smart-account transactions), a paymaster and RPC (a blockchain data endpoint) on each chain. *Recommended:* a short verified list. Other chains show as "not available yet". Source: docs/launch/REVIEW.md:23, docs/backend/ARCHITECTURE.md:1184.
4. **Which countries do you launch in?** Perps and Predict providers block some countries, and trading stays off where eligibility isn't settled. Source: docs/backend/ARCHITECTURE.md:1183, :845-850.
5. **Audit after launch: what is the actual limit, and who accepts the risk?** The docs warn that a cap shown in the app can be bypassed by sending tokens directly to the account. *Recommended (docs):* get an independent review before unlimited deposits. If you launch first, set a limit the contracts or backend enforce and write down that you accept the risk. Source: docs/launch/REVIEW.md:24.
6. **How do you describe Bunk's security in marketing?** "A stolen key is already spent" is too broad. *Recommended:* "limits reuse of past transaction keys after a confirmed rotation", with no quantum or seed-theft claims. Source: docs/launch/REVIEW.md:17.
7. **Which Bunk EVM version ships?** With v2, the recovery phrase alone may not restore an account. v3 adds recovery from the phrase alone. *Docs lean:* review and ship v3. Source: docs/launch/REVIEW.md:32, docs/launch/BUNK-SEED-RECOVERY-V3.md:201-204.
8. **What does "no key signs twice" mean exactly?** Taken literally, a crash or an expired approval can lock the account. *Recommended:* "one approved message per key"; after a crash the app may rebuild the exact same signature, but normal retries stay blocked. Source: docs/launch/REVIEW.md:30-31, docs/launch/BUNK-PROTOCOL.md:119-129.
9. **Do you approve a permanent account-creation certificate?** Gas sponsorship needs a creation approval that never expires. It can't spend funds or reset the account. Source: docs/launch/REVIEW.md:28.
10. **Must a Bunk account have the same address on every EVM chain?** That needs an extra reviewed design. Reusing one key across chains to get it is unsafe. Source: docs/launch/REVIEW.md:19, docs/launch/BUNK-PROTOCOL.md:142-143.
11. *Withdrawn:* Bitcoin was removed on 2026-10-22, so its coin-spending rule no longer applies (see "Already decided").
12. **What is the gas sponsorship budget, and which addresses hold the money?** You chose to pay Bunk gas. The docs still need the per-chain budget plus the public treasury, admin and sponsor addresses. Source: docs/launch/RELEASE-HANDOFF.md:50.
13. **What fees does Honey charge?** This means swap fee, builder fee (Honey's cut of trades) on Hyperliquid and Polymarket, and where fees are paid to. Nothing is configured until you decide. Source: docs/backend/ARCHITECTURE.md:1190, :852-870.
14. **Bridge provider.** *Answered:* Across removed 2026-10-21; bridging via NEAR Intents. *Still open:* Relay is a second bridge provider that can only preview quotes today. Keep it, or remove it so NEAR Intents is the only bridge? Source: docs/backend/NEAR-INTENTS.md:1-6, docs/backend/DECISIONS.md (D152).
15. **Which Savings products?** Pick the exact Aave markets and Morpho vaults, and name who owns the risk call for each. The docs say an example address being present doesn't mean it's approved. Source: docs/backend/ARCHITECTURE.md:1187, docs/backend/EARN-READERS.md:163-164.
16. **Apple / Google / email sign-in: decided, Supabase Auth.** Identity only; keys stay on the device. The buttons stay hidden until `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` are set. Remaining: create the Supabase project and providers. Source: docs/launch/SUPABASE-SETUP.md; checked in apps/mobile/src/lib/identity.ts, apps/mobile/src/app/(account)/get-started.tsx.
17. **Which on-ramp (card/Apple Pay "Buy") provider?** Buy and Add-to-Savings use placeholder payment methods. Source: docs/backend/ARCHITECTURE.md:1193; checked in apps/mobile/src/app/(money)/buy-cash.tsx:38, apps/mobile/src/app/(savings)/savings-add.tsx:29.
18. **Jars: labels only, money held for you (escrow), or separate addresses?** Source: docs/backend/ARCHITECTURE.md:1192.
19. **Data policy: what you keep, for how long, who can see it for support, and who handles incidents.** Your privacy policy needs these answers. Source: docs/backend/ARCHITECTURE.md:1194.
20. **Legal entity, store contacts, privacy policy and terms.** None of these have been provided. Source: docs/launch/REVIEW.md:26, :106.
21. **License wording.** The code is PolyForm Noncommercial, so you can't call it "open source". Is "source-available" fine? Source: docs/backend/SECURITY-REVIEW.md:118, :148-149.
22. **Closed beta first?** The docs plan a testnet beta, then a small first group of real users before opening to everyone. Source: docs/launch/REVIEW.md:107, docs/backend/ARCHITECTURE.md:1083-1085.
23. **How many users do you expect at launch?** Don't claim 10,000 users at once; that hasn't been tested on real infrastructure. Source: docs/backend/SECURITY-REVIEW.md:122-127, docs/backend/ARCHITECTURE.md:1182.

---

## Accounts, keys and things to set up

- [ ] **[Blocker]** Cloud hosting account (decision 1). Source: docs/backend/ARCHITECTURE.md:1181
- [ ] **[Blocker]** Managed Postgres (main database) with backups. Source: docs/backend/DEPLOYMENT-READINESS.md:61
- [ ] **[Blocker]** Managed Redis (fast shared cache) with TLS, a password and `noeviction`. Source: docs/backend/DEPLOYMENT-READINESS.md:63
- [ ] **[Blocker]** A secret manager (safe store for keys) for database URLs and API keys. Source: docs/backend/DEPLOYMENT-READINESS.md:64
- [ ] **[Blocker]** Domain, DNS and HTTPS for the API (decision 2). Source: docs/launch/REVIEW.md:103
- [ ] **[Blocker]** Server sign-in settings: `AUTH_ORIGIN`, `AUTH_CHAIN_ID`, `CORS_ALLOWED_ORIGINS`, and `AUTH_ADDITIONAL_ORIGINS` for the extension. Source: apps/server/.env.example:49-57, docs/backend/DEPLOYMENT-READINESS.md:65
- [ ] **[Blocker]** `TRUSTED_PROXY_CIDRS` (your load balancer's IP range). Source: docs/backend/DEPLOYMENT-READINESS.md:60
- [ ] **[Blocker]** Expo account: run `pnpm eas login`, link the project, set `EAS_PROJECT_ID`. Source: CONTRIBUTING.md:104-106
- [ ] **[Blocker]** EAS preview and production environments: `HONEY_UPDATE_CHANNEL`, `EXPO_PUBLIC_TEST_MODE=0`, `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_AUTH_ORIGIN`, `EXPO_PUBLIC_AUTH_CHAIN_ID`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`. Source: CONTRIBUTING.md:107-115, docs/launch/SUPABASE-SETUP.md
- [ ] **[Blocker]** Apple Developer account, App Store Connect and signing. Source: docs/launch/REVIEW.md:26, :106
- [ ] **[Blocker]** Google Play Console account and signing. Source: docs/launch/REVIEW.md:26, :106
- [ ] **[Blocker]** Chrome Web Store developer account, plus the stable extension ID in `EXPO_PUBLIC_AUTH_ORIGIN`. Source: apps/extension/.env.example:5-8
- [ ] **[Before public]** WalletConnect (Reown) project ID, if websites connect by QR. Source: apps/mobile/.env.example:21-24, CONTRIBUTING.md:115
- [ ] **[Blocker]** RPC and bundler providers for each launch chain. Source: docs/launch/RELEASE-HANDOFF.md:49
- [ ] **[Blocker]** A NEAR RPC. Source: docs/NEAR.md:24
- [ ] **[Blocker]** Paymaster funding, plus public treasury, admin and sponsor addresses (decision 12). Source: docs/launch/RELEASE-HANDOFF.md:50
- [ ] **[Blocker]** A contract deployment process and keys for EVM v3 and the Solana program, including who holds Solana upgrade authority. Source: docs/launch/RELEASE-HANDOFF.md:47-48, packages/bunk-solana/README.md:10-11
- [ ] **[Blocker]** Uniswap Trading API key. Source: docs/backend/UNISWAP-CONTRACT-ACCEPTANCE.md:107
- [ ] **[Blocker]** NEAR Intents partner key (`NEAR_INTENTS_API_KEY`) and Relay API key. Source: docs/backend/NEAR-INTENTS.md:12, apps/server/.env.example:121-131
- [ ] **[Blocker]** Hyperliquid builder account, funded (your trading-fee account). Source: docs/backend/ARCHITECTURE.md:784-787
- [ ] **[Blocker]** Polymarket builder account and agreement. Source: docs/backend/ARCHITECTURE.md:850, :1189
- [ ] **[Before public]** Supabase Auth project with Email (code template), Apple and Google set up (decision 16; docs/launch/SUPABASE-SETUP.md), and on-ramp provider (decision 17). Source: docs/backend/ARCHITECTURE.md:1191, :1193
- [ ] **[Before public]** Monitoring: a private metrics and traces collector, plus paging (alerts to your phone). Source: docs/backend/DEPLOYMENT-READINESS.md:67

---

## Backend / server

- [ ] **[Blocker]** Pick the host and set up public HTTPS ingress with WebSocket support. Nothing is public today. Source: docs/backend/DEPLOYMENT-READINESS.md:59
- [ ] **[Blocker]** Deploy a pinned image and run exactly one `honey-server migrate` job. The server doesn't set up its own database. Source: docs/backend/DEPLOYMENT-READINESS.md:62, :72-83
- [ ] **[Blocker]** Set `REQUIRE_INFRASTRUCTURE=true` and check every feature switch. This stops a half-configured server from looking healthy. Source: docs/backend/DEPLOYMENT-READINESS.md:79-81
- [ ] **[Blocker]** Build Bunk account tracking and the relay. `accounts.register/fetch` and `relay.submit` still return "not implemented". Source: docs/launch/RELEASE-HANDOFF.md:65; checked in apps/server/src/routes/accounts.rs:29-47, apps/server/src/routes/relay.rs:17-25
- [ ] **[Blocker]** Real portfolio balances. The phone still shows mock balances. Source: docs/backend/IMPLEMENTATION.md:84, docs/launch/REVIEW.md:104; checked in apps/mobile/src/lib/mock-wallet.ts:4
- [ ] **[Blocker]** Test sign-in, balances and phone/extension pairing against the production config. Source: docs/launch/REVIEW.md:104
- [ ] **[Before public]** Test a database backup restore before admitting real users or funds. Source: docs/backend/DEPLOYMENT-READINESS.md:91-92, docs/backend/RECOVERY-RESTORE.md:81-85
- [ ] **[Before public]** Schedule `honey-server prune-auth` and alert on its backlog. Source: docs/backend/DEPLOYMENT-READINESS.md:91
- [ ] **[Before public]** Run a capacity test over real TLS with several servers, one lost, and Redis/DB failover. Source: docs/backend/DEPLOYMENT-READINESS.md:68, docs/backend/CAPACITY-LOCAL.md:48-57
- [ ] **[Before public]** Budget Postgres connections and Redis capacity across all servers. The default pool is 20 per process. Source: docs/backend/SECURITY-REVIEW.md:134-141
- [ ] **[Later]** Split into API and worker servers. You must then monitor worker health separately. Source: docs/backend/DEPLOYMENT-READINESS.md:58, docs/backend/SECURITY-REVIEW.md:128-132
- [ ] **[Later]** Device management and revocation screen ("log out other devices"). Source: docs/backend/IMPLEMENTATION.md:65-67, :299-300
- [ ] **[Later]** Tooling to replay failed jobs (dead letters). Source: docs/backend/IMPLEMENTATION.md:68-70
- [ ] **[Later]** Remove or deprecate the old 501 stub routes once clients don't need them. Source: docs/backend/IMPLEMENTATION.md:52-63, docs/backend/SECURITY-REVIEW.md:162-164

## Mobile app (iOS / Android)

- [ ] **[Blocker]** Build the in-app browser. There's no `react-native-webview` and no browser screen. Source: docs/launch/RELEASE-HANDOFF.md:69; checked in apps/mobile/package.json, apps/mobile/src/app/
- [ ] **[Blocker]** Configure Supabase Auth and test Apple, Google and email codes on a real iPhone and Android build, or leave the Supabase variables unset to hide them (decision 16). Source: docs/launch/SUPABASE-SETUP.md
- [ ] **[Blocker]** Wire up Bunk mode: activation, funding, signing, restore. Today the app only derives keys and shows sample data. Source: docs/launch/RELEASE-HANDOFF.md:66, docs/launch/REVIEW.md:99; checked in apps/mobile/src/lib/bunk-mode.ts:43, :74
- [x] **[Blocker]** Never show Bunk as "on" just because a toggle is saved; it must be deployed and verified first. Done 2026-10-21: the switch is off and disabled until `BUNK_LIVE` (apps/mobile/src/lib/bunk-mode.ts:28). Source: docs/launch/REVIEW.md:55-58
- [ ] **[Blocker]** Turn Perps and Predict order buttons on once the backend supports real orders. They're disabled today. Source: docs/backend/IMPLEMENTATION.md:89-92
- [ ] **[Blocker]** Test on physical iPhones and Android phones against the dApps you name. Source: docs/launch/REVIEW.md:102
- [ ] **[Blocker]** Store listings, screenshots, permission notes and signing. Source: docs/launch/REVIEW.md:106
- [ ] **[Blocker]** Release builds with test mode off and HTTPS URLs. The release config already refuses missing values. Source: CONTRIBUTING.md:111-120
- [ ] **[Before public]** Real on-ramp for Buy and Add to Savings (decision 17). Source: apps/mobile/src/app/(money)/buy-cash.tsx:38
- [ ] **[Before public]** Encrypted backup: pick the file and save to iCloud/Drive inside the app. Source: docs/launch/BUNK-RECOVERY-BACKUP.md:145-148; apps/mobile/src/lib/cloud-backup.ts:16
- [ ] **[Later]** Hardware wallet Bluetooth pairing. Every search currently comes back empty. Source: apps/mobile/src/app/(keys)/hardware-wallet.tsx:93

## Extension (Chrome)

- [ ] **[Blocker]** Wire Bunk into the extension (activation, signing, restore). Source: docs/launch/RELEASE-HANDOFF.md:66
- [ ] **[Blocker]** Test the packaged extension: the background worker sleeping and restarting, unlock/import/lock. Source: docs/launch/BUNK-BROWSER-JOURNAL.md:87-89, docs/launch/REVIEW.md:102
- [ ] **[Blocker]** Check website-connection safety: which site asked, approval matches the request, scam warnings, revoking connected sites. Source: docs/launch/REVIEW.md:101
- [ ] **[Blocker]** Chrome Web Store listing, plus a stable ID set in the server's allowed origins. Source: apps/extension/.env.example:5-8, docs/launch/REVIEW.md:106
- [ ] **[Before public]** Check popup, approval and expanded-window sizes on the release build. Tests mock this. Source: docs/launch/RELEASE-HANDOFF.md:28-33

## Web / landing page

- [ ] **[Blocker]** Point `VITE_API_URL` at the live backend. The waitlist stays disabled ("opens soon") until then. Source: apps/web/.env.example:5-7
- [ ] **[Blocker]** Publish Terms and Privacy pages at the URLs the app links to. Source: docs/launch/REVIEW.md:106; apps/mobile/src/app/(settings)/settings-about.tsx:8-9
- [ ] **[Before public]** Decide where the landing page is hosted. Not covered in any doc.
- [ ] **[Later]** Web app Savings actions need a wallet signer. There is no action UI yet. Source: docs/backend/IMPLEMENTATION.md:93-96
- [ ] **[Later]** Keep web sign-in across reloads (refresh token) and test hidden-tab behavior in a real browser. Source: docs/backend/IMPLEMENTATION.md:94-97

## Contracts (Bunk EVM / Solana)

- [ ] **[Blocker]** Deploy the EVM v3 contracts on each launch chain and record the real addresses and code hashes. No production deployment exists. Source: docs/launch/RELEASE-HANDOFF.md:47, :53, docs/backend/IMPLEMENTATION.md:105
- [ ] **[Blocker]** Publish a reviewed release list (registry) and bundle its trust pin in the apps. Source: docs/launch/BUNK-RELEASE-REGISTRY.md:104-107
- [ ] **[Blocker]** Prove the real bundler, paymaster and gas work on each chain. Local tests found version mismatches. Source: docs/launch/REVIEW.md:29, docs/launch/VALIDATION.md:1005-1006, packages/bunk-evm/README.md:118-122
- [ ] **[Blocker]** Build the production gas-sponsorship service. Source: packages/bunk-evm/README.md:124-126
- [ ] **[Blocker]** Recovery for an approval that was signed but never landed. The docs call this a launch blocker; v3 is the proposed fix. Source: docs/launch/BUNK-PROTOCOL.md:123-129
- [ ] **[Blocker]** Close every other way to move funds out of the Safe (owner, modules, fallback). Source: docs/launch/REVIEW.md:20, docs/launch/BUNK-PROTOCOL.md:139-141
- [ ] **[Blocker]** A funded recovery relay (it pays gas for restores). Source: docs/launch/BUNK-SEED-RECOVERY-V3.md:145-149
- [ ] **[Blocker]** Deploy the Solana program: program ID, exact code hash, upgrade-authority policy. Source: docs/launch/RELEASE-HANDOFF.md:48, packages/bunk-solana/README.md:10-11
- [ ] **[Blocker]** Solana tests on a public network and checks with real dApps. Source: docs/launch/REVIEW.md:34, :97, docs/launch/BUNK-SOLANA-JOURNAL.md:82-83
- [ ] **[Blocker]** Find all of a restored wallet's assets. Token discovery is partial. Source: docs/launch/REVIEW.md:65-75, docs/launch/BUNK-RELEASE-REGISTRY.md:107
- [ ] **[Before public]** Two devices with the same phrase can conflict. Decide which device may sign. Source: docs/launch/BUNK-SEED-RECOVERY-V3.md:203-204, docs/launch/BUNK-SOLANA-JOURNAL.md:76-77
- [ ] **[Before public]** Move old random-key journals to the phrase-derived key. Source: docs/launch/REVIEW.md:33
- [ ] **[Before public]** Website sign-in and permits from a Bunk account need separate design. Source: docs/launch/REVIEW.md:22

## NEAR

- [ ] **[Blocker]** Wire the NEAR send screen. The keyring and send service exist, but no screen uses them. Source: docs/NEAR.md:3-6; checked: apps/mobile/src/lib/near-execution.ts is imported nowhere
- [ ] **[Blocker]** A funded testnet transfer and a physical-device auth test. Source: docs/NEAR.md:62-63
- [ ] **[Before public]** Include NEAR in the USD total and activity history. Source: docs/NEAR.md:49-51
- [ ] **[Later]** NEAR tokens, NFTs, staking, named-account discovery and Bunk on NEAR. Source: docs/NEAR.md:46-47

## Trading

**Swap (Uniswap) and bridge (NEAR Intents / Relay)**
- [ ] **[Blocker]** Swap only runs on a local test chain. You need the Trading API key, an approved contract list, the fee policy and a production test. Source: docs/backend/UNISWAP-SERVICE.md:151-153, apps/server/.env.example:109-114
- [ ] **[Blocker]** NEAR Intents can only preview. Real deposits, signing and settlement/refund tracking aren't built. Source: docs/backend/NEAR-INTENTS.md:44-51
- [ ] **[Blocker]** Relay can only preview. Its commit/reveal/submit routes aren't built. Source: docs/backend/RELAY-QUOTE-PREVIEW.md:26
- [ ] **[Before public]** Mixed routes, taxed tokens, native wrapping and contract-account signatures are untested. Source: docs/backend/UNISWAP-CONTRACT-ACCEPTANCE.md:115-118

**Perps (Hyperliquid)**
- [ ] **[Blocker]** There's no signed order/cancel/fill path. Only account reads work. Source: docs/backend/HYPERLIQUID-PERPS.md:72-78, :86-90
- [ ] **[Blocker]** The user approves your builder fee, and you fund the builder account. Source: docs/backend/ARCHITECTURE.md:784-787
- [ ] **[Before public]** Live per-user account updates can't be served from one server IP. You need a provider agreement or delivery straight to the app. Source: docs/backend/ARCHITECTURE.md:790-800

**Predict (Polymarket)**
- [ ] **[Blocker]** There's no order, cancel, redeem or tracking path. Only the catalog and order book are readable. Source: docs/backend/POLYMARKET-READ-ONLY.md:13
- [ ] **[Blocker]** Country eligibility checks at sign-up and at trade time (decision 4). Source: docs/backend/ARCHITECTURE.md:845-850

## Savings (Aave / Morpho, phone only)

- [ ] **[Blocker]** Execution only runs on a local test chain, and real networks are rejected. Source: apps/server/.env.example:88-100, docs/backend/SECURITY-REVIEW.md:113
- [ ] **[Blocker]** An approved product list with a risk owner (decision 15). Source: docs/backend/EARN-READERS.md:163-164, docs/backend/AAVE-EXECUTION.md:146-147
- [ ] **[Blocker]** Real positions and earned yield on the phone. Source: docs/backend/AAVE-EXECUTION.md:163, docs/backend/MORPHO-EXECUTION.md:198-202
- [ ] **[Before public]** Handle a failed action that leaves a token approval open (offer a revoke). Source: docs/backend/AAVE-EXECUTION.md:155-157
- [ ] **[Before public]** RPC rate limits, contract-upgrade monitoring and per-product kill switches. Source: docs/backend/AAVE-EXECUTION.md:161-162, docs/backend/AAVE-API.md:186-190

## Security / audit

- [ ] **[Before public]** An independent security review of Bunk contracts and recovery. You chose "after launch"; see decision 5. Source: docs/launch/REVIEW.md:24, :107
- [ ] **[Before public]** Rerun the repo-wide security scan. The last scan covered only part of the repo. Source: docs/backend/SECURITY-REVIEW.md:7, :169-170
- [ ] **[Before public]** Keep the two patched npm advisories visible, and recheck them after each Expo upgrade. Source: docs/backend/SECURITY-REVIEW.md:150-152
- [ ] **[Before public]** Testnet beta feedback and a final release decision. Source: docs/launch/REVIEW.md:107

## Release / ops

- [ ] **[Blocker]** Test OTA (over-the-air app updates) on an installed preview build before production. Source: CONTRIBUTING.md:131-137
- [ ] **[Blocker]** A rollback plan for server releases. Source: docs/launch/REVIEW.md:103, docs/backend/DEPLOYMENT-READINESS.md:89-90
- [ ] **[Before public]** Dashboards, alerts and on-call owner. Never expose the metrics port publicly. Source: docs/backend/DEPLOYMENT-READINESS.md:67
- [ ] **[Before public]** The Solana CI workflow has never run on GitHub. Check that it passes. Source: docs/launch/REVIEW.md:97
- [ ] **[Before public]** Docker image scanning, signing and provenance (proof of how it was built). Source: docs/backend/SECURITY-REVIEW.md:117
- [ ] **[Later]** Production failover drills and measured recovery time/data loss (RTO/RPO). Source: docs/backend/RECOVERY-RESTORE.md:81-85

---

## Source docs consolidated

docs/launch/REVIEW.md, RELEASE-HANDOFF.md, VALIDATION.md, EVM-CONTRACTS.md, BUNK-PROTOCOL.md,
BUNK-RELEASE-REGISTRY.md, BUNK-RECOVERY-BACKUP.md, BUNK-RECOVERY-DESIGN.md, BUNK-SEED-RECOVERY-V3.md,
BUNK-BROWSER-JOURNAL.md, BUNK-SOLANA-CLIENT.md, BUNK-SOLANA-DESIGN.md, BUNK-SOLANA-JOURNAL.md,
RECOVERY-TARGET-PREEMPTION.md ·
docs/backend/ARCHITECTURE.md, IMPLEMENTATION.md, DEPLOYMENT-READINESS.md, SECURITY-REVIEW.md,
RECOVERY-SECURITY-REVIEW.md, RECOVERY-RESTORE.md, CAPACITY-LOCAL.md, NEAR-INTENTS.md, HYPERLIQUID-PERPS.md,
POLYMARKET-READ-ONLY.md, RELAY-QUOTE-PREVIEW.md, UNISWAP-SERVICE.md, UNISWAP-CONTRACT-ACCEPTANCE.md,
UNISWAP-QUOTES.md, AAVE-API.md, AAVE-EXECUTION.md, MORPHO-EXECUTION.md, EARN-READERS.md,
IDENTITY-AND-DURABILITY.md, PREPARATION-AND-RECOVERY.md, RECEIPT-RECONCILIATION.md ·
docs/NEAR.md · packages/bunk-evm/README.md · packages/bunk-solana/README.md ·
apps/mobile/ONBOARDING.md · CONTRIBUTING.md · README.md · and the four `.env.example` files
(apps/server, apps/mobile, apps/extension, apps/web).
