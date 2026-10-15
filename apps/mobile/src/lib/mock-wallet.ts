/**
 * Placeholder wallet data so the wallet screens can be designed and tested.
 *
 * TODO: replace with real balances and history once the server exposes them
 * (`GET /accounts/{id}` and the per-chain adapters are still 501 stubs).
 */

export type Token = {
  symbol: string;
  name: string;
  amount: number;
  usd: number;
  /** 24h change, in percent. */
  change: number;
  hidden?: boolean;
};

export const TOKENS: Token[] = [
  { symbol: 'ETH', name: 'Ethereum', amount: 0.0042, usd: 10.54, change: -5.8 },
  { symbol: 'BTC', name: 'Bitcoin', amount: 0.00012, usd: 7.82, change: 1.24 },
  { symbol: 'SOL', name: 'Solana', amount: 0.031, usd: 4.61, change: -2.1 },
  { symbol: 'USDC', name: 'USD Coin', amount: 7.08, usd: 7.08, change: 0.01 },
  { symbol: 'TRX', name: 'Tron', amount: 9.8, usd: 2.35, change: 0.42 },
  { symbol: 'XRP', name: 'XRP', amount: 0.9, usd: 0.31, change: -0.8 },
  {
    symbol: 'PEPE',
    name: 'Pepe',
    amount: 12000,
    usd: 0.01,
    change: 12.5,
    hidden: true,
  },
  {
    symbol: 'SHIB',
    name: 'Shiba Inu',
    amount: 300,
    usd: 0,
    change: -3.3,
    hidden: true,
  },
];

const visible = TOKENS.filter((t) => !t.hidden);
export const BALANCE = visible.reduce((sum, t) => sum + t.usd, 0);
export const BALANCE_CHANGE = visible.reduce((sum, t) => sum + (t.usd * t.change) / 100, 0);

export type Chain = 'Bitcoin' | 'Ethereum' | 'Solana' | 'Tron' | 'XRP Ledger';

/** The chains Honey supports, each shown with its native token's logo. */
export const CHAINS: { name: Chain; symbol: string }[] = [
  { name: 'Bitcoin', symbol: 'BTC' },
  { name: 'Ethereum', symbol: 'ETH' },
  { name: 'Solana', symbol: 'SOL' },
  { name: 'Tron', symbol: 'TRX' },
  { name: 'XRP Ledger', symbol: 'XRP' },
];

export type MarketToken = {
  symbol: string;
  name: string;
  chain: Chain;
  price: number;
  /** 24h change, in percent. */
  change: number;
  /** 24h volume, in USD. */
  volume: number;
  marketCap: number;
};

/** Market prices for search. TODO: replace with the market data API. */
export const MARKET: MarketToken[] = [
  {
    symbol: 'ETH',
    name: 'Ethereum',
    chain: 'Ethereum',
    price: 2357.35,
    change: -5.94,
    volume: 1.85e9,
    marketCap: 284e9,
  },
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    chain: 'Bitcoin',
    price: 80649.68,
    change: -3.32,
    volume: 1.42e9,
    marketCap: 1.6e12,
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    chain: 'Ethereum',
    price: 1,
    change: 0,
    volume: 1.18e9,
    marketCap: 73e9,
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    chain: 'Tron',
    price: 0.999,
    change: -0.02,
    volume: 645.68e6,
    marketCap: 168e9,
  },
  {
    symbol: 'SOL',
    name: 'Solana',
    chain: 'Solana',
    price: 148.71,
    change: -2.1,
    volume: 512.4e6,
    marketCap: 71e9,
  },
  {
    symbol: 'XRP',
    name: 'XRP',
    chain: 'XRP Ledger',
    price: 0.34,
    change: -0.8,
    volume: 233.9e6,
    marketCap: 19e9,
  },
  {
    symbol: 'TRX',
    name: 'Tron',
    chain: 'Tron',
    price: 0.24,
    change: 0.42,
    volume: 118.2e6,
    marketCap: 21e9,
  },
];

export const FAVORITES = ['ETH', 'BTC'];
/** Placeholder rates for "Start earning". TODO: real yield source and rates. */
export const EARN: { symbol: string; apy: number }[] = [
  { symbol: 'USDT', apy: 2.5 },
  { symbol: 'USDC', apy: 4.35 },
];

