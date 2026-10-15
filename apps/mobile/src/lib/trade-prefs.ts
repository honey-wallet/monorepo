import { createStore } from '@/lib/store';

/**
 * Per-product trade preferences, set from the gear on each Trade tab. Each one
 * changes what its order form starts with. In memory for now; resets on restart.
 */

/** Leverage the Perps order sheet starts on (capped at each market's maximum). */
export const PERP_LEVERAGE_STEPS = [2, 5, 10, 20] as const;
export type MarginMode = 'Cross' | 'Isolated';
export const SLIPPAGES = ['0.1%', '0.5%', '1%', '3%'] as const;
export type Slippage = (typeof SLIPPAGES)[number];
/** Futures and options contract expiries. */
export const EXPIRIES = ['Dec 26', 'Mar 27', 'Jun 27'] as const;
export type Expiry = (typeof EXPIRIES)[number];
export type PriceFormat = 'Cents' | 'Percent';

type TradePrefs = {
  perpLeverage: (typeof PERP_LEVERAGE_STEPS)[number];
  marginMode: MarginMode;
  perpSlippage: Slippage;
  predictPrice: PriceFormat;
  predictAlerts: boolean;
  futuresExpiry: Expiry;
  futuresSlippage: Slippage;
  optionsExpiry: Expiry;
};

const prefs = createStore<TradePrefs>({
  perpLeverage: 5,
  marginMode: 'Cross',
  perpSlippage: '0.5%',
  predictPrice: 'Cents',
  predictAlerts: true,
  futuresExpiry: 'Dec 26',
  futuresSlippage: '0.5%',
  optionsExpiry: 'Dec 26',
});

export const useTradePrefs = prefs.use;

export function updateTradePrefs(update: Partial<TradePrefs>) {
  prefs.set((prev) => ({ ...prev, ...update }));
}

/** A prediction share price (0–1) as "51¢" or "51%", per the Predict setting. */
export function formatShare(price: number, format: PriceFormat) {
  const n = Math.round(price * 100);
  return format === 'Cents' ? `${n}¢` : `${n}%`;
}
