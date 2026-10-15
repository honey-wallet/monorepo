// Illustrations for the Perps guide, in the same style as Predict's: each piece rises
// into place (riseIn, strong ease-out) with the most important one first and the back
// pieces a beat behind, so the scene builds by importance.
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { G, Line, Rect } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { riseIn } from '@/components/wallet/Guide';
import { MarketIcon } from '@/components/wallet/MarketIcon';
import { Sparkline } from '@/components/wallet/parts';
import { formatPrice, formatUsd, series } from '@/lib/mock-wallet';
import { candles, liquidationPrice, type PerpMarket, perpMarket } from '@/lib/perps';
import { makeStyles, useTheme } from '@/theme';

const EXAMPLE_MARGIN = 500;
const EXAMPLE_LEVERAGE = 5;

const pick = (symbols: string[]) =>
  symbols.map((s) => perpMarket(s)).filter((m): m is PerpMarket => !!m);

/** Step 1: a few markets with trend lines, one picked. */
export function PickPerpArt() {
  const styles = useStyles();
  const markets = pick(['BTC', 'GOLD', 'NVDA']);
  return (
    <View style={styles.scene}>
      <Animated.View entering={riseIn(40)} style={[styles.card, styles.list]}>
        {markets.map((m, i) => (
          <MiniRow key={m.symbol} market={m} picked={i === 0} />
        ))}
      </Animated.View>
    </View>
  );
}

function MiniRow({ market, picked }: { market: PerpMarket; picked: boolean }) {
  const styles = useStyles();
  const trend = useMemo(
    () => series(`perp-${market.symbol}`, '1D', market.price, market.change),
    [market],
  );
  return (
    <View style={[styles.miniRow, picked && styles.picked]}>
      <MarketIcon market={market} size={32} />
      <Text style={[styles.symbol, styles.flex]}>{market.symbol}</Text>
      <Text style={styles.badge}>{market.maxLeverage}x</Text>
      <Sparkline data={trend} width={56} height={24} />
    </View>
  );
}

/** Step 2: a short candle chart with a Long ticket in front of a Short one. */
export function LongShortArt() {
  const styles = useStyles();
  const c = useTheme();
  const btc = perpMarket('BTC');
  const data = useMemo(() => (btc ? candles(btc, '1D', 14) : []), [btc]);
  const w = 260;
  const h = 120;
  const max = Math.max(...data.map((d) => d.high));
  const min = Math.min(...data.map((d) => d.low));
  const y = (v: number) => 8 + (1 - (v - min) / (max - min || 1)) * (h - 16);
  const slot = w / Math.max(data.length, 1);
  return (
    <View style={styles.scene}>
      <Animated.View entering={riseIn(0)} style={[styles.card, styles.chart]}>
        <Svg width={w} height={h}>
          {data.map((d, i) => {
            const x = i * slot + slot / 2;
            const color = d.close >= d.open ? c.success : c.error;
            const top = y(Math.max(d.open, d.close));
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: candles are positional.
              <G key={i}>
                <Line x1={x} x2={x} y1={y(d.high)} y2={y(d.low)} stroke={color} />
                <Rect
                  x={x - slot * 0.3}
                  y={top}
                  width={slot * 0.6}
                  height={Math.max(y(Math.min(d.open, d.close)) - top, 1)}
                  rx={1}
                  fill={color}
                />
              </G>
            );
          })}
        </Svg>
      </Animated.View>
      <View style={styles.tickets}>
        <Animated.View entering={riseIn(140)} style={[styles.ticket, styles.long]}>
          <Icon name="trendUp" size={18} color={c.success} />
          <Text style={[styles.ticketLabel, { color: c.success }]}>Long 5x</Text>
        </Animated.View>
        <Animated.View entering={riseIn(220)} style={[styles.ticket, styles.short]}>
          <Icon name="trendDown" size={18} color={c.error} />
          <Text style={[styles.ticketLabel, { color: c.error }]}>Short</Text>
        </Animated.View>
      </View>
    </View>
  );
}

/** Step 3: an open position in profit, its liquidation price, and a close button. */
export function ClosePositionArt() {
  const styles = useStyles();
  const c = useTheme();
  const btc = perpMarket('BTC');
  if (!btc) return null;
  // A live example: $500 at 5x on the side that's in profit on today's move.
  const side = btc.change >= 0 ? 'Long' : 'Short';
  const pnl = (EXAMPLE_MARGIN * EXAMPLE_LEVERAGE * Math.abs(btc.change)) / 100;
  return (
    <View style={styles.scene}>
      <Animated.View entering={riseIn(40)} style={[styles.card, styles.position]}>
        <View style={styles.positionHead}>
          <MarketIcon market={btc} size={30} />
          <Text style={[styles.symbol, styles.flex]}>
            BTC {side} · {EXAMPLE_LEVERAGE}x
          </Text>
          <Text style={styles.badge}>Open</Text>
        </View>
        <Text style={styles.pnl}>+{formatUsd(pnl)}</Text>
        <Text style={styles.pnlSub}>
          +{((pnl / EXAMPLE_MARGIN) * 100).toFixed(1)}% on ${EXAMPLE_MARGIN} margin
        </Text>
        <View style={styles.liq}>
          <Icon name="warning" size={14} color={c.textSecondary} />
          <Text style={[styles.liqText, styles.flex]}>Liquidation price</Text>
          <Text style={styles.liqValue}>
            {formatPrice(liquidationPrice(btc.price, EXAMPLE_LEVERAGE, side))}
          </Text>
        </View>
        <View style={styles.close}>
          <Text style={styles.closeLabel}>Close position</Text>
        </View>
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  scene: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.divider,
    backgroundColor: c.raised,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
  },
  list: {
    width: 290,
    padding: 8,
    gap: 4,
    transform: [{ rotate: '-3deg' }],
  },
  miniRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 12,
  },
  picked: {
    backgroundColor: c.divider,
  },
  symbol: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    overflow: 'hidden',
    color: c.accentText,
    backgroundColor: c.accentSurface,
    fontSize: 12,
    fontWeight: '600',
  },
  chart: {
    padding: 14,
    transform: [{ rotate: '-3deg' }],
  },
  tickets: {
    marginTop: -22,
    flexDirection: 'row',
    gap: 12,
  },
  ticket: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 14,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  long: {
    borderColor: c.success,
    backgroundColor: c.raised,
    transform: [{ rotate: '-5deg' }],
  },
  short: {
    borderColor: c.error,
    backgroundColor: c.raised,
    transform: [{ rotate: '4deg' }],
  },
  ticketLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  position: {
    width: 270,
    padding: 16,
    transform: [{ rotate: '-3deg' }],
  },
  positionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pnl: {
    marginTop: 14,
    color: c.success,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.8,
  },
  pnlSub: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  liq: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liqText: {
    color: c.textSecondary,
    fontSize: 14,
  },
  liqValue: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
  close: {
    marginTop: 14,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  closeLabel: {
    color: c.onPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
}));
