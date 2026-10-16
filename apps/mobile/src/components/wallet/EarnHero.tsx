// Your earning positions over time, in one place (after Aave's balance over its growth
// curve): from when you started, to today, to what they could be in ten years. The
// past is a solid line; the projection is dashed, since it's an estimate. At rest the
// dot sits on today and the value updates in place as interest lands each second.
// Drag along the curve and the dot follows the finger 1:1 (no easing, so it never
// lags), the number becoming the value at that month or year with a light tick on each
// step; let go and the dot eases back to today (ease-in-out, it's moving on screen).
// The past draws itself on the first view this session (stroke-dashoffset, 600ms,
// strong ease-out: a rare moment), the projection fades in after it, and the dot steps
// a little way ahead and back once, to show it can be dragged. Under Reduce
// Motion it's drawn from the start and the dot jumps back.
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { PillButton } from '@/components/onboarding/PillButton';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

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
}: {
  /** Today's value, interest included. */
  now: number;
  apy: number;
  startedMonthsAgo: number;
  /** The page's hero (Savings): centred, with the screen's one big number, as Aave does. */
  large?: boolean;
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
  const past = startedMonthsAgo / 12;
  const today = width * PAST_SHARE;
  // The curve's shape is the same at any balance, so it's drawn from the growth ratio:
  // value(t) = now × (1 + rate)^t, t in years from today.
  const lo = (1 + rate) ** -past;
  const hi = (1 + rate) ** AHEAD;

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
    if (!width) return;
    x.value = today;
    if (draw.value < 1) {
      draw.value = withTiming(1, { duration: 600, easing: EASE.smoothOut });
      drawn = true;
      // Once, to explain it can be dragged: the dot steps a little way ahead and back.
      if (!reduceMotion) {
        const move = { duration: DURATION.verySlow, easing: EASE.inOut };
        x.value = withDelay(
          700,
          withSequence(withTiming(today + (width - today) * 0.16, move), withTiming(today, move)),
        );
      }
    }
  }, [width, today, x, draw, reduceMotion]);

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
  const shown = valueAt(at);
  const label =
    at === 0
      ? `Growing ${apy.toFixed(1)}% a year`
      : at < 0
        ? monthLabel(-at)
        : `In ${at} ${at === 1 ? 'year' : 'years'}`;
  const sub =
    at > 0
      ? `+${formatUsd(shown - now)} in interest`
      : `+${formatUsd(shown - start)} since ${monthLabel(startedMonthsAgo)}`;

  return (
    <View style={styles.hero}>
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
        <Text style={styles.gain}>{sub}</Text>
      </View>

      <GestureDetector gesture={scrub}>
        <View
          style={[styles.chart, { height: H, marginHorizontal: -bleed }]}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        >
          {width ? (
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
      <View style={styles.axis}>
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
