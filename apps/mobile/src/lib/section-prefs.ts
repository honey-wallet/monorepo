import type { Chain } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';

/**
 * Preferences for the Search, Savings and Activity tabs, set from each tab's gear.
 * (Trade's live in trade-prefs.ts; wallet-wide ones in settings.ts.) In memory for
 * now, so they reset when the app restarts.
 */

export type SearchSort = 'volume' | 'marketCap' | 'gainers' | 'losers';
export type ActivityFilter = 'All' | 'Sent' | 'Received' | 'Swaps';

type SectionPrefs = {
  searchSort: SearchSort;
  /** Network the Search tab starts filtered to; null shows all. */
  searchNetwork: Chain | null;
  searchShowFavorites: boolean;
  searchShowEarn: boolean;
  savingsJarToken: 'USDC' | 'USDT';
  savingsShowEarn: boolean;
  activityFilter: ActivityFilter;
  activityHideApprovals: boolean;
};

const prefs = createStore<SectionPrefs>({
  searchSort: 'volume',
  searchNetwork: null,
  searchShowFavorites: true,
  searchShowEarn: true,
  savingsJarToken: 'USDC',
  savingsShowEarn: true,
  activityFilter: 'All',
  activityHideApprovals: false,
});

export const useSectionPrefs = prefs.use;

export function updateSectionPrefs(update: Partial<SectionPrefs>) {
  prefs.set((prev) => ({ ...prev, ...update }));
}
