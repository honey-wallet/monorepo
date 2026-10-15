import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { Chip } from '@/components/wallet/Chip';
import { EmptyState, NetworkGrid, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { closeSheet, SheetRow, SheetScreen, SheetSection } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import {
  CHAINS,
  type Chain,
  formatAmount,
  formatUsd,
  HOLDINGS,
  MARKET,
  marketOf,
  tokenName,
} from '@/lib/mock-wallet';
import { pickToken, type TokenRef, updateSwap, useSwap } from '@/lib/swap';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, LAYOUT_MOVE } from '@/theme/motion';

const POPULAR = ['USDC', 'USDT', 'ETH', 'BTC', 'SOL'];

/**
 * Token picker for Swap, after Uniswap's: search with a network filter, a tip that
 * bridging is built in, quick picks, your balances by network, then other tokens.
 */
export default function TokenPickerSheet() {
  const styles = useStyles();
  const c = useTheme();
  const { side = 'sell' } = useLocalSearchParams<{ side?: 'sell' | 'buy' }>();
  const { network, bridgeTipDismissed } = useSwap();
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const matches = (symbol: string, chain: Chain) =>
    (!network || chain === network) &&
    (!q || symbol.toLowerCase().includes(q) || tokenName(symbol).toLowerCase().includes(q));

  const yours = HOLDINGS.filter((h) => matches(h.symbol, h.chain));
  const others = MARKET.filter(
    (t) =>
      matches(t.symbol, t.chain) &&
      !HOLDINGS.some((h) => h.symbol === t.symbol && h.chain === t.chain),
  );

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
          scaleTo={0.92}
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
      {!bridgeTipDismissed && !q && (
        <Animated.View exiting={FadeOut.duration(DURATION.quick)} style={styles.tip}>
          <Icon name="trade" size={20} color={c.accentText} />
          <View style={styles.flex}>
            <Text style={styles.tipTitle}>Bridging is built in</Text>
            <Text style={styles.tipBody}>Swap any token across networks.</Text>
          </View>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={10}
            scaleTo={0.88}
            onPress={() => {
              tap();
              updateSwap({ bridgeTipDismissed: true });
            }}
          >
            <Icon name="close" size={16} color={c.textSecondary} />
          </PressableScale>
        </Animated.View>
      )}

      <Animated.View layout={LAYOUT_MOVE}>
        {!q && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipScroll}
            contentContainerStyle={styles.chips}
          >
            {POPULAR.map((symbol) => {
              const chain = marketOf(symbol)?.chain ?? 'Ethereum';
              if (network && chain !== network) return null;
              return (
                <Chip
                  key={symbol}
                  label={symbol}
                  accessibilityLabel={`${symbol} on ${chain}`}
                  leading={<TokenIcon symbol={symbol} chain={chain} size={24} />}
                  onPress={() => choose({ symbol, chain })}
                />
              );
            })}
          </ScrollView>
        )}

        {yours.length > 0 && (
          <>
            <View style={styles.sectionRow}>
              <Icon name="wallet" size={15} color={c.textSecondary} />
              <SheetSection title="Your tokens" />
            </View>
            {yours.map((h) => (
              <SheetRow
                key={`${h.symbol}-${h.chain}`}
                leading={<TokenIcon symbol={h.symbol} chain={h.chain} size={40} />}
                title={tokenName(h.symbol)}
                subtitle={`${h.symbol} · ${h.chain}`}
                accessory={
                  <View style={styles.end}>
                    <Text style={styles.endTitle}>{formatUsd(h.usd)}</Text>
                    <Text style={styles.endSub}>{formatAmount(h.amount)}</Text>
                  </View>
                }
                onPress={() => choose({ symbol: h.symbol, chain: h.chain })}
              />
            ))}
          </>
        )}

        {others.length > 0 && (
          <>
            <SheetSection title="Tokens" />
            {others.map((t) => (
              <SheetRow
                key={`${t.symbol}-${t.chain}`}
                leading={<TokenIcon symbol={t.symbol} chain={t.chain} size={40} />}
                title={t.name}
                subtitle={`${t.symbol} · ${t.chain}`}
                value={formatUsd(t.price)}
                onPress={() => choose({ symbol: t.symbol, chain: t.chain })}
              />
            ))}
          </>
        )}

        {yours.length === 0 && others.length === 0 && (
          <EmptyState
            icon="search"
            title="No tokens found"
            hint={network ? `Nothing matches on ${network}.` : 'Try another name or symbol.'}
          />
        )}
      </Animated.View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  search: {
    marginBottom: 12,
  },
  networkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    marginBottom: 12,
    borderRadius: 16,
    backgroundColor: c.accentSurface,
  },
  tipTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  tipBody: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  chipScroll: {
    marginHorizontal: -20,
  },
  chips: {
    gap: 8,
    paddingHorizontal: 20,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
  },
  end: {
    alignItems: 'flex-end',
    gap: 2,
  },
  endTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  endSub: {
    color: c.textSecondary,
    fontSize: 14,
  },
}));