export const ADDRESS = '0x7a3F9c21b4E8d0a5C6f1E2B39d4a8C7e5F01aB3c';

type WalletKind = 'wallet' | 'multisig' | 'hardware';

export type Wallet = {
  id: string;
  kind: WalletKind;
  label: string;
  address: string;
  usd: number;
  /** Multisig only: approvals needed out of total signers. */
  threshold?: [number, number];
};

export function otherWallets(name: string): Wallet[] {
  return [
    {
      id: 'savings',
      kind: 'wallet',
      label: 'Savings',
      address: '0xacdF4b19e27c5D83a6B0f2C1d9E8a7b6c5D4E93',
      usd: 17.85,
    },
    {
      id: 'trading',
      kind: 'wallet',
      label: 'Trading',
      address: '0xBf3273aD8c1e9F04b7A62d5E3c8b1f0a9e924312',
      usd: 0.48,
    },
    {
      id: 'family',
      kind: 'multisig',
      label: `${name}'s Multisig`,
      address: '0xABC4d2E8f1a7B3c9D0e5F6a2b8C4d1E7f3A9b05e',
      usd: 120.4,
      threshold: [2, 3],
    },
    {
      id: 'team',
      kind: 'multisig',
      label: 'Team Treasury',
      address: '0xABCe91F0c3B7a2D8e4f6A1b5C9d3E7f2a8B6c41d',
      usd: 1420.06,
      threshold: [3, 5],
    },
  ];
}

export type Activity = {
  id: string;
  kind: 'sent' | 'received' | 'swapped' | 'approved';
  /** Token whose logo leads the row. */
  symbol: string;
  /** e.g. "0.300 USDC to 0x41CD…eEE3". Swaps use `swap` instead. */
  detail?: string;
  swap?: { from: [string, string]; to: [string, string] };
  month: string;
  date: string;
};

export const ACTIVITY: Activity[] = [
  {
    id: '1',
    kind: 'sent',
    symbol: 'USDC',
    detail: '0.300 USDC to 0x41CD…eEE3',
    month: 'October',
    date: 'Oct 8',
  },
  {
    id: '2',
    kind: 'sent',
    symbol: 'ETH',
    detail: '<0.001 ETH to 0xBf32…4312',
    month: 'October',
    date: 'Oct 8',
  },
  {
    id: '3',
    kind: 'received',
    symbol: 'BTC',
    detail: '0.00012 BTC from bc1q…x7k2',
    month: 'October',
    date: 'Oct 7',
  },
  {
    id: '4',
    kind: 'swapped',
    symbol: 'TRX',
    swap: { from: ['TRX', '1.20'], to: ['XRP', '0.31'] },
    month: 'October',
    date: 'Oct 7',
  },
  {
    id: '5',
    kind: 'approved',
    symbol: 'USDC',
    detail: 'Unlimited USDC',
    month: 'October',
    date: 'Oct 7',
  },
  {
    id: '6',
    kind: 'received',
    symbol: 'SOL',
    detail: '0.031 SOL from 9xQe…Fz2P',
    month: 'October',
    date: 'Oct 5',
  },
  {
    id: '7',
    kind: 'sent',
    symbol: 'XRP',
    detail: '0.50 XRP to rPT1…4Kdz',
    month: 'September',
    date: 'Sep 28',
  },
  {
    id: '8',
    kind: 'received',
    symbol: 'USDC',
    detail: '7.08 USDC from 0xFD03…b7F0',
    month: 'September',
    date: 'Sep 21',
  },
];

