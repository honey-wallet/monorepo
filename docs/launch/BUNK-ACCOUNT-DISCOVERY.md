# Phrase account discovery for Bunk

`discoverBunkEvmV3Accounts` scans an explicit account-index page for one trusted
release configuration without Honey's backend or a local signing journal. It
returns verified account observations, native balances, EntryPoint deposits and
balances for an explicitly supplied ERC-20 token list.
Discovery does not authorize signing or bypass [restore coordination](BUNK-V3-ACCOUNT-JOURNAL.md).

## Solana discovery

`discoverBunkSolanaAccounts` provides the same bounded discovery flow for Solana.
Pass the seed, a trusted `BunkSolanaRelease`, `startAccountIndex`, `count` (1–20),
and the finalized observer's access object with optional `signal`. Each candidate
includes the wallet address, lamports, finalized checkpoint and decoded state
(or `null` for an undeployed account). A prefunded system account is retained.

Set `includeTokenAccounts: true` to query both the original SPL Token program and
Token-2022 for each verified wallet. `candidate.tokenAccounts` is `null` when not
requested; otherwise it contains two snapshots with `tokenProgram`, `checkpoint`,
`accounts` and `mintSnapshots`. Empty `accounts` means the requested read succeeded with no results.
The scanner keeps zero balances, frozen accounts and multiple accounts for one
mint, including token holdings at an undeployed wallet address.

Each token snapshot has its own finalized slot, blockhash and block time. The first
read's `minContextSlot` is the wallet observation slot; each subsequent token or
mint read uses at least the previous read's slot. This is a minimum, not a request
to read the same bank. Wallet, token and mint snapshots must not be displayed as
one atomic snapshot.
All checkpoints are checked again for changes and freshness before returning the
page, followed by the genesis and cancellation checks. Failed or unsupported RPC
calls, slot regression, inconsistent anchors and malformed responses reject the
page without returning a partial inventory. The trusted RPC remains responsible
for correct finalized state and complete owner-index results.

Token results are limited to 256 accounts per wallet/program. Exceeding that limit
rejects the page, never truncates it; larger inventories need a separate bounded
indexer or explicit-account flow. The request uses `base64` and a 166-byte data
slice. Account addresses, program ownership, base owner, initialized/frozen state,
size/type and optional authority tags are checked before decoding raw `bigint`
amounts. The RPC transport must bound the whole response size and duration, since
this method has no standard cursor and the count check runs after receipt.
An oversized or unavailable token inventory must not hide the wallet itself: the
app can repeat the account scan with `includeTokenAccounts: false`, retain the
explicit token-inventory error and continue account recovery without claiming
that all assets were found.

