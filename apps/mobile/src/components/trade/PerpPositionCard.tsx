import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { MarketIcon } from '@/components/trade/MarketIcon';
import { tap } from '@/lib/haptics';
import { formatPrice, formatUsd } from '@/lib/mock-wallet';
import { closePosition, type PerpPosition, perpMarket, positionStats } from '@/lib/perps';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

/**
 * An open perps position, after FOMO's position rows: the market with a "5x Long"
 * badge, the profit or loss as the big number (with return on margin), then size,
 * entry and liquidation price. `compact` is the list version (one row, tap to open);
 * the full card adds Close.
 */
export function PerpPositionCard({
  position,
  compact = false,
}: {
  position: PerpPosition;
  compact?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  const market = perpMarket(position.symbol);
  if (!market) return null;
  const { size, pnl, roe, liquidation } = positionStats(position);
  const tone = pnl < 0 ? c.error : c.success;
  const sideTone = position.side === 'Long' ? c.success : c.error;
  const signed = `${pnl < 0 ? '−' : '+'}${formatUsd(Math.abs(pnl))}`;

  const head = (
    <View style={styles.head}>
      <MarketIcon market={market} size={compact ? 40 : 36} />
      <View style={styles.flex}>
        <View style={styles.titleRow}>
          <Text style={styles.symbol}>{market.symbol}</Text>
          <Text style={[styles.badge, { color: sideTone, backgroundColor: `${sideTone}1F` }]}>
            {position.leverage}x {position.side}
          </Text>
        </View>
        <Text style={styles.meta}>{formatUsd(size)} position</Text>
      </View>
      <View style={styles.end}>
        <Text style={[styles.pnl, { color: tone }]}>{signed}</Text>
        <Text style={[styles.roe, { color: tone }]}>
          {roe < 0 ? '' : '+'}
          {roe.toFixed(2)}%
        </Text>
      </View>
    </View>
  );

  if (compact) {
    return (
      <PressableScale
        accessibilityRole="button"
        scaleTo={0.98}
        onPress={() => {
          tap();
          router.push({ pathname: '/perp/[symbol]', params: { symbol: market.symbol } });
        }}
        style={styles.card}
      >
        {head}
      </PressableScale>
    );
  }

  return (
    <View style={styles.card}>
      {head}
      <View style={styles.stats}>
        <Stat label="Entry" value={formatPrice(position.entry)} />
        <Stat label="Mark" value={formatPrice(market.price)} />
        <Stat label="Liq. price" value={formatPrice(liquidation)} />
      </View>
      <PressableScale
        accessibilityRole="button"
        scaleTo={0.97}
        onPress={() => {
          tap();
          closePosition(position.id);
          showToast('Trade executed');
        }}
        style={styles.close}
      >
        <Text style={styles.closeLabel}>Close position</Text>
      </PressableScale>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  card: {
    padding: 16,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  symbol: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    overflow: 'hidden',
    fontSize: 12,
    fontWeight: '600',
  },
  meta: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  end: {
    alignItems: 'flex-end',
    gap: 2,
  },
  pnl: {
    fontSize: 17,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  roe: {
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  stats: {
    marginTop: 16,
    flexDirection: 'row',
  },
  stat: {
    flex: 1,
    gap: 2,
  },
  statLabel: {
    color: c.textSecondary,
    fontSize: 13,
  },
  statValue: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  close: {
    marginTop: 16,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  closeLabel: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
}));
