This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

This repo uses pnpm. Run these from `apps/mobile` with `pnpm exec` in place of `npx`. Lint with `pnpm lint` from the repo root (Biome).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Where files go

Routes live in `src/app` inside route groups, folders in brackets that organise files without
changing URLs (`app/(trade)/perp-order.tsx` is still `/perp-order`). Put a new screen in the group
it belongs to and register it in `app/_layout.tsx` with the group prefix
(`name="(trade)/perp-order"`). Only `(wallet)` (the tabs) and `(onboarding)` have their own layouts.

- `(wallet)`: the tab screens. `(onboarding)`: welcome, email and code.
- `(account)`: sign in, setup, sign out, profile. `(settings)`: settings and support pages.
- `(money)`: send, receive, buy and sell, and the token and network pickers.
- `(trade)`: perps, predict and swap settings. `(savings)`: earn and jars.
- `(keys)`: adding, importing, backing up and pairing wallets. `(shared)`: shared wallets and proposals.
- `(portfolio)`: token pages and portfolio. `(activity)`: activity and notifications.

Components in `src/components` are grouped by what they're for:
- `motion/`: animation primitives. `sheets/`: Sheet, ActionFooter, Success/FailurePage, Details.
- `charts/`: every chart. `trade/`: perps, predict and swap pieces. `home/`: Home's cards and lists.
- `wallet/`: shared wallet UI (parts, Keypad, SearchField, TabBar…). `onboarding/`, `logo/`.

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Design language (keep every screen on it)

- **Surfaces:** the page is `c.canvas`; containers are filled `c.card` with `borderRadius: 20` and no border. Borders are only for unselected choice chips.
- **Section labels:** 15pt, regular, `c.textSecondary`, above the block they name. No bold black section headings (the token Description title is the one deliberate exception).
- **Buttons:** primary is honey (`c.primary`); secondary is grey (`c.raised` with `c.text`). Honey tint (`c.primaryTint`/`c.accentSurface`) means a disabled primary, so never use it for a secondary button.
- **Icon wells:** round (`borderRadius` = half the size) on `c.accentSurface` with an `c.accentText` icon.
- **Header icons:** bare grey icons (`HeaderShortcut`), no circles; sheets never get a close-only back chevron (swipe down closes).
- **Money flows** end on `SuccessPage` (`compact` inside pop-ups); detail sheets use the `Details` pieces.
- **Two cards at most:** between Home's actions and its tabs, show only the two highest-priority cards (approvals → add money / finish setup → Earn promo); the rest wait their turn. Never a black CTA: the main action is always honey.
- **Selected chips:** an outline on the page colour, never a honey tint (that reads as disabled).
- **Loading:** `useFirstLoad(LOADS.x)` (keys in `src/lib/loads.ts`; same data = same key) with `SkeletonReveal` and the `Skeleton*` pieces. Skeleton only what's genuinely fetched; anything already in memory (a proposal opened from a list, labels, our own copy) renders straight away. Bars use `c.skeleton` (never `c.raised`, which vanishes on cards), are pills by default, and match the real layout so nothing jumps.
- **Empty:** every list gets an `EmptyState` (`compact` inside cards) with an `action` when there's a next step; an unfunded wallet (`useWalletView().empty`) never shows demo money.
