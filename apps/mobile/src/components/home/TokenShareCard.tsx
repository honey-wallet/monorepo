import { forwardRef, useId, useMemo } from 'react';
import { Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import { TokenIcon } from '@/components/wallet/parts';
import { formatPrice } from '@/lib/mock-wallet';
import { makeStyles, useTheme } from '@/theme';

// The card follows the theme: a light card with a hairline edge in light mode, a raised
// one in dark, so it reads as an object in the tray rather than a hole in it.
export const SHARE_CARD_WIDTH = 320;
const CHART_HEIGHT = 140;
const PAD = 22;

/** Evens out tick-to-tick noise: a 5-point moving average, thinned to about 48 points. */
function calm(data: number[]) {
  const avg = data.map((_, i) => {
    const win = data.slice(Math.max(0, i - 2), i + 3);
    return win.reduce((a, b) => a + b, 0) / win.length;
  });
  const step = Math.max(1, Math.floor(avg.length / 48));
  const out = avg.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== avg[avg.length - 1]) out.push(avg[avg.length - 1]);
  return out;
}

/** A smooth path through the points (Catmull-Rom as cubic Béziers). */
function smoothPath(raw: number[], width: number, height: number, inset: number) {
  const data = calm(raw);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * width,
    inset + (1 - (v - min) / span) * (height - inset * 2),
  ]);
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1] ?? pts[i];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const [x3, y3] = pts[i + 2] ?? pts[i + 1];
    const c1x = x1 + (x2 - x0) / 6;
    const c1y = y1 + (y2 - y0) / 6;
    const c2x = x2 - (x3 - x1) / 6;
    const c2y = y2 - (y3 - y1) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  return d;
}

type Props = {
  symbol: string;
  name: string;
  price: number;
  /** Percentage change over `range`. */
  change: number;
  range: string;
  data: number[];
  /** Your holding; left out when amounts are hidden. */
  holding?: { amount: string; value: string };
};

/**
 * A token's price as a card to share (after Family's): logo and name, the price and
 * its move, a bold edge-to-edge line, and, if you choose, what you hold. Forwarded
 * ref is the view captured into the image.
 */
export const TokenShareCard = forwardRef<View, Props>(function TokenShareCard(
  { symbol, name, price, change, range, data, holding },
  ref,
) {
  const c = useTheme();
  const styles = useStyles();
  // React's ids contain colons, which an SVG url(#…) reference can't take.
  const fade = `fade${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const down = change < 0;
  const tone = down ? c.error : c.success;
  const line = useMemo(() => smoothPath(data, SHARE_CARD_WIDTH, CHART_HEIGHT, 6), [data]);
  // The same line closed along the bottom edge, for a soft wash of the move's colour.
  const area = `${line} L${SHARE_CARD_WIDTH} ${CHART_HEIGHT} L0 ${CHART_HEIGHT} Z`;
  return (
    <View ref={ref} collapsable={false} style={styles.card}>
      <View style={styles.top}>
        <View style={styles.iconWell}>
          <TokenIcon symbol={symbol} size={40} />
        </View>
        <HoneyLogo variant="lockup" height={20} />
      </View>
      <View style={styles.nameRow}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Icon name="verified" size={18} color={c.primary} />
      </View>
      <View style={styles.priceRow}>
        <Text style={styles.price}>{formatPrice(price)}</Text>
        <View style={styles.change}>
          <Icon name={down ? 'arrowDown' : 'arrowUp'} size={17} color={tone} />
          <Text style={[styles.changeText, { color: tone }]}>{Math.abs(change).toFixed(2)}%</Text>
        </View>
      </View>
      <Text style={styles.range}>{range}</Text>
      <Svg width={SHARE_CARD_WIDTH} height={CHART_HEIGHT} style={styles.chart}>
        <Defs>
          <LinearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={tone} stopOpacity={0.22} />
            <Stop offset="1" stopColor={tone} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Path d={area} fill={`url(#${fade})`} />
        <Path
          d={line}
          stroke={tone}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
      {holding ? (
        <View style={styles.foot}>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Balance</Text>
            <View style={styles.cellValueRow}>
              <TokenIcon symbol={symbol} size={20} />
              <Text style={styles.cellValue}>{holding.amount}</Text>
            </View>
          </View>
          <View style={styles.rule} />
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Value</Text>
            <Text style={styles.cellValue}>{holding.value}</Text>
          </View>
        </View>
      ) : (
        <Text style={styles.tagline}>Tracked with Honey</Text>
      )}
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  card: {
    width: SHARE_CARD_WIDTH,
    alignSelf: 'center',
    marginTop: 4,
    marginBottom: 12,
    overflow: 'hidden',
    paddingTop: PAD,
    paddingBottom: PAD,
    borderRadius: 28,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: c.divider,
    backgroundColor: c.scheme === 'dark' ? c.raised : c.card,
  },
  top: {
    paddingHorizontal: PAD,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  iconWell: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.sheet,
  },
  nameRow: {
    marginTop: 14,
    paddingHorizontal: PAD,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  name: {
    flexShrink: 1,
    color: c.text,
    fontSize: 24,
    fontWeight: '700',
  },
  priceRow: {
    marginTop: 2,
    paddingHorizontal: PAD,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  price: {
    color: c.text,
    fontSize: 24,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  change: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  changeText: {
    fontSize: 24,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  range: {
    marginTop: 14,
    paddingHorizontal: PAD,
    color: c.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  chart: {
    marginTop: 10,
  },
  foot: {
    marginTop: 18,
    marginHorizontal: PAD,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: c.divider,
    flexDirection: 'row',
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  cellLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  cellValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cellValue: {
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  rule: {
    width: 1,
    backgroundColor: c.divider,
  },
  tagline: {
    marginTop: 12,
    paddingHorizontal: PAD,
    color: c.textSecondary,
    fontSize: 13,
  },
}));
