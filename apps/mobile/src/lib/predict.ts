import type { IconName } from '@/components/Icon';
import { prng } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';

/**
 * Placeholder prediction markets so the Predict screens can be designed.
 *
 * TODO: replace with a real prediction-market data source (prices, volume, outcomes,
 * resolution) once one is chosen; nothing here is live.
 */

export type PredictCategory = 'Politics' | 'Sports' | 'Crypto' | 'Economy' | 'Culture' | 'Tech';
export const PREDICT_CATEGORIES: ('All' | PredictCategory)[] = [
  'All',
  'Politics',
  'Sports',
  'Crypto',
  'Economy',
  'Culture',
  'Tech',
];

/** One answer of a multi-outcome market, each traded as its own Yes/No. */
export type Outcome = { id: string; label: string; yes: number };

type Base = {
  id: string;
  question: string;
  category: PredictCategory;
  /** Coin logo for crypto markets; otherwise an icon on a tinted square. */
  symbol?: string;
  icon?: IconName;
  volume: number;
  ends: string;
};

export type PredictMarket =
  /** A single yes/no question. `yes` is the price of a Yes share in dollars; No is 1 − yes. */
  | (Base & { kind: 'binary'; yes: number })
  /** Several answers, each with its own Yes price. */
  | (Base & { kind: 'multi'; outcomes: Outcome[] })
  /** A short live window: will the price be up or down when it closes? `yes` is the Up price. */
  | (Base & { kind: 'updown'; yes: number; window: string });

export const PREDICT_MARKETS: PredictMarket[] = [
  {
    id: 'btc-5m',
    kind: 'updown',
    question: 'BTC Up or Down',
    window: '5m',
    category: 'Crypto',
    symbol: 'BTC',
    yes: 0.51,
    volume: 2.4e6,
    ends: 'Live',
  },
  {
    id: 'fed-dec',
    kind: 'multi',
    question: 'Fed decision in December?',
    category: 'Economy',
    icon: 'bank',
    outcomes: [
      { id: 'hold', label: 'No change', yes: 0.76 },
      { id: 'cut25', label: '25 bps cut', yes: 0.21 },
      { id: 'hike25', label: '25 bps hike', yes: 0.03 },
    ],
    volume: 41e6,
    ends: 'Dec 10',
  },
  {
    id: 'house-2026',
    kind: 'multi',
    question: 'Which party wins the US House in 2026?',
    category: 'Politics',
    icon: 'multisig',
    outcomes: [
      { id: 'dem', label: 'Democratic', yes: 0.62 },
      { id: 'rep', label: 'Republican', yes: 0.38 },
    ],
    volume: 18.3e6,
    ends: 'Nov 3, 2026',
  },
  {
    id: 'btc-100k',
    kind: 'binary',
    question: 'Will BTC close above $100k on Dec 31?',
    category: 'Crypto',
    symbol: 'BTC',
    yes: 0.34,
    volume: 2.1e6,
    ends: 'Dec 31',
  },
  {
    id: 'eth-etf-flows',
    kind: 'binary',
    question: 'Will ETH ETFs see net inflows this week?',
    category: 'Crypto',
    symbol: 'ETH',
    yes: 0.58,
    volume: 940e3,
    ends: 'Fri',
  },
  {
    id: 'world-cup-2026',
    kind: 'multi',
    question: 'Who wins the 2026 World Cup?',
    category: 'Sports',
    icon: 'target',
    outcomes: [
      { id: 'esp', label: 'Spain', yes: 0.17 },
      { id: 'fra', label: 'France', yes: 0.14 },
      { id: 'bra', label: 'Brazil', yes: 0.11 },
    ],
    volume: 27.5e6,
    ends: 'Jul 19, 2026',
  },
  {
    id: 'nba-finals',
    kind: 'binary',
    question: 'Will the 2026 NBA Finals go to Game 7?',
    category: 'Sports',
    icon: 'target',
    yes: 0.19,
    volume: 1.2e6,
    ends: 'Jun 2026',
  },
  {
    id: 'cpi-nov',
    kind: 'binary',
    question: 'Will US CPI inflation come in above 3% for November?',
    category: 'Economy',
    icon: 'chart',
    yes: 0.41,
    volume: 3.6e6,
    ends: 'Dec 11',
  },
  {
    id: 'oscars-best-picture',
    kind: 'binary',
    question: 'Will a sequel win Best Picture at the 2027 Oscars?',
    category: 'Culture',
    icon: 'sparkles',
    yes: 0.08,
    volume: 520e3,
    ends: 'Mar 2027',
  },
  {
    id: 'ai-model-release',
    kind: 'binary',
    question: 'Will a major AI lab release a new flagship model before Jan 1?',
    category: 'Tech',
    icon: 'sparkles',
    yes: 0.72,
    volume: 4.8e6,
    ends: 'Dec 31',
  },
  {
    id: 'sol-15m',
    kind: 'updown',
    question: 'SOL Up or Down',
    window: '15m',
    category: 'Crypto',
    symbol: 'SOL',
    yes: 0.47,
    volume: 610e3,
    ends: 'Live',
  },
];

