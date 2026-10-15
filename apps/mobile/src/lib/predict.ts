import type { IconName } from '@/components/Icon';
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

export const predictMarket = (id: string) => PREDICT_MARKETS.find((m) => m.id === id);

/** The Yes/Up price of a market, or of one outcome of a multi-outcome market. */
export function yesPrice(market: PredictMarket, outcomeId?: string) {
  if (market.kind !== 'multi') return market.yes;
  return (market.outcomes.find((o) => o.id === outcomeId) ?? market.outcomes[0]).yes;
}

/** Saved (bookmarked) markets; in memory, so it resets when the app restarts. */
const saved = createStore<string[]>([]);
export const useSavedMarkets = saved.use;
export function toggleSaved(id: string) {
  saved.set((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
}

/** Predict intro banner; in memory, so it shows again after a restart. */
const predictUi = createStore({ introDismissed: false });
export const usePredictUi = predictUi.use;
export function dismissPredictIntro() {
  predictUi.set((s) => ({ ...s, introDismissed: true }));
}