export function shortAddress(address: string, head = 6, tail = 4) {
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function formatUsd(value: number) {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact dollar amounts for volumes, e.g. $1.85B or $645.68M. */
export function formatCompactUsd(value: number) {
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  const [size, unit] = units.find(([n]) => value >= n) ?? [1, ''];
  return `$${(value / size).toFixed(2)}${unit}`;
}

/** Token amounts, e.g. 0.0042 or 12,000. */
export function formatAmount(value: number, maxDecimals = 6) {
  return value.toLocaleString('en-US', { maximumFractionDigits: maxDecimals });
}

/** Balances on send/buy screens: 6 decimals under 1, else 4 (0.000123, 7.08). */
export function formatBalance(value: number) {
  return formatAmount(value, value < 1 ? 6 : 4);
}

/** Prices keep sub-dollar precision, e.g. $0.999 or $80,649.68. */
export function formatPrice(value: number) {
  return value < 1 ? `$${Number(value.toPrecision(3))}` : formatUsd(value);
}

// ---------------------------------------------------------------------------
// Charts

export type Range = '1H' | '1D' | '1W' | '1M' | '1Y' | 'All';
export const RANGES: Range[] = ['1H', '1D', '1W', '1M', '1Y', 'All'];

/** How each range describes its change, e.g. "$1.13 (4.20%) today". */
export const RANGE_LABEL: Record<Range, string> = {
  '1H': 'past hour',
  '1D': 'today',
  '1W': 'past week',
  '1M': 'past month',
  '1Y': 'past year',
  All: 'all time',
};

const POINTS: Record<Range, number> = {
  '1H': 60,
  '1D': 96,
  '1W': 84,
  '1M': 90,
  '1Y': 104,
  All: 120,
};
const SWING: Record<Range, number> = {
  '1H': 0.004,
  '1D': 0.012,
  '1W': 0.03,
  '1M': 0.06,
  '1Y': 0.18,
  All: 0.35,
};

/** Small seeded PRNG so a chart looks the same every time it's drawn. */
function prng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/**
 * A deterministic random walk ending at `end`, `changePct` above or below where it
 * started. Placeholder until the price history API exists.
 */
export function series(key: string, range: Range, end: number, changePct?: number): number[] {
  const rand = prng(`${key}-${range}`);
  const n = POINTS[range];
  const change = changePct ?? (rand() - 0.55) * SWING[range] * 200;
  const start = end / (1 + change / 100);
  const out: number[] = [];
  let noise = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    noise = noise * 0.85 + (rand() - 0.5) * SWING[range] * 0.5;
    out.push((start + (end - start) * t) * (1 + noise * Math.sin(Math.PI * t)));
  }
  out[n - 1] = end;
  return out;
}

/** A day of balance samples for the home sparkline. */
export const BALANCE_HISTORY = series(
  'portfolio',
  '1D',
  BALANCE,
  (BALANCE_CHANGE / (BALANCE - BALANCE_CHANGE)) * 100,
);

// ---------------------------------------------------------------------------
// Token details

type Holding = { chain: Chain; amount: number; usd: number };

type TokenInfo = {
  about: string;
  website: string;
  explorer: { label: string; url: string };
  fdv: number;
  high52: number;
  low52: number;
  /** Where your balance of this token lives, by chain. */
  holdings: Holding[];
  performance: { averageCost: number; unrealized: number; realized: number };
};

export const TOKEN_INFO: Record<string, TokenInfo> = {
  ETH: {
    about:
      'Ethereum is a smart contract platform that lets developers build tokens and decentralised apps. ETH is its native currency and pays the network fees.',
    website: 'https://ethereum.org',
    explorer: { label: 'Etherscan', url: 'https://etherscan.io' },
    fdv: 284e9,
    high52: 4173.02,
    low52: 1489.81,
    holdings: [{ chain: 'Ethereum', amount: 0.0042, usd: 10.54 }],
    performance: { averageCost: 3458.97, unrealized: -3.73, realized: -12.08 },
  },
  BTC: {
    about:
      'Bitcoin is the first decentralised digital currency: a fixed supply of 21 million coins, secured by proof of work and held by millions of people.',
    website: 'https://bitcoin.org',
    explorer: { label: 'Mempool', url: 'https://mempool.space' },
    fdv: 1.69e12,
    high52: 109114.88,
    low52: 49121.2,
    holdings: [{ chain: 'Bitcoin', amount: 0.00012, usd: 7.82 }],
    performance: { averageCost: 71250.4, unrealized: 0.98, realized: 0 },
  },
  SOL: {
    about:
      'Solana is a fast, low-fee blockchain for payments and apps. SOL pays for transactions and secures the network through staking.',
    website: 'https://solana.com',
    explorer: { label: 'Solscan', url: 'https://solscan.io' },
    fdv: 88e9,
    high52: 294.33,
    low52: 95.16,
    holdings: [{ chain: 'Solana', amount: 0.031, usd: 4.61 }],
    performance: { averageCost: 162.1, unrealized: -0.42, realized: 0.31 },
  },
  USDC: {
    about:
      'USD Coin is a fully reserved stablecoin issued by Circle. Each USDC is backed one-to-one by cash and short-term US government bonds.',
    website: 'https://www.circle.com/usdc',
    explorer: { label: 'Etherscan', url: 'https://etherscan.io' },
    fdv: 73e9,
    high52: 1.01,
    low52: 0.99,
    holdings: [
      { chain: 'Ethereum', amount: 4.01, usd: 4.01 },
      { chain: 'Solana', amount: 2.26, usd: 2.26 },
      { chain: 'Tron', amount: 0.81, usd: 0.81 },
    ],
    performance: { averageCost: 1, unrealized: 0, realized: 0 },
  },
  TRX: {
    about:
      'Tron is a high-throughput blockchain widely used for stablecoin transfers. TRX pays for network resources.',
    website: 'https://tron.network',
    explorer: { label: 'Tronscan', url: 'https://tronscan.org' },
    fdv: 21e9,
    high52: 0.31,
    low52: 0.12,
    holdings: [{ chain: 'Tron', amount: 9.8, usd: 2.35 }],
    performance: { averageCost: 0.21, unrealized: 0.29, realized: 0 },
  },
  XRP: {
    about:
      'XRP is the native asset of the XRP Ledger, built for fast, low-cost payments and settlement between currencies.',
    website: 'https://xrpl.org',
    explorer: { label: 'XRPScan', url: 'https://xrpscan.com' },
    fdv: 34e9,
    high52: 3.4,
    low52: 0.43,
    holdings: [{ chain: 'XRP Ledger', amount: 0.9, usd: 0.31 }],
    performance: { averageCost: 0.52, unrealized: -0.16, realized: 0 },
  },
};

export function chainSymbol(chain: Chain) {
  return CHAINS.find((c) => c.name === chain)?.symbol ?? 'GENERIC';
}

/** Market data for a token, by symbol. */
export function marketOf(symbol: string) {
  return MARKET.find((t) => t.symbol === symbol);
}

/** Placeholder market price of a token, 0 when unknown. */
export function priceOf(symbol: string) {
  return marketOf(symbol)?.price ?? 0;
}

/** A token's display name: from your tokens, else the market, else its symbol. */
export function tokenName(symbol: string) {
  return TOKENS.find((t) => t.symbol === symbol)?.name ?? marketOf(symbol)?.name ?? symbol;
}

/** Every balance you hold, one entry per token per network, largest first. */
export const HOLDINGS = TOKENS.filter((t) => !t.hidden)
  .flatMap((t) => (TOKEN_INFO[t.symbol]?.holdings ?? []).map((h) => ({ symbol: t.symbol, ...h })))
  .sort((a, b) => b.usd - a.usd);

/** Networks you hold a balance on. */
export const HELD_CHAINS = new Set(HOLDINGS.filter((h) => h.amount > 0).map((h) => h.chain));

/** How much of `symbol` you hold on `chain`. */
export function holdingAmount(symbol: string, chain: Chain) {
  return TOKEN_INFO[symbol]?.holdings.find((h) => h.chain === chain)?.amount ?? 0;
}

// ---------------------------------------------------------------------------
// Earn (placeholder vault terms; TODO: real yield source)

export type Vault = {
  symbol: string;
  apy: number;
  exposure: string[];
  deposits: number;
  liquidity: number;
  curator: string;
  address: string;
  deployed: string;
};

export const VAULTS: Record<string, Vault> = {
  USDT: {
    symbol: 'USDT',
    apy: 2.5,
    exposure: ['ETH', 'BTC', 'SOL'],
    deposits: 6.56e6,
    liquidity: 4.0e6,
    curator: 'Honey',
    address: '0xb827a3F1c9D4e5B2a7C0d8E6f1A9b3C5d7E2D703',
    deployed: 'Jun 8, 2026',
  },
  USDC: {
    symbol: 'USDC',
    apy: 4.35,
    exposure: ['ETH', 'BTC'],
    deposits: 12.4e6,
    liquidity: 7.9e6,
    curator: 'Honey',
    address: '0x4c19e8B2a7D3f0C5b9A1e6D2c8F7a3B0e5C1A2f9',
    deployed: 'May 21, 2026',
  },
};

// ---------------------------------------------------------------------------
// Transaction details and recipients

type ActivityDetail = {
  amount: string;
  usd: number;
  counterparty: string;
  chain: Chain;
  fee: string;
  hash: string;
  time: string;
};

export const ACTIVITY_DETAILS: Record<string, ActivityDetail> = {
  '1': {
    amount: '0.300 USDC',
    usd: 0.3,
    counterparty: 'Savings',
    chain: 'Ethereum',
    fee: '<$0.01',
    hash: '0x956c4e2a…123b',
    time: 'October 8, 2026 6:16 PM',
  },
  '2': {
    amount: '<0.001 ETH',
    usd: 1.24,
    counterparty: '0xBf32…4312',
    chain: 'Ethereum',
    fee: '$0.02',
    hash: '0x1a7f90c3…8e04',
    time: 'October 8, 2026 2:41 PM',
  },
  '3': {
    amount: '0.00012 BTC',
    usd: 7.82,
    counterparty: 'bc1q…x7k2',
    chain: 'Bitcoin',
    fee: '$0.38',
    hash: '9f3e1b07…c2d1',
    time: 'October 7, 2026 9:12 AM',
  },
  '4': {
    amount: '1.20 TRX → 0.31 XRP',
    usd: 0.31,
    counterparty: 'Honey swap',
    chain: 'Tron',
    fee: '<$0.01',
    hash: '7c0d5a91…44fe',
    time: 'October 7, 2026 8:55 AM',
  },
  '5': {
    amount: 'Unlimited USDC',
    usd: 0,
    counterparty: 'Honey Jar',
    chain: 'Ethereum',
    fee: '$0.01',
    hash: '0x33ab0e7d…90c2',
    time: 'October 7, 2026 8:50 AM',
  },
  '6': {
    amount: '0.031 SOL',
    usd: 4.61,
    counterparty: '9xQe…Fz2P',
    chain: 'Solana',
    fee: '<$0.01',
    hash: '5h2Kq9Lr…vT8m',
    time: 'October 5, 2026 7:03 PM',
  },
  '7': {
    amount: '0.50 XRP',
    usd: 0.17,
    counterparty: 'rPT1…4Kdz',
    chain: 'XRP Ledger',
    fee: '<$0.01',
    hash: 'E08D6E1B…A39C',
    time: 'September 28, 2026 11:20 AM',
  },
  '8': {
    amount: '7.08 USDC',
    usd: 7.08,
    counterparty: '0xFD03…b7F0',
    chain: 'Ethereum',
    fee: '$0.02',
    hash: '0x7e21c4b9…0d6a',
    time: 'September 21, 2026 4:47 PM',
  },
};

type Recipient = { id: string; label?: string; address: string };

export const RECENT_RECIPIENTS: Recipient[] = [
  { id: 'r1', label: 'Savings', address: '0xacdF4b19e27c5D83a6B0f2C1d9E8a7b6c5D4E93' },
  { id: 'r2', label: 'Trading', address: '0xBf3273aD8c1e9F04b7A62d5E3c8b1f0a9e924312' },
  { id: 'r3', address: '0xC834e1a9D2b7f05c3E6a8B1d9F4c2e7A0b5D6408' },
  { id: 'r4', address: '0xDA27b3e8C1f9a4D6e0B2c7F5a8E3d1B9c6A47e47' },
  { id: 'r5', address: '0xcDaE90f2B7a1c8E4d3F6b0A5e9C2d7B1f8A31c47' },
  { id: 'r6', address: '0xd4c3a8E1f6B2c9D0e7A5b3F1c8E2d6A9b0F4B16e' },
];

/** The user's Honey handle, shown when they tap their name, e.g. "honey.honey". */
export function handleFor(name: string) {
  return `${name.trim().toLowerCase().replace(/\s+/g, '')}.honey`;
}
