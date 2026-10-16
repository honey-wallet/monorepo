/**
 * Keys for `useFirstLoad`. Screens that show the same data share a key, so it loads
 * (and skeletons) once a session, wherever it's first seen.
 */
export const LOADS = {
  /** A wallet's token balances: Home, Portfolio, a shared wallet's page, token lists. */
  balances: (walletId: string) => `balances:${walletId}`,
  /** A wallet's history; for a shared wallet, its proposals. */
  activity: (walletId: string) => `activity:${walletId}`,
  /** Spot prices, volumes and APYs: Search and the token pickers. */
  market: 'market',
  token: (symbol: string) => `token:${symbol}`,
  perpsMarkets: 'perps-markets',
  perp: (symbol: string) => `perp:${symbol}`,
  predictFeed: 'predict-feed',
  predict: (id: string) => `predict:${id}`,
  earnRates: 'earn-rates',
  earn: (symbol: string) => `earn:${symbol}`,
  positions: 'positions',
  trades: 'trades',
  nfts: 'nfts',
  notifications: 'notifications',
  /** What's waiting for your approval across your shared wallets: Home's nudge. */
  approvals: 'approvals',
  recipients: 'recipients',
  tx: (id: string) => `tx:${id}`,
  /** Balance history behind Portfolio's chart. */
  history: (walletId: string) => `history:${walletId}`,
  /** Every wallet's total, for the wallet switcher. */
  walletTotals: 'wallet-totals',
  /** Which wallets have smart wallet features on: read from each account on chain. */
  smartWallets: 'smart-wallets',
  /** A name.honey handle resolving to its address. */
  handle: (handle: string) => `handle:${handle.toLowerCase()}`,
} as const;
