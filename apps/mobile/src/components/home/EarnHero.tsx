// Your earning positions over time, in one place (after Aave's balance over its growth
// curve): from when you started, to today, to what they could be in ten years. The
// past is a solid line; the projection is dashed, since it's an estimate. At rest the
// dot sits on today and the value updates in place as interest lands each second.
// Drag along the curve and the dot follows the finger 1:1 (no easing, so it never
// lags), the number becoming the value at that month or year with a light tick on each
// step; let go and the dot eases back to today (ease-in-out, it's moving on screen).
// The past draws itself on the first view this session (stroke-dashoffset, 600ms,
// strong ease-out: a rare moment), and the projection fades in after it. On the page
// hero, each time you come back the figure counts up from what it was when you last
// looked (900ms, ease-out: money arriving) and a green "+$5.75 since you last looked"
// rises in under it. Under Reduce Motion the chart is drawn from the start and the
// figure shows its value at once.
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  Keyframe,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { Icon } from '@/components/Icon';
import { SkeletonBar, SkeletonChart } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { makeStyles, useTheme } from '@/theme';
import { DISTANCE, DURATION, EASE, lazy } from '@/theme/motion';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const HEIGHT = 84;
const LARGE_HEIGHT = 170;
/** TabScreen's side padding, which the large chart bleeds past. */
const GUTTER = 18;
const DOT = 12;
const PAD = 8;
/** How far ahead the projection looks. */
const AHEAD = 10;
/** The past takes this share of the width, however long ago you started. */
const PAST_SHARE = 0.36;
const STEPS = 40;

let drawn = false;

/** The figure when you last left the page; null on the first look this session. */
let lastLooked: number | null = null;
/** With nothing saved yet, the demo pretends you last looked this many days ago. */
const DEMO_DAYS_AWAY = 7;
const COUNT_MS = 900;
const sinceIn = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: DISTANCE.small }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
  })
    .duration(DURATION.slow)
    .delay(300),
);

/**
 * Tracks what you've earned since you last opened the page: on focus the shown value
 * counts up from then to now; on leaving, now becomes "last looked". Without `count`
 * the value just follows `now`.
 */
function useSinceLastLooked(now: number, rate: number, count: boolean) {
  const [display, setDisplay] = useState(now);
  const [gained, setGained] = useState(0);
  const counting = useRef(false);
  const latest = useRef(now);
  latest.current = now;

  useFocusEffect(
    useCallback(() => {
      if (!count) return;
      const target = latest.current;
      const from = lastLooked ?? target * (1 + rate) ** (-DEMO_DAYS_AWAY / 365);
      setGained(target - from);
      counting.current = true;
      const start = Date.now();
      let frame = requestAnimationFrame(function step() {
        const t = Math.min(1, (Date.now() - start) / COUNT_MS);
        const eased = 1 - (1 - t) ** 3;
        setDisplay(from + (latest.current - from) * eased);
        if (t < 1) frame = requestAnimationFrame(step);
        else counting.current = false;
      });
      return () => {
        cancelAnimationFrame(frame);
        counting.current = false;
        lastLooked = latest.current;
      };
    }, [count, rate]),
  );

  // Between visits the figure just follows the interest landing each second.
  useEffect(() => {
    if (!counting.current) setDisplay(now);
  }, [now]);

  return { display: count ? display : now, gained: count ? gained : 0 };
}

const monthLabel = (monthsAgo: number) =>
  new Date(new Date().getFullYear(), new Date().getMonth() - monthsAgo, 1).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
  });

