# AGENTS.md

Guidance for AI coding agents working in this repository. Humans should start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

- `apps/server`: Rust API server (axum). Router is built in `src/lib.rs`; routes in `src/routes/`; integration tests in `tests/`.
- `apps/web`: React + Vite.
- `apps/mobile`: Expo Router app. See `apps/mobile/AGENTS.md` for Expo-specific rules.
- `packages/api-client`: typed fetch client shared by web and mobile. Types in `src/types.ts` mirror the server's response structs.

## Commands (run from the repo root)

```sh
pnpm install
pnpm lint        # biome + cargo fmt --check + clippy -D warnings
pnpm typecheck
pnpm test        # cargo test + vitest
pnpm format      # auto-fix formatting/lint
```

Run `pnpm lint && pnpm typecheck && pnpm test` before declaring a task done.

## Rules

- Use pnpm, never npm or yarn. In `apps/mobile`, add dependencies with `pnpm exec expo install <pkg>`.
- If you change a server response type, update `packages/api-client/src/types.ts` in the same change.
- Don't add ESLint or Prettier: Biome is the single JS/TS formatter and linter.
- Don't commit `.env` files; document new variables in the relevant `.env.example`.
