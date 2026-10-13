# Honey Wallet

A monorepo containing the Honey Wallet API server (Rust), web app (React + Vite) and mobile app (Expo / React Native).

[![CI](https://github.com/honey-wallet/monorepo/actions/workflows/ci.yml/badge.svg)](https://github.com/honey-wallet/monorepo/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

## Repository layout

```
.
├── apps/
│   ├── server/          Rust API server (axum + tokio)
│   ├── web/             React web app (Vite)
│   └── mobile/          Expo app for iOS, Android and web (Expo Router)
├── packages/
│   └── api-client/      Typed API client shared by web and mobile
├── Cargo.toml           Cargo workspace
├── pnpm-workspace.yaml  pnpm workspace + shared version catalog
└── turbo.json           Task pipeline for every package (including the Rust server)
```

| Package                    | Port | Docs                                                     |
| -------------------------- | ---- | -------------------------------------------------------- |
| `@honey-wallet/server`     | 8080 | [`apps/server/.env.example`](apps/server/.env.example)   |
| `@honey-wallet/web`        | 5173 | [`apps/web/.env.example`](apps/web/.env.example)         |
| `@honey-wallet/mobile`     | 8081 | [`apps/mobile/.env.example`](apps/mobile/.env.example)   |
| `@honey-wallet/api-client` | —    | [`packages/api-client`](packages/api-client/src)         |

## Prerequisites

- **Node.js 24** (see [`.nvmrc`](.nvmrc); run `nvm use` or `fnm use`)
- **pnpm 10** (`corepack enable` picks up the version from `package.json`)
- **Rust**: install [rustup](https://rustup.rs). The pinned toolchain in [`rust-toolchain.toml`](rust-toolchain.toml) is installed automatically on first build.
- **Mobile (optional)**: the [Expo Go](https://expo.dev/go) app on a device, or Xcode / Android Studio for simulators

## Getting started

```sh
git clone https://github.com/honey-wallet/monorepo.git
cd monorepo
corepack enable
pnpm install

pnpm dev            # server + web + mobile
pnpm dev:web        # server + web
pnpm dev:mobile     # server + Expo dev server
pnpm dev:server     # server only
```

Then open http://localhost:5173 for the web app, or scan the QR code from the Expo terminal for the mobile app.

> **Testing on a physical phone?** Start the server with `HOST=0.0.0.0` (set it in `apps/server/.env`) so it accepts connections from your LAN. The mobile app finds the server through the Expo dev server's host automatically.

## Common tasks

All commands run from the repository root and go through [Turborepo](https://turborepo.com), so they cover every package, Rust included.

| Command          | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm dev`       | Run all apps in watch / dev mode                                    |
| `pnpm build`     | Production builds (`cargo build --release`, `vite build`)           |
| `pnpm test`      | `cargo test` + Vitest                                               |
| `pnpm typecheck` | TypeScript type checking                                            |
| `pnpm lint`      | Biome (TS/JSON/CSS) + `cargo fmt --check` + `cargo clippy`          |
| `pnpm format`    | Auto-format and fix everything Biome can                            |

To target one package: `pnpm turbo run test --filter=@honey-wallet/web`.

## Architecture

- **Server** (`apps/server`) exposes `GET /health` (liveness) and versioned routes under `/api/v1`. Errors always have the shape `{ "error": { "code", "message" } }`. Configuration comes only from environment variables.
- **API client** (`packages/api-client`) is a dependency-free, typed `fetch` wrapper. Web and mobile both import it, so an API change is made once. It ships TypeScript source; Vite and Metro compile it directly, so there is no build step.
- **Web** and **mobile** read the server URL from `VITE_API_URL` and `EXPO_PUBLIC_API_URL`.

## Docker

```sh
docker build -f apps/server/Dockerfile -t honey-server .
docker run --rm -p 8080:8080 honey-server
```

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md) first. Before your first pull request can be merged, you will be asked to sign the [CLA](CLA.md). To report a security issue, follow [SECURITY.md](SECURITY.md). **Do not open a public issue.**

## License

Honey Wallet is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, modify and share it for any noncommercial purpose: personal projects, research, education, and use by charities and public institutions. **Commercial use is not permitted** under this license. Contact the maintainers if you need a commercial license.

All rights in the software, including commercial rights, belong to Honey Wallet. Contributions are welcome and voluntary: contributors sign our [Contributor License Agreement](CLA.md), which assigns their contributions to Honey Wallet and confirms that no payment is owed for them.
