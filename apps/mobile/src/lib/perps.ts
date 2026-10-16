import { type Range, series } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';

/**
 * Placeholder perpetual-futures markets so the Perps screens can be designed.
 *
 * TODO: replace with a perps venue's market data (prices, funding, open interest)
 * once one is chosen; nothing here is live.
 */

export type PerpCategory = 'Crypto' | 'Stocks' | 'Commodities' | 'Indices';
export const PERP_CATEGORIES: ('All' | PerpCategory)[] = [
  'All',
  'Crypto',
  'Stocks',
  'Commodities',
  'Indices',
];

export type PerpMarket = {
  symbol: string;
  name: string;
  category: PerpCategory;
  price: number;
  /** 24h change, in percent. */
  change: number;
  /** 24h volume, in USD. */
  volume: number;
  openInterest: number;
  maxLeverage: number;
  /** Hourly funding rate, in percent; positive means longs pay shorts. */
  funding: number;
  /** Logo when there's no coin logo: short text on a brand colour. */
  monogram?: { text: string; color: string };
};

export const PERP_MARKETS: PerpMarket[] = [
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    category: 'Crypto',
    price: 81208,
    change: -2.69,
    volume: 4.0e9,
    openInterest: 2.6e9,
    maxLeverage: 40,
    funding: 0.0012,
  },
  {
    symbol: 'ETH',
    name: 'Ethereum',
    category: 'Crypto',
    price: 2372.3,
    change: -5.36,
    volume: 1.8e9,
    openInterest: 1.1e9,
    maxLeverage: 25,
    funding: 0.0009,
  },
  {
    symbol: 'SOL',
    name: 'Solana',
    category: 'Crypto',
    price: 103.03,
    change: -3.96,
    volume: 4.9e8,
    openInterest: 3.2e8,
    maxLeverage: 20,
    funding: 0.0015,
  },
  {
    symbol: 'XRP',
    name: 'XRP',
    category: 'Crypto',
    price: 0.344,
    change: -0.8,
    volume: 2.1e8,
    openInterest: 1.4e8,
    maxLeverage: 20,
    funding: 0.0006,
  },
  {
    symbol: 'TRX',
    name: 'Tron',
    category: 'Crypto',
    price: 0.24,
    change: 0.42,
    volume: 6.4e7,
    openInterest: 3.9e7,
    maxLeverage: 10,
    funding: 0.0004,
  },
  {
    symbol: 'SPX',
    name: 'S&P 500',
    category: 'Indices',
    price: 7696.2,
    change: -1.57,
    volume: 5.1e8,
    openInterest: 4.2e8,
    maxLeverage: 50,
    funding: 0.0005,
    monogram: { text: 'S&P', color: '#D7263D' },
  },
  {
    symbol: 'NDX',
    name: 'Nasdaq 100',
    category: 'Indices',
    price: 29610,
    change: -3.23,
    volume: 5.8e8,
    openInterest: 3.6e8,
    maxLeverage: 30,
    funding: 0.0007,
    monogram: { text: '100', color: '#1F2A44' },
  },
  {
    symbol: 'NVDA',
    name: 'Nvidia',
    category: 'Stocks',
    price: 182.4,
    change: -4.12,
    volume: 3.3e8,
    openInterest: 1.9e8,
    maxLeverage: 10,
    funding: 0.0011,
    monogram: { text: 'NV', color: '#76B900' },
  },
  {
    symbol: 'TSLA',
    name: 'Tesla',
    category: 'Stocks',
    price: 412.7,
    change: 2.35,
    volume: 2.7e8,
    openInterest: 1.5e8,
    maxLeverage: 10,
    funding: 0.0013,
    monogram: { text: 'T', color: '#CC0000' },
  },
  {
    symbol: 'GOLD',
    name: 'Gold',
    category: 'Commodities',
    price: 4021.5,
    change: 0.64,
    volume: 1.9e8,
    openInterest: 1.2e8,
    maxLeverage: 25,
    funding: 0.0003,
    monogram: { text: 'Au', color: '#C9A227' },
  },
  {
    symbol: 'SILVER',
    name: 'Silver',
    category: 'Commodities',
    price: 56.586,
    change: 1.12,
    volume: 9.8e7,
    openInterest: 6.1e7,
    maxLeverage: 25,
    funding: 0.0004,
    monogram: { text: 'Ag', color: '#8E9AA6' },
  },
];

export const perpMarket = (symbol: string) => PERP_MARKETS.find((m) => m.symbol === symbol);

