import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { IconName } from '@/components/Icon';
import { MenuDropdown } from '@/components/motion/MenuDropdown';
import { PageDots } from '@/components/motion/PageDots';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { LivePerpPrices } from '@/components/trade/LivePerpPrices';
import { MarketIcon } from '@/components/trade/MarketIcon';
import { PerpPositionCard } from '@/components/trade/PerpPositionCard';
import { Chip } from '@/components/wallet/Chip';
import { IntroBanner } from '@/components/wallet/IntroBanner';
import { Change, EmptyState, Sparkline } from '@/components/wallet/parts';
import { openGuide, useGuideOnFirstVisit } from '@/lib/guides';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { formatCompactUsd, formatPrice, series } from '@/lib/mock-wallet';
import {
  dismissPerpsIntro,
  PERP_CATEGORIES,
  PERP_MARKETS,
  PERP_SORTS,
  type PerpMarket,
  type PerpSort,
  usePerpPositions,
  usePerpsUi,
  useSavedPerps,
} from '@/lib/perps';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

type Category = (typeof PERP_CATEGORIES)[number] | 'Saved';

const SORT_ICON: Record<PerpSort, IconName> = {
  volume: 'chart',
  openInterest: 'layers',
  gainers: 'trendUp',
  losers: 'trendDown',
  leverage: 'sparkles',
};

/**
 * Perps on the Trade tab, after Uniswap's: category filters, a one-time intro, and
 * every market by volume. Tapping a market opens its page, where Long/Short live.
 */
function DemoPerpsMarkets({
  query = '',
  onClearQuery,
}: {
  query?: string;
  /** Empties the search field, offered when a search finds nothing. */
  onClearQuery?: () => void;
}) {
  const styles = useStyles();
  const loading = useFirstLoad(LOADS.perpsMarkets);
  const { introDismissed } = usePerpsUi();
  const [picked, setCategory] = useState<Category>('All');
  // Saved appears as a filter once you've hearted a market; emptied, it falls back to All.
  const saved = useSavedPerps();
  const category = picked === 'Saved' && !saved.length ? 'All' : picked;
  const filters: Category[] = saved.length
    ? ['All', 'Saved', ...PERP_CATEGORIES.slice(1)]
    : PERP_CATEGORIES;
  const [sort, setSort] = useState<PerpSort>('volume');
  const [featuredPage, setFeaturedPage] = useState(0);
  const order = PERP_SORTS.find((o) => o.value === sort) ?? PERP_SORTS[0];
  const q = query.trim().toLowerCase();
  const markets = PERP_MARKETS.filter(
    (m) =>
      (category === 'All' ||
        (category === 'Saved' ? saved.includes(m.symbol) : m.category === category)) &&
      (!q || m.symbol.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
  ).sort(order.compare);
  useGuideOnFirstVisit('perps');
  const positions = usePerpPositions();

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chips}
      >
        {filters.map((option) => (
          <Chip
            key={option}
            label={option}
            accessibilityRole="radio"
            selected={option === category}
            onPress={() => setCategory(option)}
          />
        ))}
      </ScrollView>

      {/* The intro is for newcomers: once you hold a position it has done its job. */}
      {!introDismissed && positions.length === 0 && (
        <IntroBanner
          graphic={<LongShortGraphic />}
          title="Go long or short"
          body="Trade crypto, stocks and commodities with up to 50x leverage."
          link="How perps work"
          onOpen={() => openGuide('perps')}
          onDismiss={dismissPerpsIntro}
        />
      )}

      {/* Your open positions first, as FOMO leads with them */}
      {positions.length ? (
        <View style={styles.section}>
          <Text style={styles.heading}>Your positions</Text>
          <View style={styles.positions}>
            {positions.map((p) => (
              <PerpPositionCard key={p.id} position={p} compact />
            ))}
          </View>
        </View>
      ) : null}

      {/* A few big markets as cards, after Polymarket's Featured row */}
      {category === 'All' && !q ? (
        <View style={styles.section}>
          {/* Dots on the right say the row scrolls sideways (review: it wasn't obvious). */}
          <View style={styles.featuredHeader}>
            <Text style={styles.heading}>Featured</Text>
            <PageDots count={FEATURED.length - 1} index={featuredPage} />
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={32}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              const max = Math.max(1, contentSize.width - layoutMeasurement.width);
              setFeaturedPage(Math.round((contentOffset.x / max) * (FEATURED.length - 2)));
            }}
            style={styles.chipScroll}
            contentContainerStyle={styles.featured}
          >
            {FEATURED.map((symbol) => {
              if (loading) return <FeaturedSkeleton key={symbol} />;
              const market = PERP_MARKETS.find((m) => m.symbol === symbol);
              return market ? <FeaturedCard key={symbol} market={market} /> : null;
            })}
          </ScrollView>
        </View>
      ) : null}

      <View style={styles.listHeader}>
        <Text style={styles.heading}>
          {loading ? 'Markets' : `${markets.length} ${markets.length === 1 ? 'market' : 'markets'}`}
        </Text>
        <MenuDropdown
          options={PERP_SORTS.map(({ value, label }) => ({
            value,
            label,
            icon: SORT_ICON[value],
          }))}
          value={sort}
          onChange={setSort}
          triggerLabel={order.short}
        />
      </View>

      <View>
        <SkeletonReveal
          loading={loading}
          skeleton={[0, 1, 2, 3, 4, 5].map((i) => <MarketRowSkeleton key={i} />)}
        >
          {markets.map((market) => (
            <MarketRow key={market.symbol} market={market} />
          ))}
          {markets.length === 0 &&
            (q ? (
              <EmptyState
                icon="search"
                title="No markets match"
                hint="Try another name or ticker."
                action={onClearQuery && { label: 'Clear search', onPress: onClearQuery }}
              />
            ) : (
              <EmptyState
                icon="trade"
                title={`No ${category.toLowerCase()} markets`}
                hint="Nothing is listed here yet."
                action={{ label: 'Show all markets', onPress: () => setCategory('All') }}
              />
            ))}
        </SkeletonReveal>
      </View>
    </View>
  );
}

