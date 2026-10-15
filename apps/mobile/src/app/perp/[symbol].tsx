import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { SkeletonBar, SkeletonReveal } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { ActionFooter } from '@/components/wallet/ActionFooter';
import { CandleChart } from '@/components/wallet/CandleChart';
import { MarketIcon } from '@/components/wallet/MarketIcon';
import { Change, EmptyState, PushedScreen } from '@/components/wallet/parts';
import { StatRow } from '@/components/wallet/Sheet';
import { formatCompactUsd, formatPrice, RANGE_LABEL, RANGES, type Range } from '@/lib/mock-wallet';
import { candles, perpMarket } from '@/lib/perps';
import { makeStyles, useTheme } from '@/theme';

const CHART_HEIGHT = 230;
/** Simulated network delay, so the skeleton reveal is visible until real data exists. */
const LOAD_DELAY = 600;

/**
 * A perps market, laid out like a token page: price, candlestick chart with ranges,
 * market stats and your position, with Long and Short pinned at the bottom.
 */
export default function PerpScreen() {
  const { symbol = 'BTC' } = useLocalSearchParams<{ symbol: string }>();
  const { width } = useWindowDimensions();
  const styles = useStyles();
  const market = perpMarket(symbol);

  const [range, setRange] = useState<Range>('1D');
  const [scrub, setScrub] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), LOAD_DELAY);
    return () => clearTimeout(timer);
  }, []);

  const data = useMemo(() => (market ? candles(market, range) : []), [market, range]);

  if (!market) {
    return (
      <PushedScreen title={`${symbol}-PERP`} fallback="/trade" contentStyle={styles.gutter}>
        <EmptyState
          icon="warning"
          title="Market not found"
          hint={`Honey doesn't offer a ${symbol} perpetual yet.`}
        />
      </PushedScreen>
    );
  }

  const candle = scrub === null ? null : data[scrub];
  const shown = candle ? candle.close : market.price;
  const change = ((shown - data[0].open) / data[0].open) * 100;
  const order = (side: 'Long' | 'Short') =>
    router.push({ pathname: '/perp-order', params: { symbol, side } });

  return (
    <PushedScreen
      fallback="/trade"
      title={
        <>
          <MarketIcon market={market} size={20} />
          <Text style={styles.headerSymbol}>{symbol}-PERP</Text>
        </>
      }
      footer={
        <ActionFooter
          actions={[
            { label: 'Long', tone: 'up', onPress: () => order('Long') },
            { label: 'Short', tone: 'down', onPress: () => order('Short') },
          ]}
        />
      }
    >
      {/* Price; while scrubbing, the candle under the finger */}
      <View style={styles.gutter}>
        <Text style={styles.name}>{market.name} perpetual</Text>
        {candle ? (
          <Text style={styles.price}>{formatPrice(shown)}</Text>
        ) : (
          <NumberPopIn value={formatPrice(shown)} style={styles.price} />
        )}
        <View style={styles.changeRow}>
          <Change value={change} />
          <TextSwap
            text={
              candle
                ? `O ${formatPrice(candle.open)}  H ${formatPrice(candle.high)}  L ${formatPrice(candle.low)}`
                : RANGE_LABEL[range]
            }
            style={styles.changeLabel}
          />
        </View>
      </View>

      <SkeletonReveal
        loading={loading}
        skeleton={
          <View style={[styles.chartSkeleton, { height: CHART_HEIGHT }]}>
            <SkeletonBar width="100%" height={2} />
          </View>
        }
      >
        <CandleChart data={data} width={width} height={CHART_HEIGHT} onScrub={setScrub} />
      </SkeletonReveal>
      <View style={styles.ranges}>
        <SegmentedTabs bare options={RANGES} value={range} onChange={setRange} />
      </View>

      {/* Your position */}
      <View style={[styles.section, styles.gutter]}>
        <Text style={styles.heading}>Your position</Text>
        <EmptyState
          icon="chart"
          title="No open position"
          hint={`Go long if you think ${symbol} will rise, or short if you think it will fall.`}
        />
      </View>

      {/* Market stats */}
      <View style={[styles.section, styles.gutter]}>
        <Text style={styles.heading}>Market</Text>
        <Stat icon="trendUp" label="Max leverage" value={`${market.maxLeverage}x`} />
        <Stat icon="clock" label="Funding (1h)" value={`${market.funding.toFixed(4)}%`} />
        <Text style={styles.hint}>Positive funding: longs pay shorts every hour.</Text>
        <Stat icon="layers" label="Open interest" value={formatCompactUsd(market.openInterest)} />
        <Stat icon="chart" label="24h volume" value={formatCompactUsd(market.volume)} />
      </View>

      {/* About */}
      <View style={[styles.section, styles.gutter]}>
        <Text style={styles.heading}>About perps</Text>
        <Text style={styles.about}>
          A perpetual tracks the price of {market.name} without an expiry date. You put up margin,
          choose leverage, and gain or lose as the price moves. If it moves too far against you, the
          position is closed at the liquidation price and the margin is lost.
        </Text>
      </View>
    </PushedScreen>
  );
}

function Stat({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const c = useTheme();
  return (
    <StatRow
      icon={<Icon name={icon} size={15} color={c.textSecondary} />}
      label={label}
      value={value}
    />
  );
}

const useStyles = makeStyles((c) => ({
  gutter: {
    paddingHorizontal: 20,
  },
  headerSymbol: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  name: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 15,
  },
  price: {
    color: c.text,
    fontSize: 36,
    fontWeight: '500',
    letterSpacing: -0.6,
  },
  changeRow: {
    marginTop: 2,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  changeLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  chartSkeleton: {
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  ranges: {
    marginTop: 8,
    paddingHorizontal: 12,
  },
  section: {
    marginTop: 28,
  },
  heading: {
    marginBottom: 10,
    color: c.text,
    fontSize: 18,
    fontWeight: '500',
  },
  hint: {
    marginTop: -4,
    marginBottom: 6,
    marginLeft: 25,
    color: c.textSecondary,
    fontSize: 13,
  },
  about: {
    color: c.text,
    fontSize: 16,
    lineHeight: 23,
  },
}));
