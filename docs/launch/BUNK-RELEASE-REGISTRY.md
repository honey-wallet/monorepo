# Trusted Bunk release metadata

`loadBunkReleaseRegistry(json, expectedSha256)` authenticates an exact UTF-8 JSON
artifact against a separately trusted, lowercase `0x` SHA-256 pin. It then validates
the complete manifest and returns copied release inputs for EVM v3 and Solana wire
v1 (the existing Solana derivation version remains 2). It requires no network,
backend, seed or signing journal and performs no deployment or activation.

## Artifact and trust source

The root has exactly `format: "honey-bunk-releases"`, `version: 1`, a positive safe
integer `revision`, and `entries`. Each entry has a unique `id` (1–64 lowercase
letters/digits/hyphens, starting with a letter or digit) and `use`, either `active`
or `restore-only`, plus one of:

- `family: "evm-v3"`, the existing complete `BunkEvmV3Config` as `config`, and a
  nonempty-code, nonzero 32-byte `proxyRuntimeCodeHash`.
- `family: "solana-v1"` and the existing complete `BunkSolanaRelease` as `release`.
  This pins genesis, program, ProgramData, code hash/length and upgrade authority.

Unknown/missing fields, unsupported versions, invalid nested release metadata,
duplicate IDs and duplicate deployment identities reject the whole artifact.
The limits are 1 MiB of UTF-8 and 256 entries. An empty manifest explicitly enables
no releases. RPC URLs are intentionally separate from release identities.

Bundle the reviewed artifact **and its independently reviewed pin** in each app
release so recovery works during a Honey backend outage. A mirror or encrypted
backup may carry identical artifact bytes, but must never supply its own trusted
pin. Hash equality authenticates only to the caller's pin; it does not establish
that a deployment was reviewed, audited or approved. Never compute the expected
pin from a downloaded artifact at runtime and then treat that as authentication.

The publisher can compute the raw artifact hash using `shasum -a 256 <artifact>`;
prefix that output hash with `0x` for the API. Preserve the exact file bytes,
including whitespace/newlines. Parse semantics are JavaScript JSON semantics;
publish ordinary JSON without duplicate object members. The pin covers every byte
before JSON parsing. This loader does not introduce a signing-key infrastructure.

## App integration and updates

Pass each EVM entry's `config` and `proxyRuntimeCodeHash` to
`discoverBunkEvmV3Accounts`; pass each Solana entry's `release` to
`discoverBunkSolanaAccounts`. Continue using the existing chain observers to verify
the actual deployed code, network and finalized state. A manifest pin alone never
authorizes signing or proves chain state.

Discovery must include **all entries**, including `restore-only`. Account creation
for new wallet enrollment must use only `active` entries and still satisfy the
existing creation coordinator. Recovery of a previously used counterfactual address
may require the restore coordinator's fixed bootstrap; treat that as explicit
recovery, not permission to enroll new accounts on a restore-only release.
This module returns that policy; app integration must enforce it. Retain previous
deployment identities when publishing an updated artifact, changing obsolete
entries to `restore-only` rather than deleting funded accounts from discovery.
The loader cannot infer omitted historical releases from one manifest. The separate
[encrypted discovery backup](BUNK-RECOVERY-BACKUP.md) preserves release identities
and sparse indices; it never supplies its own trusted manifest pin.
`resolveBunkRecoveryHints` connects those decrypted hints to this loader. EVM
matches require both chain ID and key scope; Solana matches require both genesis
hash and program. Missing releases remain explicit results. The
resolver retains all registry entries for scans beyond the hints and performs no
RPC, journal initialization or signing.

Before publishing an update, run
`checkBunkReleaseRegistryUpdate(previousJson, previousPin, nextJson, nextPin)` with
the previously approved artifact/pin and the separately reviewed proposed pair.
It authenticates both, requires an increasing revision and rejects removal of any
previous EVM network/key scope or Solana genesis/program identity. Keep retired
deployments as `restore-only`; a renamed ID cannot disguise a replaced deployment.
Renaming an ID while retaining its identity is allowed.

The result contains the validated next `registry`, `added` entries and `changed`
previous/next pairs. Review all changes, including restore-only reactivation,
proxy-runtime metadata and Solana code/upgrade policies. Passing retention does
not approve any of those changes or verify a deployment. The check does not
publish files, install pins, contact RPC or authorize signing. It is an offline
publisher guard; no production publishing pipeline/artifact exists here yet.
Keep the full historical record: comparison to one prior manifest cannot recover
identities omitted before that artifact. App runtime pin rules remain unchanged.

An app update must explicitly review the new artifact and replace its trusted pin.
The informational revision is not a server-selected freshness rule: an old artifact
fails against the current pin even if its schema is valid. Rolling back the entire
app/trust store is outside this API's protection. Do not maintain an unrestricted
list of old pins for automatic network-selected fallback.

Each EVM network/key scope and each Solana genesis/program pair may occur only once.
Two conflicting Solana code policies for one program reject; a reviewed in-place
program upgrade requires updating that identity's policy in a new artifact. Older
EVM v1/v2 deployments need their separate restoration path and cannot be relabelled
v3. This artifact has no account indices, private keys or user balances.

## Validation and remaining release work

Eight unit tests cover exact-byte pinning, changed policy, old revisions under a
current pin, schema/bounds, duplicate/conflicting identities, invalid nested code
metadata and preservation of a restore-only release's existing derivation scope.
The fixtures are synthetic existing test configurations, not production entries.

Seven update tests cover retained/added/retired deployments, removal of either
family, identity replacement versus label changes, code-policy changes and
reactivation reporting, revision/pin validation and empty initial registries.

Still required: real reviewed deployment identities and code artifacts, a published
manifest and app-bundled trust pin, release retention review, app creation/discovery
integration, offline restore tests on packaged devices, public-provider acceptance
and complete asset discovery. No production registry or trust pin is fabricated by
this change. See [account discovery](BUNK-ACCOUNT-DISCOVERY.md) and
[launch review](REVIEW.md).
