import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { Chip } from '@/components/wallet/Chip';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { SheetRow, SheetSection } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import {
  type Chain,
  formatAmount,
  formatUsd,
  HOLDINGS,
  MARKET,
  marketOf,
  tokenName,
} from '@/lib/mock-wallet';
import { useSigner } from '@/lib/multisig';
import { type TokenRef, updateSwap, useSwap } from '@/lib/swap';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, LAYOUT_MOVE } from '@/theme/motion';

const POPULAR = ['USDC', 'USDT', 'ETH', 'BTC', 'SOL'];

/**
 * The token picker's list, after Uniswap's: a tip that bridging is built in, quick
 * picks, your balances by network, then other tokens, filtered by `query` and Swap's
 * network filter. With `sending`, only what you hold, one row per network (Send uses
 * it as a page inside its own sheet).
 */
export function TokenList({
  query,
  sending = false,
  holdings,
  onChoose,
}: {
  query: string;
  sending?: boolean;
  /** What you hold; a shared wallet passes its own. */
  holdings?: { symbol: string; chain: Chain; amount: number; usd: number }[];
  onChoose: (token: TokenRef) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const swapState = useSwap();
  // A shared wallet lists its own balances, and only tokens on its network.
  const { multisig } = useSigner();
  const owned = holdings ?? multisig?.holdings ?? HOLDINGS;
  const network = multisig ? (multisig.network.name as Chain) : sending ? null : swapState.network;
  const { bridgeTipDismissed } = swapState;

  const q = query.trim().toLowerCase();
  const matches = (symbol: string, chain: Chain) =>
    (!network || chain === network) &&
    (!q || symbol.toLowerCase().includes(q) || tokenName(symbol).toLowerCase().includes(q));

  const yours = owned.filter((h) => (!sending || h.amount > 0) && matches(h.symbol, h.chain));
  // You can only send what you hold, so Send skips the wider market.
  const others = sending
    ? []
    : MARKET.filter(
        (t) =>
          matches(t.symbol, t.chain) &&
          !owned.some((h) => h.symbol === t.symbol && h.chain === t.chain),
      );
  // Quick picks: for Send, the popular tokens you hold, on the network you hold most on.
  const quick = POPULAR.map((symbol) => ({
    symbol,
    chain: sending
      ? yours.find((h) => h.symbol === symbol)?.chain
      : (marketOf(symbol)?.chain ?? 'Ethereum'),
  })).filter((t): t is TokenRef => !!t.chain && (!network || t.chain === network));

  return (
    <>
      {!sending && !bridgeTipDismissed && !q && (
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
            scaleTo={0.97}
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
        {!q && quick.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipScroll}
            contentContainerStyle={styles.chips}
          >
            {quick.map(({ symbol, chain }) => (
              <Chip
                key={symbol}
                label={symbol}
                accessibilityLabel={`${symbol} on ${chain}`}
                leading={<TokenIcon symbol={symbol} chain={chain} size={24} />}
                onPress={() => onChoose({ symbol, chain })}
              />
            ))}
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
                onPress={() => onChoose({ symbol: h.symbol, chain: h.chain })}
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
                onPress={() => onChoose({ symbol: t.symbol, chain: t.chain })}
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
    </>
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
