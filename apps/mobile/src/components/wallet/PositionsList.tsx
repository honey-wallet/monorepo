// Earning (Savings' hero and positions) and open trades (each Trade product), kept as
// quiet as the Tokens list. Earning: growth
// over time (EarnHero), one suggestion you can swipe away (SwipeDismiss), then plain
// rows (icon, name, protocol and rate; value and what it has earned). Trading: value
// and profit or loss, which pop in as prices tick (NumberPopIn), then the trades. Tapping a row opens its details in
// place (Accordion: the height eases on the snappy ease-out while the details fade;
// one open at a time). Motion only where it explains something:
// - Interest accrues every second, so the earned amount rolls forward digit by digit
//   (SpinningCounter).
// - A liquidity position's price marker eases along its range (ease-in-out, it's
//   moving on screen) as the price ticks.
// - A loan's health bar grows to its level when it opens (strong ease-out).
// - Claim morphs its label in place, "Claim" → "Claiming" → "Claimed" (TextMorph),
//   the icon swapping to a check, and the earned amount rolls to zero.
// Under Reduce Motion the bars and marker jump and everything only fades.
import { type Href, router } from 'expo-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/Icon';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { IconSwap } from '@/components/motion/IconSwap';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import {
  SkeletonBar,
  SkeletonList,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { SpinningCounter } from '@/components/motion/SpinningCounter';
import { SwipeDismiss } from '@/components/motion/SwipeDismiss';
import { TextMorph } from '@/components/motion/TextMorph';
import { EarnHero } from '@/components/wallet/EarnHero';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { POSITIONS, type Position, TRADES, type TradePosition } from '@/lib/collectibles';
import { success, tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { EARN, formatUsd, TOKENS } from '@/lib/mock-wallet';
import { showToast } from '@/lib/toast';
import { useTradeModes } from '@/lib/trade-modes';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

/** How often an open pool's price ticks. */
const TICK = 2500;
/** Demo only: interest at real rates is far too slow to see move. */
const DEMO_SPEED = 400;
const perSecond = (p: Position) => (p.usd * p.apy) / 100 / (365 * 24 * 3600);

/** Stable, so the interest timer below isn't restarted on every render. */
const NO_POSITIONS: Position[] = [];

/** Home's Earning tab: growth over time, one suggestion, then the positions. */
export function EarningList({
  large,
  saved,
  middle,
}: {
  /** As Savings' hero: the big centred number over the curve. */
  large?: boolean;
  /** Money in jars, counted in the total (it earns too). */
  saved?: { usd: number; apy: number };
  /** Shown between the suggestion and the positions, e.g. Savings' jars. */
  middle?: ReactNode;
}) {
  const styles = useStyles();
  const c = useTheme();
  const [tip, setTip] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const loading = useFirstLoad(LOADS.positions);
  // A wallet that's never had money in it isn't earning anything yet.
  const { empty } = useWalletView();
  const positions = empty ? NO_POSITIONS : POSITIONS;
  const [earned, setEarned] = useState(() =>
    Object.fromEntries(positions.map((p) => [p.id, p.earned])),
  );

  // Interest every second.
  useEffect(() => {
    const id = setInterval(() => {
      setEarned((e) => {
        const next = { ...e };
        for (const p of positions) next[p.id] = (next[p.id] ?? 0) + perSecond(p) * DEMO_SPEED;
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [positions]);

  const inJars = saved?.usd ?? 0;
  const principal = positions.reduce((s, p) => s + p.usd, 0) + inJars;
  const rewards = positions.length === 0 ? 0 : Object.values(earned).reduce((s, v) => s + v, 0);
  const apy =
    (positions.reduce((s, p) => s + p.usd * p.apy, 0) + inJars * (saved?.apy ?? 0)) /
    (principal || 1);

  return (
    <View>
      <EarnHero
        now={principal + rewards}
        apy={apy}
        startedMonthsAgo={STARTED_MONTHS_AGO}
        large={large}
        loading={loading}
      />

      {/* One suggestion at a time: the token sitting idle that could be earning. */}
      {IDLE_USDC > 0 && !large && !empty ? (
        <Accordion open={tip}>
          <SwipeDismiss onDismiss={() => setTip(false)}>
            {(dismiss) => (
              <View style={styles.tip}>
                <TokenIcon symbol="USDC" size={36} />
                <View style={styles.flex}>
                  <Text style={styles.title}>Add {IDLE_USDC} USDC</Text>
                  <Text style={styles.tipSub}>Earn {USDC_APY}% a year on it</Text>
                </View>
                <PressableScale
                  accessibilityRole="button"
                  onPress={() => {
                    tap();
                    router.push({ pathname: '/earn/[symbol]', params: { symbol: 'USDC' } });
                  }}
                  style={[styles.pill, styles.pillPrimary]}
                >
                  <Text style={[styles.pillLabel, styles.pillPrimaryLabel]}>Add</Text>
                </PressableScale>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss"
                  hitSlop={10}
                  onPress={() => {
                    tap();
                    dismiss();
                  }}
                >
                  <Icon name="close" size={12} color={c.textSecondary} />
                </PressableScale>
              </View>
            )}
          </SwipeDismiss>
        </Accordion>
      ) : null}

      {middle}

      {large ? <Text style={styles.listTitle}>Positions</Text> : null}
      <SkeletonReveal
        loading={loading}
        skeleton={<SkeletonList count={Math.max(positions.length, 2)} />}
      >
        {positions.map((p) => (
          <Row
            key={p.id}
            position={p}
            earned={earned[p.id] ?? 0}
            onClaimed={() => setEarned((e) => ({ ...e, [p.id]: 0 }))}
            open={openId === p.id}
            onToggle={() => {
              tap();
              setOpenId((id) => (id === p.id ? null : p.id));
            }}
          />
        ))}
        {positions.length === 0 && large ? (
          <EmptyState
            compact
            icon="sparkles"
            title="Nothing earning yet"
            hint="Put idle tokens to work. No lockup, withdraw anytime."
            action={{
              label: 'Start earning',
              onPress: () =>
                router.push({ pathname: '/earn/[symbol]', params: { symbol: 'USDC' } }),
            }}
          />
        ) : null}
      </SkeletonReveal>
    </View>
  );
}

/** Whether Home shows its Trades tab: only with open trades in products that are on. */
export function useHasTrades() {
  const modes = useTradeModes();
  return TRADES.some((t) => modes.includes(t.mode));
}

/**
 * Home's Trades tab: one quiet line with the total and its profit or loss, then each
 * open trade (no second big number: Home's balance is the one).
 */
export function TradesList() {
  const styles = useStyles();
  const c = useTheme();
  const modes = useTradeModes();
  const trades = TRADES.filter((t) => modes.includes(t.mode));
  const [pnl, setPnl] = useState(() => Object.fromEntries(TRADES.map((t) => [t.id, t.pnl])));
  // Open trades move with the market.
  useEffect(() => {
    const id = setInterval(() => {
      setPnl((all) => {
        const next = { ...all };
        for (const t of TRADES)
          next[t.id] = (next[t.id] ?? 0) + (Math.random() - 0.5) * t.usd * 0.01;
        return next;
      });
    }, TRADE_TICK);
    return () => clearInterval(id);
  }, []);
  const value = trades.reduce((s, t) => s + t.usd + (pnl[t.id] ?? 0), 0);
  const total = trades.reduce((s, t) => s + (pnl[t.id] ?? 0), 0);
  const color = total >= 0 ? c.success : c.error;
  const loading = useFirstLoad(LOADS.trades);
  if (!loading && trades.length === 0) {
    return (
      <EmptyState
        compact
        icon="trade"
        title="No open trades"
        hint="Perps and predictions you open show up here."
        action={{ label: 'Explore markets', onPress: () => router.navigate('/trade') }}
      />
    );
  }
  return (
    <SkeletonReveal loading={loading} skeleton={<TradesSkeleton count={trades.length || 2} />}>
      {/* Two figures side by side, as Aave's stat card: what's in, and how it's doing. */}
      <View style={styles.summaryCard}>
        <View style={styles.flex}>
          <Text style={styles.summaryLabel}>
            {trades.length} open {trades.length === 1 ? 'trade' : 'trades'}
          </Text>
          <NumberPopIn value={formatUsd(value)} style={styles.summaryValue} />
        </View>
        <View style={styles.summaryDivider} />
        <View style={[styles.flex, styles.summaryEnd]}>
          <Text style={styles.summaryLabel}>Unrealized</Text>
          <View style={styles.inline}>
            <Text style={[styles.summaryValue, { color }]}>{total >= 0 ? '+' : '−'}</Text>
            <NumberPopIn
              value={formatUsd(Math.abs(total))}
              style={[styles.summaryValue, { color }]}
            />
          </View>
        </View>
      </View>
      {trades.map((t) => (
        <TradeRow key={t.id} trade={t} pnl={pnl[t.id] ?? 0} />
      ))}
    </SkeletonReveal>
  );
}

/** The summary card and trade rows while positions load. */
function TradesSkeleton({ count }: { count: number }) {
  const styles = useStyles();
  return (
    <View>
      <View style={styles.summaryCard}>
        <View style={[styles.flex, styles.skeletonFigure]}>
          <SkeletonBar width={84} height={12} />
          <SkeletonBar width={96} height={20} />
        </View>
        <View style={styles.summaryDivider} />
        <View style={[styles.flex, styles.summaryEnd, styles.skeletonFigure]}>
          <SkeletonBar width={72} height={12} />
          <SkeletonBar width={80} height={20} />
        </View>
      </View>
      <SkeletonList count={count} />
    </View>
  );
}

const TRADE_TICK = 3000;

/** Demo: when the first of these positions was opened. */
const STARTED_MONTHS_AGO = 14;
const PRODUCT_ICON: Record<TradePosition['mode'], IconName> = {
  Perps: 'trade',
  Predict: 'predict',
  Futures: 'clock',
  Options: 'target',
};

const IDLE_USDC = TOKENS.find((t) => t.symbol === 'USDC')?.amount ?? 0;
const USDC_APY = EARN.find((e) => e.symbol === 'USDC')?.apy ?? 0;

function TradeRow({ trade: t, pnl }: { trade: TradePosition; pnl: number }) {
  const styles = useStyles();
  const c = useTheme();
  const up = pnl >= 0;
  const color = up ? c.success : c.error;
  return (
    <PressableRow
      onPress={() => {
        tap();
        router.push(t.href as Href);
      }}
      style={styles.row}
    >
      {/* The asset, with a badge for the product, so an ETH future doesn't read as ETH. */}
      <View style={styles.icon}>
        {t.symbol ? (
          <TokenIcon symbol={t.symbol} />
        ) : (
          <View style={styles.predictIcon}>
            <Icon name="predict" size={18} color={c.text} />
          </View>
        )}
        {t.symbol ? (
          <View style={styles.productBadge}>
            <Icon name={PRODUCT_ICON[t.mode]} size={9} color={c.accentText} />
          </View>
        ) : null}
      </View>
      <View style={styles.flex}>
        <Text style={styles.title} numberOfLines={1}>
          {t.title}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {t.mode} · {t.detail}
        </Text>
      </View>
      <View style={styles.end}>
        {/* Each change pops in (the course's number change), so a tick is noticed. */}
        <NumberPopIn value={formatUsd(t.usd + pnl)} style={styles.title} />
        <View style={styles.inline}>
          <Text style={[styles.pnl, { color }]}>{up ? '+' : '−'}</Text>
          <NumberPopIn value={formatUsd(Math.abs(pnl))} style={[styles.pnl, { color }]} />
        </View>
      </View>
    </PressableRow>
  );
}

function Row({
  position: p,
  earned,
  onClaimed,
  open,
  onToggle,
}: {
  position: Position;
  earned: number;
  onClaimed: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const [claim, setClaim] = useState<'idle' | 'claiming' | 'claimed'>('idle');
  const [price, setPrice] = useState(p.range?.price ?? 0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The pool price moves while you're looking.
  useEffect(() => {
    if (!open || !p.range) return;
    const { min, max } = p.range;
    const id = setInterval(() => {
      setPrice((v) => Math.min(max - 20, Math.max(min + 20, v + (Math.random() - 0.5) * 60)));
    }, TICK);
    return () => clearInterval(id);
  }, [open, p]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClaim = () => {
    if (claim !== 'idle' || earned < 0.01) return;
    tap();
    setClaim('claiming');
    timer.current = setTimeout(() => {
      success();
      setClaim('claimed');
      showToast(`Claimed ${formatUsd(earned)}`);
      onClaimed();
      timer.current = setTimeout(() => setClaim('idle'), 2200);
    }, 900);
  };

  const [main, pair] = p.symbols;

  return (
    <View>
      <PressableRow
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={styles.row}
      >
        <View style={styles.icon}>
          <TokenIcon symbol={main} />
          {pair ? (
            <View style={styles.pair}>
              <TokenIcon symbol={pair} size={18} />
            </View>
          ) : null}
        </View>
        <View style={styles.flex}>
          <Text style={styles.title}>{p.title}</Text>
          <Text style={styles.sub} numberOfLines={1}>
            {p.protocol} · {p.apy.toFixed(1)}%
          </Text>
        </View>
        <View style={styles.end}>
          <Text style={styles.title}>{formatUsd(p.usd)}</Text>
          <Text style={styles.earnedSmall}>+{formatUsd(earned)}</Text>
        </View>
        <AccordionChevron open={open} size={11} color={c.textSecondary} />
      </PressableRow>

      <Accordion open={open}>
        <View style={styles.body}>
          {p.range ? <RangeBar range={p.range} price={price} open={open} /> : null}
          {p.health ? <HealthBar health={p.health} open={open} /> : null}
          <View style={styles.earnRow}>
            <View style={styles.flex}>
              <Text style={styles.label}>Earned so far</Text>
              <View style={styles.earnedWrap}>
                <SpinningCounter value={`$${earned.toFixed(4)}`} style={styles.earned} />
              </View>
            </View>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Claim rewards"
              onPress={onClaim}
              style={styles.pill}
            >
              <IconSwap
                name={claim === 'claimed' ? 'check' : 'sparkles'}
                size={13}
                color={claim === 'claimed' ? c.success : c.text}
              />
              <TextMorph
                text={claim === 'idle' ? 'Claim' : claim === 'claiming' ? 'Claiming' : 'Claimed'}
                style={[styles.pillLabel, claim === 'claimed' && { color: c.success }]}
              />
            </PressableScale>
          </View>
        </View>
      </Accordion>
    </View>
  );
}

function RangeBar({
  range,
  price,
  open,
}: {
  range: NonNullable<Position['range']>;
  price: number;
  open: boolean;
}) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  // The track shows a little past each end of the range.
  const lo = range.min - (range.max - range.min) * 0.25;
  const hi = range.max + (range.max - range.min) * 0.25;
  const at = (v: number) => ((v - lo) / (hi - lo)) * width;
  const x = useSharedValue(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` is derived from width and range.
  useEffect(() => {
    if (!width) return;
    const target = at(price);
    x.value =
      reduceMotion || !open
        ? target
        : withTiming(target, { duration: DURATION.slow, easing: EASE.inOut });
  }, [width, price, open, reduceMotion, x]);
  const marker = useAnimatedStyle(() => ({ transform: [{ translateX: x.value - 6 }] }));
  const inRange = price >= range.min && price <= range.max;

  return (
    <View style={styles.block}>
      <View style={styles.blockHead}>
        <Text style={styles.label}>Price</Text>
        <Text style={styles.blockValue}>
          {Math.round(price).toLocaleString('en-US')} {range.unit}
        </Text>
      </View>
      <View style={styles.track} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width ? (
          <>
            <View
              style={[
                styles.rangeFill,
                { left: at(range.min), width: at(range.max) - at(range.min) },
              ]}
            />
            <Animated.View style={[styles.marker, marker]} />
          </>
        ) : null}
      </View>
      <View style={styles.blockHead}>
        <Text style={styles.small}>
          {inRange ? 'In range' : 'Out of range'} · min {range.min.toLocaleString('en-US')}
        </Text>
        <Text style={styles.small}>max {range.max.toLocaleString('en-US')}</Text>
      </View>
    </View>
  );
}

function HealthBar({ health, open }: { health: NonNullable<Position['health']>; open: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const fill = useSharedValue(0);
  // Health factors above 3 read as full; below 1 the loan can be liquidated.
  const level = Math.min(1, health.factor / 3);
  useEffect(() => {
    // Closing leaves the bar as it is while the panel fades; it refills on the next open.
    if (!open) return;
    if (reduceMotion) {
      fill.value = level;
      return;
    }
    fill.value = 0;
    fill.value = withDelay(
      DURATION.micro,
      withTiming(level, { duration: DURATION.verySlow, easing: EASE.smoothOut }),
    );
  }, [open, level, reduceMotion, fill]);
  const bar = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
  const color = health.factor >= 1.5 ? c.success : health.factor >= 1.1 ? c.primary : c.error;

  return (
    <View style={styles.block}>
      <View style={styles.blockHead}>
        <Text style={styles.label}>Health factor</Text>
        <Text style={[styles.blockValue, { color }]}>{health.factor.toFixed(2)}</Text>
      </View>
      <View style={styles.track}>
        <Animated.View
          style={[styles.healthFill, { backgroundColor: color, transformOrigin: 'left' }, bar]}
        />
      </View>
      <View style={styles.blockHead}>
        <Text style={styles.small}>Supplied {formatUsd(health.supplied)}</Text>
        <Text style={styles.small}>Borrowed {formatUsd(health.borrowed)}</Text>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  summaryCard: {
    marginTop: 2,
    marginBottom: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.card,
  },
  summaryDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginHorizontal: 14,
    backgroundColor: c.divider,
  },
  summaryEnd: {
    alignItems: 'flex-end',
  },
  skeletonFigure: {
    gap: 6,
    paddingVertical: 2,
  },
  summaryLabel: {
    color: c.textSecondary,
    fontSize: 13,
  },
  summaryValue: {
    marginTop: 2,
    color: c.text,
    fontSize: 18,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  listTitle: {
    marginTop: 8,
    paddingBottom: 4,
    color: c.textSecondary,
    fontSize: 15,
  },
  tip: {
    marginBottom: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: c.card,
  },
  tipSub: {
    marginTop: 1,
    color: c.textSecondary,
    fontSize: 14,
  },
  productBadge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: c.canvas,
    backgroundColor: c.accentSurface,
  },
  predictIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.card,
  },
  pnl: {
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  pillPrimary: {
    backgroundColor: c.accentSurface,
  },
  pillPrimaryLabel: {
    color: c.accentText,
  },
  // The same row as a token's, so the tabs read as one list.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    marginHorizontal: -18,
    paddingHorizontal: 18,
  },
  icon: {
    width: 40,
    height: 40,
  },
  pair: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: c.canvas,
  },
  title: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  sub: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 15,
  },
  end: {
    alignItems: 'flex-end',
    gap: 2,
  },
  earnedSmall: {
    color: c.success,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  // Lines up with the row's text, under the icon's edge.
  body: {
    paddingLeft: 52,
    paddingTop: 4,
    paddingBottom: 14,
    gap: 16,
  },
  block: {
    gap: 8,
  },
  blockHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    color: c.textSecondary,
    fontSize: 14,
  },
  blockValue: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  small: {
    color: c.textSecondary,
    fontSize: 12,
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: c.raised,
    justifyContent: 'center',
    overflow: 'visible',
  },
  rangeFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: 2,
    backgroundColor: c.textSecondary,
    opacity: 0.45,
  },
  marker: {
    position: 'absolute',
    left: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: c.canvas,
    backgroundColor: c.text,
  },
  healthFill: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: 2,
  },
  earnRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  earnedWrap: {
    marginTop: 2,
  },
  earned: {
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  // A small pill, like the Review and Reject ones on Notifications.
  pill: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: c.raised,
  },
  pillLabel: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
}));