/**
 * Cash ready to trade with in Predict and Perps (USDC already in the trading account).
 * Placeholder until trading accounts are real.
 */
export const TRADING_CASH = 500;

export const predictMarket = (id: string) => PREDICT_MARKETS.find((m) => m.id === id);

/** The Yes/Up price of a market, or of one outcome of a multi-outcome market. */
export function yesPrice(market: PredictMarket, outcomeId?: string) {
  if (market.kind !== 'multi') return market.yes;
  return (market.outcomes.find((o) => o.id === outcomeId) ?? market.outcomes[0]).yes;
}

/** Hearted markets, shown as a Saved filter; in memory, so it resets on restart. */
const saved = createStore<string[]>([]);
export const useSavedMarkets = saved.useValue;
export function toggleSaved(id: string) {
  saved.set((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
}

/** Predict intro banner; in memory, so it shows again after a restart. */
const predictUi = createStore({ introDismissed: false });
export const usePredictUi = predictUi.useValue;
export function dismissPredictIntro() {
  predictUi.set((s) => ({ ...s, introDismissed: true }));
}

// ---------------------------------------------------------------------------
// Market pages

/** Chart ranges on a market page, as Polymarket offers them. */
export const PREDICT_RANGES = ['1H', '1D', '1W', '1M', 'All'] as const;
export type PredictRange = (typeof PREDICT_RANGES)[number];
export const PREDICT_RANGE_LABEL: Record<PredictRange, string> = {
  '1H': '1H',
  '1D': '1D',
  '1W': '1W',
  '1M': '1M',
  All: 'MAX',
};
const HISTORY_POINTS: Record<PredictRange, number> = {
  '1H': 40,
  '1D': 60,
  '1W': 70,
  '1M': 80,
  All: 90,
};
/** How far a chance wanders over each range, at most. */
const HISTORY_SWING: Record<PredictRange, number> = {
  '1H': 0.02,
  '1D': 0.05,
  '1W': 0.1,
  '1M': 0.16,
  All: 0.24,
};

/** How much time each range covers, in milliseconds (MAX: about six months). */
const RANGE_SPAN: Record<PredictRange, number> = {
  '1H': 3_600_000,
  '1D': 86_400_000,
  '1W': 7 * 86_400_000,
  '1M': 30 * 86_400_000,
  All: 180 * 86_400_000,
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clock = (d: Date) => {
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  return `${h}${m ? `:${String(m).padStart(2, '0')}` : ''} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
};
const day = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;

/**
 * The time at fraction `t` (0 = start, 1 = now) of a chart's range, as an axis tick
 * ("2 PM", "Dec 3", "Oct") or, with `exact`, as the scrub readout ("Dec 3, 2:15 PM").
 */
export function chartTime(range: PredictRange, t: number, exact = false) {
  const d = new Date(Date.now() - RANGE_SPAN[range] * (1 - t));
  if (range === '1H' || range === '1D') {
    if (range === '1H' || !exact) return clock(d);
    return `${day(d)}, ${clock(d)}`;
  }
  if (exact) return range === '1W' ? `${day(d)}, ${clock(d)}` : day(d);
  return range === 'All' ? MONTHS[d.getMonth()] : day(d);
}

/**
 * A chance over time, ending at `end` (0–1). Prediction prices move in steps (a trade
 * lands, the price jumps, then holds), so most points repeat the last one. Seeded, so
 * a chart looks the same each time. Placeholder until a market-data source exists.
 */
export function chanceHistory(key: string, range: PredictRange, end: number): number[] {
  const rand = prng(`chance-${key}-${range}`);
  const n = HISTORY_POINTS[range];
  const swing = HISTORY_SWING[range];
  const start = Math.min(0.97, Math.max(0.02, end + (rand() - 0.5) * swing * 2));
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Drift toward the end value in small steps (a trade lands, the price holds), with
    // the rare bigger move on news.
    const target = start + (end - start) * t;
    const roll = rand();
    if (roll < 0.05) v = target + (rand() - 0.5) * swing * 0.6;
    else if (roll < 0.45) v += (target - v) * 0.25 + (rand() - 0.5) * swing * 0.12;
    out.push(Math.min(0.995, Math.max(0.005, v)));
  }
  out[n - 1] = end;
  return out;
}

/** The lines on a market's chart: one per outcome (top four), or Yes alone. */
export function chartLines(market: PredictMarket, range: PredictRange) {
  if (market.kind === 'multi') {
    return market.outcomes.slice(0, 4).map((o, i) => ({
      id: o.id,
      label: o.label,
      tone: i,
      data: chanceHistory(`${market.id}-${o.id}`, range, o.yes),
    }));
  }
  return [
    {
      id: 'yes',
      label: market.kind === 'updown' ? 'Up' : 'Yes',
      tone: 0,
      data: chanceHistory(market.id, range, market.yes),
    },
  ];
}

/** How a market resolves, in the plain words of its rules. Placeholder copy. */
export function marketRules(market: PredictMarket) {
  const question = market.question.replace(/\?$/, '');
  if (market.kind === 'updown')
    return `This market resolves to “Up” if the ${market.symbol ?? ''} price at the end of the ${market.window} window is higher than at its start, and “Down” otherwise. Prices come from the Chainlink data stream for ${market.symbol ?? 'the asset'}/USD.`;
  if (market.kind === 'multi')
    return `${question}. Each answer trades as its own Yes/No market: the one that happens resolves to “Yes” and pays $1 a share; every other answer resolves to “No”. The market closes ${market.ends}, and resolution follows the official announcement or result.`;
  // "Will BTC close above $100k on Dec 31" → "BTC closes above $100k on Dec 31"-ish:
  // drop the leading "Will" and keep the rest as the condition.
  const condition = question.replace(/^will /i, '');
  return `This market resolves to “Yes” if ${condition}, according to official sources (by ${market.ends}). Otherwise it resolves to “No”. Each winning share pays $1.`;
}

/** Other markets in the same category, for the Related list. */
export function relatedMarkets(market: PredictMarket, count = 3) {
  return PREDICT_MARKETS.filter((m) => m.id !== market.id && m.category === market.category)
    .concat(PREDICT_MARKETS.filter((m) => m.id !== market.id && m.category !== market.category))
    .slice(0, count);
}

/** The headline chance of a market: its Yes/Up price, or its leading outcome's. */
export function leadChance(market: PredictMarket) {
  return market.kind === 'multi' ? Math.max(...market.outcomes.map((o) => o.yes)) : market.yes;
}