export function EarnHero({
  now,
  apy,
  startedMonthsAgo,
  large,
  loading,
}: {
  /** Today's value, interest included. */
  now: number;
  apy: number;
  startedMonthsAgo: number;
  /** The page's hero (Savings): centred, with the screen's one big number, as Aave does. */
  large?: boolean;
  /** Positions are still loading: bars stand in for the figures, a flat line for the curve. */
  loading?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  /** 0 = today; negative = months ago; positive = years ahead. */
  const [at, setAt] = useState(0);
  const draw = useSharedValue(drawn || reduceMotion ? 1 : 0);
  const x = useSharedValue(0);
  const scrubbing = useSharedValue(0);
  /** 1 only while a finger is on the chart (the guide's fade-out lags behind it). */
  const finger = useSharedValue(0);

  // The page hero gets a taller, edge-to-edge chart (Aave's), the tab version a short one.
  const H = large ? LARGE_HEIGHT : HEIGHT;
  const bleed = large ? GUTTER : 0;
  const rate = apy / 100;
  // A deposit made this month still gets a sliver of past, so the curve has a start.
  const past = Math.max(startedMonthsAgo, 0.5) / 12;
  const today = width * PAST_SHARE;
  // The curve's shape is the same at any balance, so it's drawn from the growth ratio:
  // value(t) = now × (1 + rate)^t, t in years from today.
  // A 0% rate is flat (lo = hi): span 0–2 instead so the line sits mid-chart, not NaN.
  const lo = rate > 0 ? (1 + rate) ** -past : 0;
  const hi = rate > 0 ? (1 + rate) ** AHEAD : 2;

  const { pastLine, pastArea, futureLine, pastLength } = useMemo(() => {
    if (!width) return { pastLine: '', pastArea: '', futureLine: '', pastLength: 0 };
    const point = (t: number) => {
      const px = t <= 0 ? today * (1 + t / past) : today + (width - today) * (t / AHEAD);
      const r = (1 + rate) ** t;
      return [px, H - PAD - ((r - lo) / (hi - lo)) * (H - PAD * 2)] as const;
    };
    let p = '';
    let len = 0;
    let prev: readonly [number, number] | null = null;
    for (let i = 0; i <= STEPS; i++) {
      const pt = point(-past + (past * i) / STEPS);
      p += `${i ? 'L' : 'M'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)} `;
      if (prev) len += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
      prev = pt;
    }
    let f = '';
    for (let i = 0; i <= STEPS; i++) {
      const pt = point((AHEAD * i) / STEPS);
      f += `${i ? 'L' : 'M'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)} `;
    }
    return {
      pastLine: p,
      pastArea: `${p}L${today} ${H} L0 ${H} Z`,
      futureLine: f,
      pastLength: len,
    };
  }, [width, today, past, rate, lo, hi, H]);

  useEffect(() => {
    // The curve draws itself once there's data to draw, not under the skeleton.
    if (!width || loading) return;
    x.value = today;
    if (draw.value < 1) {
      draw.value = withTiming(1, { duration: 600, easing: EASE.smoothOut });
      drawn = true;
    }
  }, [width, today, x, draw, loading]);

  // What it's grown by since you last looked, counted up each time the page is opened.
  const { display, gained } = useSinceLastLooked(now, rate, !!large && !reduceMotion);

  // Where the finger is, in whole months back or whole years ahead.
  useAnimatedReaction(
    () => {
      if (!width) return 0;
      if (x.value < today) return -Math.round(((today - x.value) / today) * startedMonthsAgo);
      return Math.round(((x.value - today) / (width - today)) * AHEAD);
    },
    (v, prev) => {
      if (prev !== null && v !== prev) scheduleOnRN(pick, v, finger.value > 0);
    },
  );
  // A tick for each step under the finger (not for the hint's own movement).
  function pick(v: number, byFinger: boolean) {
    if (byFinger && v !== 0) tap();
    setAt(v);
  }

  const still = reduceMotion;
  const scrub = Gesture.Pan()
    // Horizontal drags scrub; vertical ones fall through to the page's scroll.
    .activeOffsetX([-6, 6])
    .failOffsetY([-8, 8])
    .onStart((e) => {
      finger.value = 1;
      scrubbing.value = 1;
      x.value = Math.min(width, Math.max(0, e.x));
    })
    .onUpdate((e) => {
      x.value = Math.min(width, Math.max(0, e.x));
    })
    .onFinalize(() => {
      finger.value = 0;
      scrubbing.value = withTiming(0, { duration: DURATION.fast, easing: EASE.ease });
      x.value = still ? today : withTiming(today, { duration: DURATION.slow, easing: EASE.inOut });
    });

  const pastStroke = useAnimatedProps(() => ({
    strokeDashoffset: (1 - draw.value) * pastLength,
  }));
  const futureFade = useAnimatedProps(() => ({
    strokeOpacity: interpolate(draw.value, [0.6, 1], [0, 0.7], 'clamp'),
  }));
  const dot = useAnimatedStyle(() => {
    const t =
      x.value <= today
        ? -past * (1 - x.value / (today || 1))
        : AHEAD * ((x.value - today) / (width - today || 1));
    const r = (1 + rate) ** t;
    const y = H - PAD - ((r - lo) / (hi - lo)) * (H - PAD * 2);
    return {
      opacity: draw.value,
      transform: [{ translateX: x.value - DOT / 2 }, { translateY: y - DOT / 2 }],
    };
  });
  const guide = useAnimatedStyle(() => ({
    opacity: scrubbing.value,
    transform: [{ translateX: x.value - 0.5 }],
  }));

  const valueAt = (v: number) => now * (1 + rate) ** (v < 0 ? v / 12 : v);
  const start = now * lo;
  const shown = at === 0 ? display : valueAt(at);
  // Nothing saved or earning yet: no growth to talk about, just the way to start.
  const none = now <= 0;
  const label = none
    ? 'Your savings'
    : at === 0
      ? `Growing ${apy.toFixed(1)}% a year`
      : at < 0
        ? monthLabel(-at)
        : `In ${at} ${at === 1 ? 'year' : 'years'}`;
  const sub = none
    ? 'Add money to start earning'
    : at > 0
      ? `+${formatUsd(shown - now)} in interest`
      : `+${formatUsd(shown - start)} since ${monthLabel(startedMonthsAgo)}`;

  return (
    <View style={styles.hero}>
      {loading ? (
        // The label, figure and gain lines' boxes, so nothing moves when they arrive.
        <View style={[styles.skeletonText, large && styles.centered]}>
          <View style={styles.skeletonLine}>
            <SkeletonBar width={120} height={11} />
          </View>
          <View style={large ? styles.skeletonValueLarge : styles.skeletonValue}>
            <SkeletonBar width={large ? 200 : 110} height={large ? 40 : 18} radius={8} />
          </View>
          <View style={styles.skeletonLine}>
            <SkeletonBar width={150} height={11} />
          </View>
        </View>
      ) : (
        <View style={large && styles.centered}>
          <Text style={styles.label}>{label}</Text>
          {large ? (
            // Aave's figure: the dollars big, the cents a size down.
            <Text style={[styles.value, styles.valueLarge]}>
              {formatUsd(shown).split('.')[0]}
              <Text style={styles.centsLarge}>.{formatUsd(shown).split('.')[1]}</Text>
            </Text>
          ) : (
            <Text style={styles.value}>{formatUsd(shown)}</Text>
          )}
          {large && at === 0 && gained >= 0.01 ? (
            <Animated.View entering={sinceIn()} style={styles.since}>
              <Icon name="arrowUp" size={11} color={c.success} />
              <Text style={styles.sinceText}>{formatUsd(gained)} since you last looked</Text>
            </Animated.View>
          ) : (
            <Text style={[styles.gain, none && styles.gainNone]}>{sub}</Text>
          )}
        </View>
      )}

      <GestureDetector gesture={scrub}>
        <View
          style={[styles.chart, { height: H, marginHorizontal: -bleed }]}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        >
          {loading ? (
            <SkeletonChart height={H} inset={bleed + 4} />
          ) : width ? (
            <>
              <Svg width={width} height={H}>
                <Defs>
                  <LinearGradient id="earn-curve" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor={c.primary} stopOpacity={0.22} />
                    <Stop offset="1" stopColor={c.primary} stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Path d={pastArea} fill="url(#earn-curve)" />
                <AnimatedPath
                  d={futureLine}
                  stroke={c.primary}
                  strokeWidth={2}
                  strokeDasharray="3 5"
                  strokeLinecap="round"
                  fill="none"
                  animatedProps={futureFade}
                />
                <AnimatedPath
                  d={pastLine}
                  stroke={c.primary}
                  strokeWidth={2}
                  strokeLinecap="round"
                  fill="none"
                  strokeDasharray={pastLength}
                  animatedProps={pastStroke}
                />
              </Svg>
              <Animated.View style={[styles.guide, guide]} />
              <Animated.View style={[styles.dot, dot]} />
            </>
          ) : null}
        </View>
      </GestureDetector>

      {/* Started, today and where it could be, each under its point on the curve (the
          page hero shows just the labels; its number above already says the value). */}
      <View style={[styles.axis, loading && styles.axisLoading]}>
        <View>
          <Text style={styles.axisLabel}>{monthLabel(startedMonthsAgo)}</Text>
          {large ? null : <Text style={styles.axisValue}>{formatUsd(start)}</Text>}
        </View>
        <View style={[styles.axisToday, { left: today - 40 - bleed }]}>
          <Text style={styles.axisLabel}>Today</Text>
          {large ? null : <Text style={styles.axisValue}>{formatUsd(now)}</Text>}
        </View>
        <View style={styles.axisEnd}>
          <Text style={styles.axisLabel}>{large ? `${AHEAD}Y` : `In ${AHEAD} years`}</Text>
          {large ? null : <Text style={styles.axisValue}>{formatUsd(valueAt(AHEAD))}</Text>}
        </View>
      </View>

      {large ? <AddMoney rate={rate} /> : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  hero: {
    paddingTop: 6,
    paddingBottom: 14,
  },
  label: {
    color: c.textSecondary,
    fontSize: 14,
  },
  centered: {
    alignItems: 'center',
  },
  valueLarge: {
    marginVertical: 2,
    fontSize: 48,
    letterSpacing: -1,
  },
  centsLarge: {
    fontSize: 32,
    letterSpacing: -0.5,
  },
  // Row-sized, like Uniswap's "Your balance": Home's balance is the one big number.
  value: {
    marginTop: 2,
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  gain: {
    marginTop: 2,
    color: c.success,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  // A soft green pill: good news, set apart from the plain gain line it replaces.
  since: {
    marginTop: 6,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: `${c.success}1F`,
  },
  sinceText: {
    color: c.success,
    fontSize: 14,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  chart: {
    marginTop: 10,
  },
  guide: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 1,
    backgroundColor: c.divider,
  },
  dot: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    borderWidth: 2,
    borderColor: c.canvas,
    backgroundColor: c.primary,
  },
  axis: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  // The dates and values depend on the positions; they fade in with them.
  axisLoading: {
    opacity: 0,
  },
  gainNone: {
    color: c.textSecondary,
  },
  skeletonText: {
    gap: 2,
  },
  skeletonLine: {
    height: 17,
    justifyContent: 'center',
  },
  // 20pt and 48pt figures' line boxes, with their margins.
  skeletonValue: {
    height: 26,
    justifyContent: 'center',
  },
  skeletonValueLarge: {
    height: 62,
    justifyContent: 'center',
  },
  axisToday: {
    position: 'absolute',
    width: 80,
    alignItems: 'center',
  },
  axisEnd: {
    alignItems: 'flex-end',
  },
  axisLabel: {
    color: c.textSecondary,
    fontSize: 12,
  },
  axisValue: {
    marginTop: 1,
    color: c.text,
    fontSize: 13,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  addButton: {
    marginTop: 14,
    alignSelf: 'stretch',
  },
}));

/**
 * Add money: opens the Add to savings sheet, where you type the amount and see what
 * it could grow to at the rate this chart projects with.
 */
function AddMoney({ rate }: { rate: number }) {
  const styles = useStyles();
  return (
    <PillButton
      label="Add money"
      onPress={() => {
        tap();
        router.push({ pathname: '/savings-add', params: { rate: String(rate) } });
      }}
      style={styles.addButton}
    />
  );
}
