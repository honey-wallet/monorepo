# Contributing to Honey Wallet

Thanks for your interest in contributing! This guide covers setup, workflow and what we expect in a pull request.

## Ground rules

- Be respectful. Everyone participating must follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Security issues go through [SECURITY.md](SECURITY.md)**, never public issues or PRs.
- For anything bigger than a small fix, open an issue first so we can agree on the approach before you invest time.

## Development setup

Follow [Getting started](README.md#getting-started) in the README. In short:

```sh
corepack enable
pnpm install
pnpm dev
```

### Mobile app icons and native builds

From `apps/mobile`, run `pnpm icons` to regenerate the bundled Honey, Midnight and
Graphite icons from `src/components/logo/paths.ts`. Update the generator, the
alternate icons in `app.json`, and the picker options together when adding a style.
The operating system persists the choice; the picker lives in Settings → App icon.

After changing icon assets, config, or native dependencies, run
`pnpm exec expo prebuild` before `pnpm ios` or `pnpm android`. For a standalone local
release, use `pnpm exec expo run:ios --configuration Release` (choose a simulator
without device signing) or `pnpm exec expo run:android --variant release`. Store
distribution requires the project's signing credentials. Expo Go and web can
preview the choices but cannot change the installed icon.
`plugins/withQuotedBundleScript.js` keeps iOS release bundling working in checkout
paths containing spaces; keep this fix in the plugin, not the generated project.

The `expo-alternate-app-icons` patch reads Android's enabled launcher components
instead of the running activity's stale component, disables other icons after a
switch, and copies deep-link filters to alternate launchers. When upgrading it,
verify Honey → Midnight → Graphite → Honey, relaunch persistence, and deep links.

### Dependency security patches

`pnpm-workspace.yaml` pins Xcode's UUID dependency to 11.1.1 and query-string's
decoder to 0.5.0. The decoder patch preserves its callable CommonJS export for
Expo Router without changing the upstream decoding fix.

Until fixed releases exist, two tracked patches address high-severity advisories:

- `node-forge@1.4.0`: enforce the nested DigestAlgorithm element count and empty
  NULL parameters, extending
  [upstream PR 1152](https://github.com/digitalbazaar/forge/pull/1152)
  (GHSA-86w9-cpqp-85rv).
- `braces@3.0.3`: reject nesting deeper than 128 in the parser and recursive AST
  walkers, including parentheses and direct AST input (GHSA-vfj7-8cjw-p6xm).

Run `pnpm --filter @honey-wallet/mobile test` to verify the installed dependency
paths, rejection cases, and normal parsing/signing behavior. `pnpm audit` still
reports the two patched versions: do not suppress these warnings. Replace the
patches with upstream fixed releases when available and rerun these regressions.

## Making a change

1. Fork the repo and create a branch from `main`: `git checkout -b fix/short-description`.
2. Make your change, with tests where it makes sense.
3. Run the same checks CI runs:
   ```sh
   pnpm lint && pnpm typecheck && pnpm test
   ```
   `pnpm format` fixes most lint and formatting issues automatically.
4. Commit using [Conventional Commits](https://www.conventionalcommits.org): `feat(web): add balance card`, `fix(server): handle empty origin list`. Scopes: `server`, `web`, `mobile`, `api-client`, `ci`, `docs`, `deps`.
5. Open a pull request and fill in the template. Keep PRs focused: one logical change per PR is much easier to review.

## Conventions

### Rust (`apps/server`)

- Code is formatted with `rustfmt` and must pass `cargo clippy -- -D warnings`.
- `unsafe` is forbidden workspace-wide.
- Handlers return `Result<_, AppError>` so every error has the same JSON shape.
- Add new routes under `src/routes/`, and cover them in `tests/` with the in-process router (no network needed).
- New configuration goes through environment variables in `src/config.rs`, documented in `.env.example`.

### TypeScript (`apps/web`, `apps/mobile`, `packages/*`)

- [Biome](https://biomejs.dev) handles formatting and linting; there is no ESLint or Prettier.
- Strict TypeScript everywhere. Avoid `any`.
- When you change a server response shape, update `packages/api-client/src/types.ts` in the same PR.
- **Mobile dependencies:** add them with `pnpm exec expo install <pkg>` from `apps/mobile`, never with a plain `pnpm add`. This keeps versions compatible with the current Expo SDK.
- Shared version pins for common tooling live in the `catalog` in `pnpm-workspace.yaml`.

### Adding a new package

Put apps in `apps/` and libraries in `packages/`, and name them `@honey-wallet/<name>`. Give the package `typecheck` / `test` / `lint` / `build` scripts as appropriate, and Turborepo will pick it up automatically.

## Contributor License Agreement

Before we can merge your first pull request, you need to sign the [Contributor License Agreement](CLA.md). A bot will comment on your PR with a link; signing takes a minute and covers all your future contributions.

In short, the CLA says:

- **Honey Wallet owns the project.** You assign the rights in your contributions to Honey Wallet, including the right to use them commercially or under other licenses.
- **Contributing is voluntary and unpaid.** You are not owed any payment, royalty or other compensation for your contributions.
- **You can still use your own code.** You keep a license to reuse what you wrote, for any purpose.
- **You have the right to contribute it.** The work is yours, or you have permission (for example from your employer).

The project itself is available to everyone under the [PolyForm Noncommercial License 1.0.0](LICENSE). This summary is for convenience; the [CLA](CLA.md) text is what applies.

## Reviews

A maintainer will review your PR. CI must be green before merge. We may ask for changes; that's normal and not a rejection. PRs are squash-merged, so the PR title becomes the commit message and should follow Conventional Commits.
