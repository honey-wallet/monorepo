import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { Chip } from '@/components/wallet/Chip';
import { IntroBanner } from '@/components/wallet/IntroBanner';
import { TokenIcon } from '@/components/wallet/parts';
import type { Side } from '@/components/wallet/TradeForm';
import { openGuide, useGuideOnFirstVisit } from '@/lib/guides';
import { tap } from '@/lib/haptics';
import { formatCompactUsd } from '@/lib/mock-wallet';
import {
  dismissPredictIntro,
  PREDICT_CATEGORIES,
  PREDICT_MARKETS,
  type PredictMarket,
  toggleSaved,
  usePredictUi,
  useSavedMarkets,
} from '@/lib/predict';
import { formatShare, useTradePrefs } from '@/lib/trade-prefs';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, LAYOUT_MOVE } from '@/theme/motion';

/** "$41.00M" → "$41M", "$2.40M" → "$2.4M". */
const shortVolume = (n: number) => formatCompactUsd(n).replace(/\.?0+([A-Z]?)$/, '$1');

/** Opens the order sheet for one side of a market (or of one outcome). */
function order(market: PredictMarket, side: Side, outcome?: string) {
  tap();
  router.push({
    pathname: '/predict-order',
    params: { id: market.id, side, ...(outcome ? { outcome } : {}) },
  });
}

/**
 * Prediction markets, after Polymarket in Uniswap: category chips, a featured card,
 * then one card per market. Filtering moves cards with the shared layout transition.
 */
export function PredictFeed() {
  const styles = useStyles();
  const [category, setCategory] = useState<(typeof PREDICT_CATEGORIES)[number]>('All');
  const markets = PREDICT_MARKETS.filter((m) => category === 'All' || m.category === category);
  useGuideOnFirstVisit('predict');
  const { introDismissed } = usePredictUi();

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chips}
      >
        {PREDICT_CATEGORIES.map((name) => (
          <Chip
            key={name}
            label={name}
            accessibilityRole="radio"
            selected={name === category}
            onPress={() => setCategory(name)}
          />
        ))}
      </ScrollView>

      {!introDismissed && (
        <IntroBanner
          graphic={<OddsGraphic />}
          title="Bet on what happens next"
          body="Buy Yes or No on politics, sports, crypto and more. Winning shares pay $1."
          link="How Predict works"
          onOpen={() => openGuide('predict')}
          onDismiss={dismissPredictIntro}
        />
      )}

      {/* Same gap below the chips (or the banner) as between cards' groups. */}
      <View style={styles.feed}>
        {markets.map((market) => (
          <Animated.View
            key={market.id}
            entering={FadeIn.duration(DURATION.fast)}
            exiting={FadeOut.duration(DURATION.quick)}
            layout={LAYOUT_MOVE}
          >
            <MarketCard market={market} />
          </Animated.View>
        ))}
      </View>
    </View>
  );
}

