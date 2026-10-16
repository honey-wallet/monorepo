import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Share, Text, useWindowDimensions, View } from 'react-native';
import { Accordion } from '@/components/motion/Accordion';
import { LikeButton } from '@/components/motion/LikeButton';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import {
  SkeletonBar,
  SkeletonChart,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { ActionFooter } from '@/components/wallet/ActionFooter';
import { CandleChart } from '@/components/wallet/CandleChart';
import { ChartStyleButton } from '@/components/wallet/ChartStyleButton';
import { Description } from '@/components/wallet/Description';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { MarketIcon } from '@/components/wallet/MarketIcon';
import { PerpPositionCard } from '@/components/wallet/PerpPositionCard';
import { PriceChart } from '@/components/wallet/PriceChart';
import { Change, EmptyState, PushedScreen } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import {
  formatCompactUsd,
  formatPrice,
  RANGE_LABEL,
  RANGES,
  type Range,
  series,
} from '@/lib/mock-wallet';
import { candles, perpMarket, toggleSavedPerp, usePerpPositions, useSavedPerps } from '@/lib/perps';
import { useTradeModeAllowed } from '@/lib/trade-modes';
import { makeStyles, useTheme } from '@/theme';

const CHART_HEIGHT = 240;

/**
 * A perps market, after FOMO's token page: the price big, a line chart (or candles)
 * with its ranges, your position if you hold one, the market's numbers as tiles, and
 * Long / Short pinned at the bottom.
 */
function PerpScreen() {
  const { symbol = 'BTC' } = useLocalSearchParams<{ symbol: string }>();
  const { width } = useWindowDimensions();
  const styles = useStyles();
  const _c = useTheme();
  const market = perpMarket(symbol);
  const positions = usePerpPositions().filter((p) => p.symbol === symbol);
  const saved = useSavedPerps();

  const [range, setRange] = useState<Range>('1D');
  const [kind, setKind] = useState<'line' | 'candles'>('line');
  const [scrub, setScrub] = useState<number | null>(null);
  const loading = useFirstLoad(LOADS.perp(symbol));
  // Your open positions are read with the rest of your trades.
  const positionsLoading = useFirstLoad(LOADS.trades);

  const line = useMemo(
    () => (market ? series(`perp-${market.symbol}`, range, market.price, market.change) : []),
    [market, range],
  );
  const bars = useMemo(() => (market ? candles(market, range) : []), [market, range]);

  if (!market) {
    return (
      <PushedScreen title={symbol} fallback="/trade" contentStyle={styles.gutter}>
        <EmptyState
          icon="warning"
          title="Market not found"
          hint={`Honey doesn't offer a ${symbol} perpetual yet.`}
          action={{ label: 'Browse markets', onPress: () => router.navigate('/trade') }}
        />
      </PushedScreen>
    );
  }

  const candle = kind === 'candles' && scrub !== null ? bars[scrub] : null;
  const shown =
    scrub === null ? market.price : kind === 'line' ? line[scrub] : (candle?.close ?? market.price);
  const first = kind === 'line' ? line[0] : bars[0].open;
  const change = ((shown - first) / first) * 100;
  const order = (side: 'Long' | 'Short') => {
    tap();
    router.push({ pathname: '/perp-order', params: { symbol, side } });
  };
  const flipChart = () => {
    setScrub(null);
    setKind((k) => (k === 'line' ? 'candles' : 'line'));
  };

  return (
    <PushedScreen
      fallback="/trade"
      title={
        <>
          <MarketIcon market={market} size={20} />
          <Text style={styles.headerSymbol}>{symbol}</Text>
        </>
      }
      right={
        <View style={styles.headerActions}>
          <HeaderShortcut
            icon="share"
            label={`Share ${market.name}`}
            onPress={() =>
              Share.share({
                message: `${market.name} ${formatPrice(market.price)}, up to ${market.maxLeverage}x on Honey`,
              }).catch(() => {})
            }
          />
          <LikeButton
            liked={saved.includes(symbol)}
            onToggle={() => toggleSavedPerp(symbol)}
            size={22}
          />
        </View>
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
      {/* Price; while scrubbing, the value under the finger */}
      <View style={styles.gutter}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>{market.name}</Text>
          <Text style={styles.badge}>{market.maxLeverage}x</Text>
        </View>
        {scrub === null ? (
          <NumberPopIn value={formatPrice(shown)} style={styles.price} />
        ) : (
          <Text style={styles.price}>{formatPrice(shown)}</Text>
        )}
        <View style={styles.changeRow}>
          <Change value={change} />
          <TextSwap
            text={
              candle
                ? `O ${formatPrice(candle.open)}  H ${formatPrice(candle.high)}  L ${formatPrice(candle.low)}`
                : scrub === null
                  ? RANGE_LABEL[range]
                  : ''
            }
            style={[styles.flex, styles.changeLabel]}
          />
          {/* Line or candles, at the end of the line above the chart */}
          <ChartStyleButton
            to={kind === 'line' ? 'candles' : 'line'}
            label={kind === 'line' ? 'Show candles' : 'Show line'}
            onPress={flipChart}
          />
        </View>
      </View>

      <SkeletonReveal loading={loading} skeleton={<SkeletonChart height={CHART_HEIGHT} />}>
        {kind === 'line' ? (
          <PriceChart data={line} width={width} height={CHART_HEIGHT} onScrub={setScrub} />
        ) : (
          <CandleChart data={bars} width={width} height={CHART_HEIGHT} onScrub={setScrub} />
        )}
      </SkeletonReveal>
      <View style={styles.ranges}>
        <SegmentedTabs bare options={RANGES} value={range} onChange={setRange} />
      </View>

      {/* Your position, when you hold one */}
      {/* Opens in once trades load, rather than popping in and shoving the tiles down. */}
      <Accordion open={positions.length > 0 && !positionsLoading}>
        <View style={[styles.section, styles.gutter]}>
          <Text style={styles.heading}>Your position</Text>
          <View style={styles.positions}>
            {positions.map((p) => (
              <PerpPositionCard key={p.id} position={p} />
            ))}
          </View>
        </View>
      </Accordion>

      {/* The market's numbers, as four tiles */}
      <View style={[styles.section, styles.gutter]}>
        <Text style={styles.heading}>Market</Text>
        <View style={styles.grid}>
          <Tile
            label="24h volume"
            value={formatCompactUsd(market.volume)}
            loading={loading}
            right
            bottom
          />
          <Tile
            label="Open interest"
            value={formatCompactUsd(market.openInterest)}
            loading={loading}
            bottom
          />
          <Tile
            label="Funding (1h)"
            value={`${market.funding.toFixed(4)}%`}
            hint={market.funding >= 0 ? 'Longs pay shorts' : 'Shorts pay longs'}
            loading={loading}
            right
          />
          <Tile label="Max leverage" value={`${market.maxLeverage}x`} />
        </View>
      </View>

      <View style={[styles.section, styles.gutter]}>
        <Description
          title={`About ${market.name} perps`}
          text={`A perpetual tracks the price of ${market.name} with no expiry date. You put up margin, choose leverage and gain or lose as the price moves: go long if you think it will rise, short if you think it will fall. If it moves too far against you, the position closes at its liquidation price and the margin is lost. Funding is paid every hour between longs and shorts to keep the price in line with ${market.name}'s.`}
        />
      </View>
    </PushedScreen>
  );
}

function Tile({
  label,
  value,
  hint,
  right,
  bottom,
  loading = false,
}: {
  label: string;
  value: string;
  hint?: string;
  right?: boolean;
  bottom?: boolean;
  /** The label stays; the value (and hint) wait as bars of the same height. */
  loading?: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.tile, right && styles.tileRight, bottom && styles.tileBottom]}>
      <Text style={styles.tileLabel}>{label}</Text>
      <SkeletonReveal
        loading={loading}
        skeleton={
          <View>
            <View style={styles.tileValueSkeleton}>
              <SkeletonBar width={72} height={16} />
            </View>
            {hint ? (
              <View style={styles.tileHintSkeleton}>
                <SkeletonBar width={96} height={10} />
              </View>
            ) : null}
          </View>
        }
      >
        <Text style={styles.tileValue}>{value}</Text>
        {hint ? <Text style={styles.tileHint}>{hint}</Text> : null}
      </SkeletonReveal>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  gutter: {
    paddingHorizontal: 20,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  headerSymbol: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  nameRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  name: {
    color: c.textSecondary,
    fontSize: 15,
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
  ranges: {
    marginTop: 8,
    paddingHorizontal: 12,
  },
  section: {
    marginTop: 28,
  },
  heading: {
    marginBottom: 10,
    color: c.textSecondary,
    fontSize: 15,
  },
  positions: {
    gap: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: c.card,
  },
  tile: {
    width: '50%',
    padding: 16,
    gap: 4,
  },
  // The page's colour between tiles, so one grey card reads as four.
  tileRight: {
    borderRightWidth: 2,
    borderColor: c.canvas,
  },
  tileBottom: {
    borderBottomWidth: 2,
    borderColor: c.canvas,
  },
  tileLabel: {
    color: c.textSecondary,
    fontSize: 14,
  },
  tileValue: {
    color: c.text,
    fontSize: 19,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  tileHint: {
    color: c.textSecondary,
    fontSize: 12,
  },
  // Same line boxes as the value (19pt) and hint (12pt) text, so the tiles keep their height.
  tileValueSkeleton: {
    height: 23,
    justifyContent: 'center',
  },
  tileHintSkeleton: {
    height: 15,
    justifyContent: 'center',
  },
}));

/** Shared wallets can't use this product (see `lib/trade-modes.ts`); links land on Trade. */
export default function PerpScreenRoute() {
  return useTradeModeAllowed('Perps') ? <PerpScreen /> : <Redirect href="/trade" />;
}