/** The markets shown as Featured cards. */
const FEATURED = ['BTC', 'SPX', 'NVDA', 'GOLD'];

/** A market as a card: name, a day's trend, price and the leverage on offer. */
function FeaturedCard({ market }: { market: PerpMarket }) {
  const styles = useStyles();
  const trend = useMemo(
    () => series(`perp-${market.symbol}`, '1D', market.price, market.change),
    [market],
  );
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${market.name}, ${formatPrice(market.price)}`}
      scaleTo={0.98}
      onPress={() => {
        tap();
        router.push({ pathname: '/perp/[symbol]', params: { symbol: market.symbol } });
      }}
      style={styles.feature}
    >
      <View style={styles.featureHead}>
        <MarketIcon market={market} size={32} />
        <View style={styles.flex}>
          <Text style={styles.symbol}>{market.symbol}</Text>
          <Text style={styles.featureName} numberOfLines={1}>
            {market.name}
          </Text>
        </View>
      </View>
      <View style={styles.featureChart}>
        <Sparkline data={trend} width={FEATURE_WIDTH - 28} height={44} />
      </View>
      <View style={styles.featureFoot}>
        <View style={styles.flex}>
          <Text style={styles.featurePrice}>{formatPrice(market.price)}</Text>
          <Change value={market.change} size={13} />
        </View>
        <Text style={styles.badge}>{market.maxLeverage}x</Text>
      </View>
    </PressableScale>
  );
}

function MarketRow({ market }: { market: PerpMarket }) {
  const styles = useStyles();
  // A quiet 1D trend, styled like the home screen's balance sparkline.
  const trend = useMemo(
    () => series(`perp-${market.symbol}`, '1D', market.price, market.change),
    [market],
  );
  return (
    <PressableRow
      accessibilityRole="button"
      accessibilityLabel={`${market.name}, up to ${market.maxLeverage}x, ${formatPrice(market.price)}`}
      onPress={() => {
        tap();
        router.push({ pathname: '/perp/[symbol]', params: { symbol: market.symbol } });
      }}
      style={styles.row}
    >
      <MarketIcon market={market} size={44} />
      <View style={styles.flex}>
        <View style={styles.titleRow}>
          <Text style={styles.symbol}>{market.symbol}</Text>
          <Text style={styles.badge}>{market.maxLeverage}x</Text>
        </View>
        <Text style={styles.meta}>{formatCompactUsd(market.volume)} Vol</Text>
      </View>
      <Sparkline data={trend} width={56} height={28} />
      <View style={styles.end}>
        <Text style={styles.price}>{formatPrice(market.price)}</Text>
        <Change value={market.change} />
      </View>
    </PressableRow>
  );
}

/** A Featured card's footprint while prices load. */
function FeaturedSkeleton() {
  const styles = useStyles();
  return (
    <View style={styles.feature}>
      <View style={styles.featureHead}>
        <SkeletonBar width={32} height={32} radius={16} />
        <View style={styles.skeletonLines}>
          <SkeletonBar width={40} height={15} />
          <SkeletonBar width="70%" height={11} />
        </View>
      </View>
      <View style={styles.featureChart}>
        <SkeletonBar width="100%" height={44} radius={10} />
      </View>
      <View style={styles.skeletonLines}>
        <SkeletonBar width={84} height={16} />
        <SkeletonBar width={48} height={11} />
      </View>
    </View>
  );
}

/** A market row's footprint (icon, name, sparkline, price) while prices load. */
function MarketRowSkeleton() {
  const styles = useStyles();
  return (
    <View style={[styles.row, styles.skeletonRow]}>
      <SkeletonBar width={44} height={44} radius={22} />
      <View style={styles.skeletonLines}>
        <SkeletonBar width={64} height={15} />
        <SkeletonBar width={84} height={12} />
      </View>
      <SkeletonBar width={56} height={20} />
      <View style={styles.skeletonEnd}>
        <SkeletonBar width={68} height={14} />
        <SkeletonBar width={44} height={12} />
      </View>
    </View>
  );
}

/** A rising green line crossing a falling red one: long or short. */
function LongShortGraphic() {
  const c = useTheme();
  return (
    <Svg width={40} height={40} viewBox="0 0 40 40">
      <Path
        d="M4 30 C 14 30, 18 10, 34 8 M28 5 L34 8 L30 13"
        stroke={c.success}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M4 10 C 14 10, 18 30, 34 32 M30 27 L34 32 L28 35"
        stroke={c.error}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

const FEATURE_WIDTH = 176;

const useStyles = makeStyles((c) => ({
  section: {
    marginTop: 18,
  },
  positions: {
    marginTop: 8,
    gap: 8,
  },
  featured: {
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  feature: {
    width: FEATURE_WIDTH,
    padding: 14,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  featureHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  featureName: {
    color: c.textSecondary,
    fontSize: 13,
  },
  featureChart: {
    marginTop: 12,
    marginBottom: 10,
  },
  featureFoot: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  featurePrice: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  listHeader: {
    marginTop: 16,
    marginBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heading: {
    color: c.textSecondary,
    fontSize: 15,
  },
  featuredHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  flex: {
    flex: 1,
  },
  chipScroll: {
    marginHorizontal: -18,
  },
  chips: {
    gap: 8,
    paddingHorizontal: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    // Bleed past the tab screen's gutter so the press highlight runs edge to edge.
    marginHorizontal: -18,
    paddingHorizontal: 18,
  },
  // Placeholders aren't pressable, so they stay inside the gutter.
  skeletonRow: {
    marginHorizontal: 0,
    paddingHorizontal: 0,
  },
  skeletonLines: {
    flex: 1,
    gap: 7,
  },
  skeletonEnd: {
    alignItems: 'flex-end',
    gap: 8,
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
    color: c.accentText,
    backgroundColor: c.accentSurface,
    fontSize: 12,
    fontWeight: '600',
  },
  meta: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  end: {
    alignItems: 'flex-end',
    gap: 2,
  },
  price: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
}));

export function PerpsMarkets(props: { query?: string; onClearQuery?: () => void }) {
  const wallet = useActiveWallet();
  return wallet.demo ? <DemoPerpsMarkets {...props} /> : <LivePerpPrices query={props.query} />;
}
