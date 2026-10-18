import { useLocalSearchParams } from 'expo-router';
import { Toggle } from '@/components/motion/Toggle';
import { PillButton } from '@/components/onboarding/PillButton';
import {
  closeSheet,
  SheetField,
  SheetRow,
  SheetScreen,
  WalletSettingsRow,
} from '@/components/sheets/Sheet';
import { OptionChips } from '@/components/trade/TradeForm';
import { TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { CHAINS } from '@/lib/mock-wallet';
import { isWeb } from '@/lib/platform';
import {
  type ActivityFilter,
  type SearchSort,
  updateSectionPrefs,
  useSectionPrefs,
} from '@/lib/section-prefs';

export type Section = 'search' | 'savings' | 'activity';

const TITLES: Record<Section, string> = {
  search: 'Search settings',
  savings: 'Savings settings',
  activity: 'Activity settings',
};

const SORTS: { value: SearchSort; label: string }[] = [
  { value: 'volume', label: 'Volume' },
  { value: 'marketCap', label: 'Mkt cap' },
  { value: 'gainers', label: 'Gainers' },
  { value: 'losers', label: 'Losers' },
];

/** Networks as their coin symbols, so six fit on one row. */
const NETWORKS = ['All', ...CHAINS.map((chain) => chain.symbol)];

/**
 * Settings for one tab (Search, Savings or Activity), opened from its gear. Each
 * changes what that tab shows; Wallet settings at the end leads to the wallet-wide ones.
 */
export default function SectionSettingsSheet() {
  const { section = 'search' } = useLocalSearchParams<{ section?: Section }>();
  const prefs = useSectionPrefs();

  const toggle = (label: string, hint: string, value: boolean, set: (on: boolean) => void) => (
    <SheetRow
      title={label}
      subtitle={hint}
      accessory={
        <Toggle
          accessibilityLabel={label}
          value={value}
          onValueChange={(on) => {
            tap();
            set(on);
          }}
        />
      }
    />
  );

  return (
    <SheetScreen
      title={TITLES[section] ?? TITLES.search}
      footer={<PillButton label="Done" onPress={closeSheet} />}
    >
      {section === 'search' && (
        <>
          <SheetField label="Sort tokens by" hint="How Top tokens is ordered when Search opens.">
            <OptionChips
              options={SORTS.map((s) => s.label)}
              value={SORTS.find((s) => s.value === prefs.searchSort)?.label ?? 'Volume'}
              onChange={(label) =>
                updateSectionPrefs({
                  searchSort: SORTS.find((s) => s.label === label)?.value ?? 'volume',
                })
              }
            />
          </SheetField>
          <SheetField label="Network" hint="Search starts filtered to this network.">
            <OptionChips
              options={NETWORKS}
              // review: each network's logo beside its symbol.
              icon={(symbol) => (symbol === 'All' ? null : <TokenIcon symbol={symbol} size={14} />)}
              value={CHAINS.find((chain) => chain.name === prefs.searchNetwork)?.symbol ?? 'All'}
              onChange={(symbol) =>
                updateSectionPrefs({
                  searchNetwork: CHAINS.find((chain) => chain.symbol === symbol)?.name ?? null,
                })
              }
            />
          </SheetField>
          {toggle(
            'Favorite tokens',
            'Show your favorites at the top',
            prefs.searchShowFavorites,
            (searchShowFavorites) => updateSectionPrefs({ searchShowFavorites }),
          )}
          {/* review: no Savings in the extension, so nothing to toggle there. */}
          {isWeb
            ? null
            : toggle(
                'Start earning',
                'Show earning options',
                prefs.searchShowEarn,
                (searchShowEarn) => updateSectionPrefs({ searchShowEarn }),
              )}
        </>
      )}

      {section === 'savings' && (
        <>
          <SheetField label="New jars save in" hint="The stablecoin a new jar starts with.">
            <OptionChips<'USDC' | 'USDT'>
              options={['USDC', 'USDT']}
              value={prefs.savingsJarToken}
              onChange={(savingsJarToken) => updateSectionPrefs({ savingsJarToken })}
            />
          </SheetField>
          {toggle(
            'Start earning',
            'Show earning options under your jars',
            prefs.savingsShowEarn,
            (savingsShowEarn) => updateSectionPrefs({ savingsShowEarn }),
          )}
        </>
      )}

      {section === 'activity' && (
        <>
          <SheetField label="Show" hint="Which transactions Activity lists.">
            <OptionChips<ActivityFilter>
              options={['All', 'Sent', 'Received', 'Swaps']}
              value={prefs.activityFilter}
              onChange={(activityFilter) => updateSectionPrefs({ activityFilter })}
            />
          </SheetField>
          {toggle(
            'Hide token approvals',
            'Permissions you gave apps to use your tokens',
            prefs.activityHideApprovals,
            (activityHideApprovals) => updateSectionPrefs({ activityHideApprovals }),
          )}
        </>
      )}

      <WalletSettingsRow />
    </SheetScreen>
  );
}