/** Share of margin lost at liquidation; the rest covers fees and slippage. */
const LIQUIDATION_SHARE = 0.9;

/** Price at which a position at `leverage` is closed automatically. */
export function liquidationPrice(entry: number, leverage: number, side: 'Long' | 'Short') {
  const move = LIQUIDATION_SHARE / leverage;
  return entry * (side === 'Long' ? 1 - move : 1 + move);
}

export type Candle = { open: number; high: number; low: number; close: number };

/** Candles for the chart, built from the same price series as the line charts. */
export function candles(market: PerpMarket, range: Range, count = 36): Candle[] {
  const points = series(`perp-${market.symbol}`, range, market.price, market.change);
  const per = Math.max(1, Math.floor(points.length / count));
  const out: Candle[] = [];
  for (let i = 0; i + 1 < points.length; i += per) {
    const slice = points.slice(i, i + per + 1);
    out.push({
      open: slice[0],
      close: slice[slice.length - 1],
      // A little wick beyond the bodies, so candles read as candles.
      high: Math.max(...slice) * 1.0015,
      low: Math.min(...slice) * 0.9985,
    });
  }
  return out;
}

/** Perps intro banner state; resets when the app restarts. */
/** Hearted perps markets, shown as a Saved filter; in memory, so it resets on restart. */
const savedPerps = createStore<string[]>([]);
export const useSavedPerps = savedPerps.use;
export function toggleSavedPerp(symbol: string) {
  savedPerps.set((s) => (s.includes(symbol) ? s.filter((x) => x !== symbol) : [...s, symbol]));
}

const perpsUi = createStore({ introDismissed: false });
export const usePerpsUi = perpsUi.use;
export function dismissPerpsIntro() {
  perpsUi.set((s) => ({ ...s, introDismissed: true }));
}

export type PerpSort = 'volume' | 'openInterest' | 'gainers' | 'losers' | 'leverage';

/** Sort options for the market list, with how each orders two markets. */
export const PERP_SORTS: {
  value: PerpSort;
  label: string;
  short: string;
  compare: (a: PerpMarket, b: PerpMarket) => number;
}[] = [
  {
    value: 'volume',
    label: 'Volume (24H)',
    short: 'Volume',
    compare: (a, b) => b.volume - a.volume,
  },
  {
    value: 'openInterest',
    label: 'Open interest',
    short: 'Open interest',
    compare: (a, b) => b.openInterest - a.openInterest,
  },
  {
    value: 'gainers',
    label: 'Top gainers (24H)',
    short: 'Gainers',
    compare: (a, b) => b.change - a.change,
  },
  {
    value: 'losers',
    label: 'Top losers (24H)',
    short: 'Losers',
    compare: (a, b) => a.change - b.change,
  },
  {
    value: 'leverage',
    label: 'Max leverage',
    short: 'Leverage',
    compare: (a, b) => b.maxLeverage - a.maxLeverage,
  },
];

// ---------------------------------------------------------------------------
// Positions

export type PerpSide = 'Long' | 'Short';

export type PerpPosition = {
  id: string;
  symbol: string;
  side: PerpSide;
  leverage: number;
  /** Margin put up, in USD. */
  margin: number;
  /** Price when it was opened. */
  entry: number;
};

/**
 * Open positions; in memory, so they reset when the app restarts. Starts with one
 * demo position so the position card has something to show.
 */
const positions = createStore<PerpPosition[]>([
  {
    id: 'demo-eth',
    symbol: 'ETH',
    side: 'Long',
    leverage: 5,
    margin: 100,
    entry: (perpMarket('ETH')?.price ?? 2400) * 0.972,
  },
]);
export const usePerpPositions = positions.use;

export function openPosition(position: Omit<PerpPosition, 'id'>) {
  const id = `${position.symbol}-${Date.now()}`;
  positions.set((list) => [{ ...position, id }, ...list]);
  return id;
}

export function closePosition(id: string) {
  positions.set((list) => list.filter((p) => p.id !== id));
}

/** A position's size, profit or loss, and liquidation price at the market's price now. */
export function positionStats(position: PerpPosition) {
  const price = perpMarket(position.symbol)?.price ?? position.entry;
  const size = position.margin * position.leverage;
  const move = ((price - position.entry) / position.entry) * (position.side === 'Long' ? 1 : -1);
  const pnl = size * move;
  return {
    price,
    size,
    pnl,
    /** Return on margin, in percent. */
    roe: (pnl / position.margin) * 100,
    liquidation: liquidationPrice(position.entry, position.leverage, position.side),
  };
}
