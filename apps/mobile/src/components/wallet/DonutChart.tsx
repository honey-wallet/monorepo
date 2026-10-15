// Ring sectors with even 3px gaps (parallel edges, the same width from inner to outer
// edge) and 2px rounded corners. When the values change, every segment eases from its
// old share to its new one in place: an on-screen change, so ease-in-out, 300ms. The
// blend runs on the UI thread and starts from wherever the chart is, so a quick second
// change carries on smoothly. Snaps under Reduce Motion.
import { type ReactNode, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  type SharedValue,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { DURATION, EASE } from '@/theme/motion';

const MORPH = { duration: DURATION.slow, easing: EASE.inOut };
const GAP = 3;
const CORNER = 2;

export type DonutSegment = { id: string; value: number; color: string };

/**
 * One ring sector from angle a0 to a1 (clockwise from the top), inset by the corner
 * radius (the round-joined stroke adds it back) and by half the gap measured straight
 * across, so both gap edges stay parallel.
 */
function ringPath(cx: number, cy: number, ro: number, ri: number, a0: number, a1: number) {
  'worklet';
  const Ro = ro - CORNER;
  const Ri = ri + CORNER;
  const h = GAP / 2 + CORNER;
  if (Ro <= Ri) return '';
  const dO = Math.asin(Math.min(1, h / Ro));
  const dI = Math.asin(Math.min(1, h / Ri));
  const o0 = a0 + dO;
  const o1 = a1 - dO;
  const i0 = a0 + dI;
  const i1 = a1 - dI;
  if (i1 - i0 <= 0 || o1 - o0 <= 0) return ''; // too small to draw
  const pt = (r: number, a: number) =>
    `${(cx + r * Math.sin(a)).toFixed(3)} ${(cy - r * Math.cos(a)).toFixed(3)}`;
  const lo = o1 - o0 > Math.PI ? 1 : 0;
  const li = i1 - i0 > Math.PI ? 1 : 0;
  return `M${pt(Ro, o0)}A${Ro} ${Ro} 0 ${lo} 1 ${pt(Ro, o1)}L${pt(Ri, i1)}A${Ri} ${Ri} 0 ${li} 0 ${pt(Ri, i0)}Z`;
}

/**
 * A donut of shares, e.g. holdings by token. Keep the same segment ids across data
 * changes (use 0 for a missing one) so each segment morphs rather than reappearing.
 * `children` sits in the middle, e.g. the total.
 */
export function DonutChart({
  segments,
  size = 140,
  thickness = 14,
  children,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  children?: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const target = segments.map((s) => s.value);
  const key = target.join(',');
  // The morph runs on the UI thread: `progress` blends `from` into `to`, so no React
  // render happens per frame.
  const from = useSharedValue(target);
  const to = useSharedValue(target);
  const progress = useSharedValue(1);

  useEffect(() => {
    const next = key.split(',').map(Number);
    // Start from wherever the chart is now, so a change mid-morph doesn't jump.
    const e = progress.value;
    const current = from.value.map((f, k) => f + ((to.value[k] ?? f) - f) * e);
    if (reduceMotion || current.length !== next.length) {
      from.value = next;
      to.value = next;
      progress.value = 1;
      return;
    }
    from.value = current;
    to.value = next;
    progress.value = 0;
    progress.value = withTiming(1, MORPH);
  }, [key, reduceMotion, from, to, progress]);

  const c = size / 2;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        {segments.map((s, k) => (
          <Segment
            key={s.id}
            index={k}
            color={s.color}
            center={c}
            inner={c - thickness}
            from={from}
            to={to}
            progress={progress}
          />
        ))}
      </Svg>
      <View style={styles.center}>{children}</View>
    </View>
  );
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** A bare move: draws nothing. */
const EMPTY = 'M0 0';

/** Sector `index` of the shares part-way (`e`) between `from` and `to`. */
function sectorAt(
  from: number[],
  to: number[],
  e: number,
  index: number,
  center: number,
  inner: number,
) {
  'worklet';
  const values = from.map((f, k) => f + ((to[k] ?? f) - f) * e);
  const total = values.reduce((a, b) => a + b, 0) || 1;
  let start = 0;
  for (let k = 0; k < index; k++) start += (values[k] / total) * Math.PI * 2;
  const span = ((values[index] ?? 0) / total) * Math.PI * 2;
  return ringPath(center, center, center, inner, start, start + span) || EMPTY;
}

/** One sector, recomputed on the UI thread as the shares blend. */
function Segment({
  index,
  color,
  center,
  inner,
  from,
  to,
  progress,
}: {
  index: number;
  color: string;
  center: number;
  inner: number;
  from: SharedValue<number[]>;
  to: SharedValue<number[]>;
  progress: SharedValue<number>;
}) {
  const props = useAnimatedProps(() => {
    // An exception on the UI thread is fatal in React Native, so a frame that can't be
    // computed (e.g. while the shares are being swapped in) draws nothing instead.
    try {
      return { d: sectorAt(from.value, to.value, progress.value, index, center, inner) };
    } catch {
      return { d: EMPTY };
    }
  });

  return (
    <AnimatedPath
      animatedProps={props}
      fill={color}
      stroke={color}
      strokeWidth={CORNER * 2}
      strokeLinejoin="round"
    />
  );
}

const styles = StyleSheet.create({
  center: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