The returned base fields include mint, amount, delegate/delegated amount, close
authority, wrapped-native reserve and an `extended` flag. Extension bodies are
deliberately not fetched or interpreted. These amounts are not a complete balance
for confidential/extension state and do not prove spendability. Interest/scaling,
transfer restrictions, names/symbols, wrapped-SOL synchronization and
NFT presentation require additional account/mint handling in the app. Do not hide
an extended account because its public base amount is zero, or format amounts
without verified mint decimals. See the official
[owner-account RPC](https://solana.com/docs/rpc/http/gettokenaccountsbyowner),
[base token layout](https://github.com/solana-program/token/blob/main/interface/src/state.rs)
and [Token-2022 extension layout](https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs).

Each program's distinct mints are fetched in batches of at most 100 through
[`getMultipleAccounts`](https://solana.com/docs/rpc/http/getmultipleaccounts), with
finalized commitment and the same bounded slice policy. `mintSnapshots` retains
each batch's separate checkpoint and `mints` list. Every address is fetched once
per program/wallet, even when multiple token accounts use it. An empty token list
causes no mint requests. All mint checkpoints participate in final verification.

An initialized mint result has `address`, `status: 'initialized'`, `decimals`, raw
`supply`, `mintAuthority`, `freezeAuthority` and `extended`. Program ownership,
initialization, base layout, authority tags and extended-mint type/padding are
checked before returning precision. Use decimals only after narrowing this status;
they format the public base amount and do not implement interest/scaling extensions.

A successful null mint read returns `{ address, status: 'missing' }` at that batch's
checkpoint, preserving the earlier token holding without guessing decimals, supply
or a zero balance. A later mint can legitimately be absent: Token-2022 supports
[closing zero-supply mints](https://solana.com/docs/tokens/extensions/close-mint).
Absence alone does not establish why the mint disappeared. Show unavailable mint
details and incomplete coverage; do not drop the token account. Omitted array
entries, malformed data, wrong owners, incomplete batches and transport errors
still reject the page.

The scanner verifies deployed code and upgrade policy through the existing observer,
then checks both current owner and recovery commitments against the seed. It
rechecks every distinct checkpoint and the network at the end of the page and
rejects stale, changed, incomplete or failed reads. A page is not a single atomic
snapshot of all accounts. The trusted RPC remains a trust boundary.

Results always carry `inventoryComplete: false` and `signingAuthorized: false`.
Persist sparse index hints and paginate all trusted releases; empty accounts do
not prove that later indices or token accounts have no assets. On selection,
pass the release and account index to `startBunkSolanaRestore`, which observes the
chain again and requires its generation reset before ordinary signing.

Eleven tests exercise the real observer with controlled RPC responses: deployed,
empty and prefunded accounts, terminal cursor and invalid ranges, phrase authority
mismatches, late anchor/network changes, staleness, cancellation, input snapshots
and transport failure. The local validator runner also exercises discovery from
a fresh database after the journal restores the wallet; run evidence is recorded
in [validation](VALIDATION.md) and the
[local validator report](evidence/bunk-solana-discovery-validator-local.json).

Thirty additional automated cases cover token snapshots with the real account
observer and mocked RPC, including independent slots, token-only undeployed
accounts, empty/zero/frozen results, authority fields, malformed records, duplicate
accounts, bounds, slot regression, token-only freshness failures, late changes,
cancelled/failed requests and caller-input snapshots. Historical validator evidence
predates token reads; no Docker or blockchain nodes were run for this addition.

Twenty-five further tests cover verified mint precision (including 0 and 255),
authorities/supply, base and extended layouts, explicit absent-mint results,
deduplication, 100-address batching, invalid/omitted mint data and mint-only
checkpoint changes, stale/future times, cancellation and transport failures.

## Inputs and coverage

Supply the unlocked 64-byte BIP39 seed, trusted v3 configuration and SafeProxy
runtime hash, `startAccountIndex`, and `count` from 1 through 20. The entire range
must fit the existing hardened account-index space. The access object supplies
trusted RPC, current time, maximum finalized-block age and optional AbortSignal.
The transport must enforce timeouts, response-size limits and its RPC trust policy.

The helper copies configuration, range, callbacks and seed before awaiting work;
it wipes its seed copy on success or failure. Derivation helpers wipe temporary
private material. The caller still owns its original seed and must clear it and
cancel discovery when locking or replacing the session. Cancellation fences new
requests and returned results; transport cancellation is a separate responsibility.

For each index it derives the deployment identity, predicts and observes the Safe,
and verifies release code/configuration at a finalized canonical block. A deployed
account's current owner **and recovery commitment** must match derivation from the
seed, observed epoch and owner index. Unknown authority rejects the page instead
of labelling the account absent. The helper never generates a signature, writes a
journal, resets an account or submits a transaction.

A mismatched current owner can reflect compromise while the independent recovery
authority still belongs to the phrase. This strict scanner reports an error; it
does not prove funds lost or the address unrelated. Application handling must retain
the requested release/index range and offer explicit investigation/recovery using
the coordinator's separate checks. That error flow is not yet integrated in apps.

Native balance and EntryPoint `balanceOf(account)` use the observation's block hash
with `requireCanonical: true`. Page completion rechecks all distinct saved anchors,
chain identity and freshness, including earlier entries that could have become
stale during later reads. This follows the existing observer's trusted-RPC model;
hash pinning establishes consistency, not independent consensus verification.
See [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898).

RPC, decoding, cancellation, stale-state or authority errors reject the whole page.
The caller must show an incomplete scan and retry the same range rather than
silently advancing its cursor. This API performs no unbounded search or background
retry. Account observations can have different finalized blocks; the result does
not pretend they form one simultaneous cross-account snapshot.

## EVM token balances

Pass `erc20Tokens` with up to 32 distinct, nonzero token addresses for the configured
chain. The list is copied and validated before any RPC. Omission or an empty list
scans no tokens. Each candidate returns `erc20Balances: [{ token, balance }]` in
request order, using checksummed addresses and raw `bigint` amounts. Zero amounts
are retained, including for undeployed accounts; an account needs no native funds
or deployed Safe to receive tokens at its predicted address.

Both token code and `balanceOf(account)` are read at that candidate's verified
finalized hash with `requireCanonical: true`. The scanner requires nonempty,
well-formed code of at most 24,576 bytes and exactly one 32-byte balance result.
Each token call has a 500,000-gas read budget. Reverts, exhausted gas, missing code,
malformed data or RPC failure reject the page; none become a zero balance. The
same final anchor/chain/freshness and cancellation checks cover token reads.
The transport must still bound response size and time; the gas limit alone does
not bound transport work. For slow providers, request smaller account/token pages.

The caller must establish that these are the intended ERC-20 contracts on this
chain. Code presence and a successful getter do not authenticate token identity,
implementation or economic value; other contracts can expose the same selector.
Amounts follow [ERC-20 `balanceOf`](https://eips.ethereum.org/EIPS/eip-20).
Optional names, symbols and decimals are not queried, so token metadata must come
from the caller's catalog before formatting a display amount. This does not
enumerate unknown tokens or prove the catalog is complete. App-maintained catalogs,
custom token import, token-list paging and coverage display still need integration.

## Restoring the full wallet

Every candidate is retained, including undeployed and zero-native-balance addresses.
They can hold tokens, EntryPoint deposits, lost creation approvals or earlier
activity. An empty-looking address does not establish that an owner key is unused.
The page returns its exact range and `nextAccountIndex`; the cursor becomes null
only at the index-space limit. `inventoryComplete` and `signingAuthorized` are
always false. No unused-address gap causes the scan to stop automatically.

The application must scan **every known release on every supported network**,
including superseded releases that can still hold funds. Trusted deployment
metadata must survive backend outages in release artifacts and backups. Metadata
downloaded from a server or included in an imported backup is not automatically
trusted; code hashes supplied by the same untrusted RPC do not authenticate it.
[The release-registry loader](BUNK-RELEASE-REGISTRY.md) authenticates a bounded JSON
manifest against an independently app-trusted SHA-256 pin and retains restore-only
releases. Production entries, distribution/provenance and app integration remain
unfinished; a downloaded manifest must never supply its own trusted pin.

Keep known sparse account indices in [version-2 encrypted backups](BUNK-RECOVERY-BACKUP.md).
The shared format now preserves EVM key scopes, Solana program identities and
explicit account indices; app collection/export/import integration remains open.
Scan an explicit page
starting at a known high index instead of assuming all earlier indices were used.
An arbitrary sparse index cannot be discovered cheaply from the phrase alone.
The UI must expose coverage and allow further ranges; it must not say all funds
were restored after the first 20 indices or after finding no deployment.

Unknown token addresses, NFT holdings and transaction history need additional asset
discovery. Requested ERC-20 balances do not establish a complete asset inventory.
Solana's scanner above reads public token-account base balances when requested,
while extension balances, mint metadata and large inventories remain incomplete.
The prior
v1/v2 EVM deployments also retain separate restoration requirements; this helper
only accepts protocol v3 and does not reinterpret old derivation paths.

After the user chooses an account to restore, pass its trusted configuration and
index to `startBunkV3Restore`. Discovery's observation is a display/recovery hint;
the coordinator must re-observe and enforce its durable recovery fence. Cached
discovery results do not grant signing authority, even if the chain has not changed.

## Evidence

Nineteen discovery tests cover a sparse deployed account between undeployed
addresses, balance/deposit pinning, retained zero balances, range limits and terminal
cursor, wrong owner/recovery roots, observer errors, malformed RPC data, changed
anchors and chains, staleness, cancellation and input/seed snapshots. These unit
tests use a controlled observer; they do not replace real chain evidence.

Additional token tests cover list bounds/duplicates, input snapshots, explicit zero
and full-width balances, code/ABI errors, failed reads and late cancellation,
reorg, chain and freshness changes. Two composition cases use the real observer
with mocked RPC for deployed and undeployed accounts, including dependency rejection
before token reads. These additions were tested without Docker or blockchain nodes;
the historical local probes below predate token support.

The `coordinator-v3.mjs` local acceptance probe also scans the recovered and rotated
account, an undeployed account funded with 0.01 test ETH and a 0.02 test ETH EntryPoint
deposit, and a zero-balance undeployed address. It verifies exact balances, current
authority, retained candidates and an unchanged signing-journal revision. Run results
and source manifests are recorded in [validation](VALIDATION.md).

Packaged app restoration, trusted production registry, token inventory, sparse-index
backup integration, multi-device coordination, public-provider acceptance and real-device
tests remain release gates. The scanner is not a claim that phrase-only full-wallet
recovery or the production launch is complete.
