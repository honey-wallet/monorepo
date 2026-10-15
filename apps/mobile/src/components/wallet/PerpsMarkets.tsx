import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import type { IconName } from '@/components/Icon';
import { MenuDropdown } from '@/components/motion/MenuDropdown';
import { PressableRow } from '@/components/motion/PressableRow';
import { Chip } from '@/components/wallet/Chip';
import { IntroBanner } from '@/components/wallet/IntroBanner';
import { MarketIcon } from '@/components/wallet/MarketIcon';
import { Change, Sparkline } from '@/components/wallet/parts';
import { openGuide, useGuideOnFirstVisit } from '@/lib/guides';
import { tap } from '@/lib/haptics';
import { formatCompactUsd, formatPrice, series } from '@/lib/mock-wallet';
import {
  dismissPerpsIntro,
  PERP_CATEGORIES,
  PERP_MARKETS,
  PERP_SORTS,
  type PerpMarket,
  type PerpSort,
  usePerpsUi,
} from '@/lib/perps';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, LAYOUT_MOVE } from '@/theme/motion';

type Category = (typeof PERP_CATEGORIES)[number];

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
export function PerpsMarkets() {
  const styles = useStyles();
  const { introDismissed } = usePerpsUi();
  const [category, setCategory] = useState<Category>('All');
  const [sort, setSort] = useState<PerpSort>('volume');
  const order = PERP_SORTS.find((o) => o.value === sort) ?? PERP_SORTS[0];
  const markets = PERP_MARKETS.filter((m) => category === 'All' || m.category === category).sort(
    order.compare,
  );
  useGuideOnFirstVisit('perps');

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chips}
      >
        {PERP_CATEGORIES.map((option) => (
          <Chip
            key={option}
            label={option}
            accessibilityRole="radio"
            selected={option === category}
            onPress={() => setCategory(option)}
          />
        ))}
      </ScrollView>

      {!introDismissed && (
        <IntroBanner
          graphic={<LongShortGraphic />}
          title="Go long or short"
          body="Trade crypto, stocks and commodities with up to 50x leverage."
          link="How perps work"
          onOpen={() => openGuide('perps')}
          onDismiss={dismissPerpsIntro}
        />
      )}

      <Animated.View layout={LAYOUT_MOVE} style={styles.listHeader}>
        <Text style={styles.heading}>
          {markets.length} {markets.length === 1 ? 'market' : 'markets'}
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
      </Animated.View>

      <Animated.View layout={LAYOUT_MOVE}>
        {markets.map((market) => (
          <Animated.View
            key={market.symbol}
            entering={FadeIn.duration(DURATION.fast)}
            exiting={FadeOut.duration(DURATION.quick)}
            layout={LAYOUT_MOVE}
          >
            <MarketRow market={market} />
          </Animated.View>
        ))}
      </Animated.View>
    </View>
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

const useStyles = makeStyles((c) => ({
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
