import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { NetworkGrid, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { closeSheet, SheetScreen } from '@/components/wallet/Sheet';
import { TokenList } from '@/components/wallet/TokenList';
import { tap } from '@/lib/haptics';
import { CHAINS } from '@/lib/mock-wallet';
import { pickToken, type TokenRef, useSwap } from '@/lib/swap';
import { makeStyles, useTheme } from '@/theme';

/** Token picker for Swap: search with a network filter over the token list. */
export default function TokenPickerSheet() {
  const styles = useStyles();
  const c = useTheme();
  const { side = 'sell' } = useLocalSearchParams<{ side?: 'sell' | 'buy' }>();
  const { network } = useSwap();
  const [query, setQuery] = useState('');

  const choose = (token: TokenRef) => {
    tap();
    pickToken(side, token);
    closeSheet();
  };

  const search = (
    <SearchField
      value={query}
      onChangeText={setQuery}
      placeholder="Search tokens"
      style={styles.search}
      trailing={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Network: ${network ?? 'All networks'}`}
          hitSlop={8}
          scaleTo={0.97}
          onPress={() => {
            tap();
            router.push('/network-picker');
          }}
          style={styles.networkButton}
        >
          {network ? (
            <TokenIcon symbol={CHAINS.find((x) => x.name === network)?.symbol ?? ''} size={20} />
          ) : (
            <NetworkGrid size={20} />
          )}
          <Icon name="chevronDown" size={12} color={c.textSecondary} />
        </PressableScale>
      }
    />
  );

  return (
    <SheetScreen scroll sticky={search}>
      {/* TokenList skeletons itself while balances load. */}
      <TokenList query={query} onChoose={choose} />
    </SheetScreen>
  );
}

const useStyles = makeStyles(() => ({
  search: {
    marginBottom: 12,
  },
  networkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
}));
