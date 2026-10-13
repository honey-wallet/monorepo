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
