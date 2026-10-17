import { Appearance } from 'react-native';
import type { IconName } from '@/components/Icon';
import { createStore } from '@/lib/store';

export type ThemePreference = 'auto' | 'light' | 'dark';

/**
 * Every product on the Trade tab; users choose which show, and in what order.
 * Swap also bridges: picking tokens on two networks routes across chains, so there
 * is no separate Bridge tab.
 */
export const TRADE_MODES = ['Swap', 'Perps', 'Predict', 'Futures', 'Options'] as const;
export type TradeMode = (typeof TRADE_MODES)[number];

/**
 * The products that can be shown for now. Futures and Options are switched off until
 * they're built out; add them back here to bring them back (their screens stay in place).
 */
export const AVAILABLE_TRADE_MODES: readonly TradeMode[] = ['Swap', 'Perps', 'Predict'];
// export const AVAILABLE_TRADE_MODES: readonly TradeMode[] = TRADE_MODES;

/** Each Trade product's symbol and one-line description (Trade's tabs and the tabs editor). */
export const TRADE_MODE_INFO: Record<TradeMode, { icon: IconName; hint: string }> = {
  Swap: { icon: 'trade', hint: 'Trade or bridge, any network' },
  Perps: { icon: 'trendUp', hint: 'Long or short, with leverage' },
  Predict: { icon: 'predict', hint: 'Yes or no on real events' },
  Futures: { icon: 'clock', hint: 'Settle on a set date' },
  Options: { icon: 'layers', hint: 'Calls and puts' },
};

export type Settings = {
  theme: ThemePreference;
  currency: string;
  language: string;
  hideSmallBalances: boolean;
  hideUnknownTokens: boolean;
  hideReportedActivity: boolean;
  testnet: boolean;
  networkCost: 'auto' | 'custom';
  faceIdAppAccess: boolean;
  faceIdTransactions: boolean;
  analytics: boolean;
  backedUp: boolean;
  /** Mask your balance (home, the balance pill and sheet) from people nearby. */
  hideBalance: boolean;
  /** Trade tabs shown, in order. Shared wallets only ever show Swap (see `lib/trade-modes.ts`). */
  tradeTabs: TradeMode[];
  /** Home's "Earn with a Honey Jar" card, until it's swiped or closed away. */
  earnPromo: boolean;
  /** DEMO: every confirm fails, to review the failure pages (see `lib/outcomes.ts`). */
  simulateFailures: boolean;
};

export const settings = createStore<Settings>({
  theme: 'auto',
  currency: 'USD',
  language: 'English',
  hideSmallBalances: true,
  hideUnknownTokens: true,
  hideReportedActivity: true,
  testnet: false,
  networkCost: 'auto',
  faceIdAppAccess: false,
  faceIdTransactions: true,
  analytics: true,
  backedUp: false,
  hideBalance: false,
  tradeTabs: [...AVAILABLE_TRADE_MODES],
  earnPromo: true,
  simulateFailures: false,
});

export const useSettings = settings.useValue;

export function updateSettings(update: Partial<Settings>) {
  settings.set((prev) => ({ ...prev, ...update }));
}

/** What a hidden balance shows instead of the amount. */
export const HIDDEN_AMOUNT = '$••••';

export function toggleHideBalance() {
  settings.set((prev) => ({ ...prev, hideBalance: !prev.hideBalance }));
}

/** Applies the theme everywhere at once; "auto" follows the device. */
export function setTheme(theme: ThemePreference) {
  updateSettings({ theme });
  Appearance.setColorScheme(theme === 'auto' ? 'unspecified' : theme);
}

export const CURRENCIES: [code: string, name: string][] = [
  ['USD', 'United States Dollar'],
  ['ARS', 'Argentine Peso'],
  ['AUD', 'Australian Dollar'],
  ['BRL', 'Brazilian Real'],
  ['CAD', 'Canadian Dollar'],
  ['CNY', 'Chinese Yuan'],
  ['EUR', 'Euro'],
  ['GBP', 'British Pound'],
  ['HKD', 'Hong Kong Dollar'],
  ['IDR', 'Indonesian Rupiah'],
  ['INR', 'Indian Rupee'],
  ['JPY', 'Japanese Yen'],
  ['KRW', 'South Korean Won'],
  ['MXN', 'Mexican Peso'],
  ['NZD', 'New Zealand Dollar'],
  ['SGD', 'Singapore Dollar'],
  ['CHF', 'Swiss Franc'],
];

/** App languages, each with the flag of the country most associated with it. */
export const LANGUAGES: [name: string, flag: string][] = [
  ['English', '🇺🇸'],
  ['Chinese, Simplified', '🇨🇳'],
  ['Chinese, Traditional', '🇹🇼'],
  ['French', '🇫🇷'],
  ['German', '🇩🇪'],
  ['Hindi', '🇮🇳'],
  ['Japanese', '🇯🇵'],
  ['Korean', '🇰🇷'],
  ['Portuguese', '🇧🇷'],
  ['Spanish (Spain)', '🇪🇸'],
  ['Spanish (Latin America)', '🇲🇽'],
  ['Turkish', '🇹🇷'],
  ['Vietnamese', '🇻🇳'],
];
