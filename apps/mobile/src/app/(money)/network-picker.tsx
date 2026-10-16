import { useState } from 'react';
import { closeSheet, SheetRow, SheetScreen, SheetSection } from '@/components/sheets/Sheet';
import { EmptyState, NetworkGrid, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { tap } from '@/lib/haptics';
import { CHAINS, type Chain, HELD_CHAINS } from '@/lib/mock-wallet';
import { updateSwap, useSwap } from '@/lib/swap';
import { makeStyles } from '@/theme';

/** Network filter for the token picker, after Uniswap's: all, yours, then the rest. */
export default function NetworkPickerSheet() {
  const styles = useStyles();
  const { network } = useSwap();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = CHAINS.filter((chain) => !q || chain.name.toLowerCase().includes(q));
  const yours = shown.filter((chain) => HELD_CHAINS.has(chain.name));
  const others = shown.filter((chain) => !HELD_CHAINS.has(chain.name));

  const choose = (next: Chain | null) => {
    tap();
    updateSwap({ network: next });
    closeSheet();
  };

  const row = (chain: (typeof CHAINS)[number]) => (
    <SheetRow
      key={chain.name}
      leading={<TokenIcon symbol={chain.symbol} size={30} />}
      title={chain.name}
      accessory="check"
      selected={network === chain.name}
      onPress={() => choose(chain.name)}
    />
  );

  return (
    <SheetScreen
      scroll
      sticky={
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search networks"
          style={styles.search}
        />
      }
    >
      {!q && (
        <SheetRow
          leading={<NetworkGrid size={30} />}
          title="All networks"
          accessory="check"
          selected={network === null}
          onPress={() => choose(null)}
        />
      )}
      {yours.length > 0 && <SheetSection title="Your networks" />}
      {yours.map(row)}
      {others.length > 0 && <SheetSection title="Other networks" />}
      {others.map(row)}
      {shown.length === 0 && (
        <EmptyState
          icon="search"
          title="No networks found"
          hint="Try another name."
          action={{ label: 'Clear search', onPress: () => setQuery('') }}
        />
      )}
    </SheetScreen>
  );
}

const useStyles = makeStyles(() => ({
  search: {
    marginBottom: 8,
  },
}));
