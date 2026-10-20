import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
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
import { Chip } from '@/components/wallet/Chip';
import { NetworkGrid, TokenIcon } from '@/components/wallet/parts';
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
// const NETWORKS = ['All', ...CHAINS.map((chain) => chain.symbol)];
/** Network chips wrap onto a second line rather than scroll sideways in a tray. */
const NETWORK_CHIPS = { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } as const;

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
          <SheetField
            label="Sort tokens by"
            hint={isWeb ? undefined : 'How Top tokens is ordered when Search opens.'}
          >
            {/* review: pills, like the network ones below and Search's own.
            <OptionChips
              options={SORTS.map((s) => s.label)}
              value={SORTS.find((s) => s.value === prefs.searchSort)?.label ?? 'Volume'}
              onChange={(label) =>
                updateSectionPrefs({
                  searchSort: SORTS.find((s) => s.label === label)?.value ?? 'volume',
                })
              }
            /> */}
            <View style={NETWORK_CHIPS}>
              {SORTS.map((sort) => (
                <Chip
                  key={sort.value}
                  label={sort.label}
                  accessibilityRole="radio"
                  selected={prefs.searchSort === sort.value}
                  onPress={() => updateSectionPrefs({ searchSort: sort.value })}
                />
              ))}
            </View>
          </SheetField>
          <SheetField
            label="Network"
            hint={isWeb ? undefined : 'Search starts filtered to this network.'}
          >
            {/* review: the same network chips as Search itself, logo and name.
            <OptionChips
              options={NETWORKS}
              icon={(symbol) => (symbol === 'All' ? null : <TokenIcon symbol={symbol} size={14} />)}
              value={CHAINS.find((chain) => chain.name === prefs.searchNetwork)?.symbol ?? 'All'}
              onChange={(symbol) =>
                updateSectionPrefs({
                  searchNetwork: CHAINS.find((chain) => chain.symbol === symbol)?.name ?? null,
                })
              }
            /> */}
            <View style={NETWORK_CHIPS}>
              <Chip
                label="All"
                accessibilityRole="radio"
                leading={<NetworkGrid size={22} />}
                selected={!prefs.searchNetwork}
                onPress={() => updateSectionPrefs({ searchNetwork: null })}
              />
              {CHAINS.map((chain) => (
                <Chip
                  key={chain.name}
                  label={chain.name}
                  accessibilityRole="radio"
                  leading={<TokenIcon symbol={chain.symbol} size={22} />}
                  selected={prefs.searchNetwork === chain.name}
                  onPress={() => updateSectionPrefs({ searchNetwork: chain.name })}
                />
              ))}
            </View>
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