/** A small odds gauge: green Yes share meeting the red No share. */
function OddsGraphic() {
  const c = useTheme();
  const r = 15;
  const at = (t: number) => {
    const angle = Math.PI * (1 - t);
    return `${(20 + r * Math.cos(angle)).toFixed(2)} ${(26 - r * Math.sin(angle)).toFixed(2)}`;
  };
  return (
    <Svg width={40} height={32} viewBox="0 0 40 32">
      <Path
        d={`M ${at(0)} A ${r} ${r} 0 0 1 ${at(0.62)}`}
        stroke={c.success}
        strokeWidth={4}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d={`M ${at(0.7)} A ${r} ${r} 0 0 1 ${at(1)}`}
        stroke={c.error}
        strokeWidth={4}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

function MarketCard({ market }: { market: PredictMarket }) {
  // Share prices follow Predict settings: 51¢ or 51%.
  const { predictPrice } = useTradePrefs();
  const price = (p: number) => formatShare(p, predictPrice);
  const styles = useStyles();
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <MarketIcon market={market} />
        <Text style={styles.question} numberOfLines={2}>
          {market.kind === 'updown' ? `${market.question} · ${market.window}` : market.question}
        </Text>
        {market.kind !== 'multi' && (
          <Gauge value={market.yes} label={market.kind === 'updown' ? 'Up' : 'Yes'} />
        )}
      </View>

      {market.kind === 'binary' && (
        <View style={styles.bigButtons}>
          <SideButton side="Yes" detail={price(market.yes)} onPress={() => order(market, 'Yes')} />
          <SideButton
            side="No"
            detail={price(1 - market.yes)}
            onPress={() => order(market, 'No')}
          />
        </View>
      )}

      {market.kind === 'updown' && (
        <View style={styles.bigButtons}>
          <SideButton side="Up" detail={price(market.yes)} onPress={() => order(market, 'Up')} />
          <SideButton
            side="Down"
            detail={price(1 - market.yes)}
            onPress={() => order(market, 'Down')}
          />
        </View>
      )}

      {market.kind === 'multi' &&
        market.outcomes.map((outcome) => (
          <View key={outcome.id} style={styles.outcome}>
            <Text style={styles.outcomeLabel} numberOfLines={1}>
              {outcome.label}
            </Text>
            <Text style={styles.outcomePct}>{Math.round(outcome.yes * 100)}%</Text>
            <SideButton small side="Yes" onPress={() => order(market, 'Yes', outcome.id)} />
            <SideButton small side="No" onPress={() => order(market, 'No', outcome.id)} />
          </View>
        ))}

      <Footer market={market} />
    </View>
  );
}

/** Coin logo for crypto markets; otherwise the market's icon on a honey-tinted square. */
function MarketIcon({ market }: { market: PredictMarket }) {
  const styles = useStyles();
  const c = useTheme();
  if (market.symbol) return <TokenIcon symbol={market.symbol} size={40} />;
  return (
    <View style={styles.iconSquare}>
      <Icon name={market.icon ?? 'predict'} size={20} color={c.accentText} />
    </View>
  );
}

/** Green for Yes/Up, red for No/Down, tinted backgrounds as in the side toggle. */
function SideButton({
  side,
  detail,
  small,
  onPress,
}: {
  side: Side;
  detail?: string;
  small?: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const up = side === 'Yes' || side === 'Up';
  const color = up ? c.success : c.error;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={detail ? `Buy ${side} at ${detail}` : `Buy ${side}`}
      scaleTo={0.96}
      onPress={onPress}
      style={[small ? styles.smallButton : styles.bigButton, { backgroundColor: `${color}26` }]}
    >
      <Text style={[small ? styles.smallLabel : styles.bigLabel, { color }]}>
        {side}
        {detail ? ` ${detail}` : ''}
      </Text>
    </PressableScale>
  );
}

/** Semicircle gauge: the Yes/Up chance as an arc, with the percentage inside. */
/** Semicircle gauge with the Yes (or Up) chance; `track` should differ from the card behind it. */
export function Gauge({ value, label, track }: { value: number; label: string; track?: string }) {
  const styles = useStyles();
  const c = useTheme();
  const size = 62;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const arc = (to: number) => {
    // From the left end (180°) clockwise over the top, `to` of the way to the right end.
    const angle = Math.PI * (1 - to);
    const x = cx + r * Math.cos(angle);
    const y = cy - r * Math.sin(angle);
    return `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
  };
  const color = value >= 0.5 ? c.success : c.error;
  return (
    <View
      style={styles.gauge}
      accessible
      accessibilityLabel={`${Math.round(value * 100)}% ${label}`}
    >
      <Svg width={size} height={size / 2 + stroke}>
        <Path
          d={arc(1)}
          stroke={track ?? c.raised}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
        />
        <Path
          d={arc(Math.min(Math.max(value, 0.001), 1))}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
        />
      </Svg>
      <Text style={styles.gaugeValue}>{Math.round(value * 100)}%</Text>
      <Text style={styles.gaugeLabel}>{label}</Text>
    </View>
  );
}

/** Volume, end date (or a pulsing LIVE dot) and the save toggle. */
function Footer({ market }: { market: PredictMarket }) {
  const styles = useStyles();
  const c = useTheme();
  const saved = useSavedMarkets().includes(market.id);
  return (
    <View style={styles.footer}>
      {market.kind === 'updown' ? <LiveBadge /> : null}
      <Text style={styles.meta}>
        {shortVolume(market.volume)} Vol.
        {market.kind === 'updown' ? '' : ` · Ends ${market.ends}`}
      </Text>
      <View style={styles.flex} />
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={saved ? 'Remove from saved' : 'Save market'}
        accessibilityState={{ selected: saved }}
        hitSlop={10}
        scaleTo={0.85}
        onPress={() => {
          tap();
          toggleSaved(market.id);
        }}
      >
        <IconSwap
          name={saved ? 'bookmarkFill' : 'bookmark'}
          size={18}
          color={saved ? c.accentText : c.textSecondary}
        />
      </PressableScale>
    </View>
  );
}

/** A red dot that pulses like a recording light, then "LIVE". */
function LiveBadge() {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) return;
    pulse.value = withRepeat(withTiming(0.25, { duration: 800 }), -1, true);
  }, [reduceMotion, pulse]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <View style={styles.live}>
      <Animated.View style={[styles.liveDot, dotStyle]} />
      <Text style={styles.liveLabel}>LIVE</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  chipScroll: {
    // Bleed past the tab screen's gutter so chips scroll edge to edge.
    marginHorizontal: -18,
  },
  feed: {
    marginTop: 16,
  },
  chips: {
    gap: 8,
    paddingHorizontal: 18,
  },
  card: {
    marginBottom: 12,
    padding: 16,
    gap: 12,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconSquare: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  question: {
    flex: 1,
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 21,
  },
  gauge: {
    width: 62,
    alignItems: 'center',
  },
  gaugeValue: {
    marginTop: -18,
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  gaugeLabel: {
    color: c.textSecondary,
    fontSize: 12,
  },
  bigButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  bigButton: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  outcome: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  outcomeLabel: {
    flex: 1,
    color: c.text,
    fontSize: 15,
  },
  outcomePct: {
    marginRight: 4,
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  smallButton: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  meta: {
    color: c.textSecondary,
    fontSize: 14,
  },
  live: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: c.error,
  },
  liveLabel: {
    color: c.error,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
}));
