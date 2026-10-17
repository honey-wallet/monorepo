import { useEffect, useMemo } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Path, Pattern, Rect, Stop } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * The line draws itself in on a strong ease-out whenever the data changes. Charts open
 * and change range often, so it stays short; under Reduce Motion it fades in instead.
 */
const DRAW_DURATION = DURATION.medium;
const PAD_Y = 12;
/** Room on the right so the end dot's pulse isn't clipped. */
const PAD_RIGHT = 10;

type Props = {
  data: number[];
  width: number;
  height: number;
  /** Called with the index under the finger while scrubbing, then null on release. */
  onScrub?: (index: number | null) => void;
};

/**
 * Price chart after Uniswap: the line draws itself in, the end dot pulses, and
 * dragging a finger along it scrubs through the values.
 */
export function PriceChart(props: Props) {
  // A line needs two points; a new token or an empty range has fewer.
  if (props.data.length < 2) return <ChartEmpty height={props.height} />;
  return <PriceLine {...props} />;
}

/**
 * A chart's footprint when there's no history to draw: a quiet baseline and one line
 * saying so, at the chart's height so the page doesn't move.
 */
export function ChartEmpty({
  height,
  text = 'No price history yet',
}: {
  height: number;
  text?: string;
}) {
  const styles = useEmptyStyles();
  return (
    <View style={[styles.empty, { height }]} accessibilityLabel={text}>
      <View style={styles.baseline} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const useEmptyStyles = makeStyles((c) => ({
  empty: {
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  baseline: {
    height: 2,
    borderRadius: 1,
    backgroundColor: c.raised,
  },
  emptyText: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    marginTop: 10,
    textAlign: 'center',
    color: c.textSecondary,
    fontSize: 14,
  },
}));

function PriceLine({ data, width, height, onScrub }: Props) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const color = data[data.length - 1] < data[0] ? c.error : c.success;
  const plotWidth = width - PAD_RIGHT;

  const { line, area, points, length } = useMemo(() => {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const pts = data.map((v, i) => ({
      x: (i / (data.length - 1)) * plotWidth,
      y: PAD_Y + (1 - (v - min) / span) * (height - PAD_Y * 2),
    }));
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return {
      line: d,
      area: `${d} L${plotWidth} ${height} L0 ${height} Z`,
      points: pts,
      length: len,
    };
  }, [data, plotWidth, height]);

  // Draw in whenever the data changes (first load, or a new range).
  const drawn = useSharedValue(0);
  const shown = useSharedValue(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `line` is the trigger; a new line replays the draw-in.
  useEffect(() => {
    if (reduceMotion) {
      // No travel along the line: show it whole and fade it in.
      drawn.value = 1;
      shown.value = 0;
      shown.value = withTiming(1, {
        duration: DURATION.fast,
        easing: EASE.ease,
        reduceMotion: ReduceMotion.Never,
      });
      return;
    }
    shown.value = 1;
    drawn.value = 0;
    drawn.value = withTiming(1, { duration: DRAW_DURATION, easing: EASE.smoothOut });
  }, [line, reduceMotion, drawn, shown]);

  const lineProps = useAnimatedProps(() => ({
    strokeDashoffset: length * (1 - drawn.value),
    strokeOpacity: shown.value,
  }));
  const areaStyle = useAnimatedStyle(() => ({ opacity: drawn.value * shown.value }));

  // Pulse on the last point, like a live price.
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 0 }),
      ),
      -1,
    );
    return () => cancelAnimation(pulse);
  }, [reduceMotion, pulse]);

  // Scrubbing
  const scrubX = useSharedValue(-1);
  const scrubbing = useSharedValue(0);
  const xs = useMemo(() => points.map((p) => p.x), [points]);
  const ys = useMemo(() => points.map((p) => p.y), [points]);
  const scrubIndex = useDerivedValue(() => {
    if (scrubX.value < 0) return -1;
    return Math.round(
      (Math.min(Math.max(scrubX.value, 0), plotWidth) / plotWidth) * (xs.length - 1),
    );
  });

  const report = (i: number | null) => onScrub?.(i);
  const gesture = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      scrubX.value = e.x;
      scrubbing.value = 1;
      scheduleOnRN(tap);
    })
    .onUpdate((e) => {
      scrubX.value = e.x;
    })
    .onFinalize(() => {
      // Hide before resetting the index, so the cursor never flashes at point zero.
      scrubbing.value = 0;
      scrubX.value = -1;
      scheduleOnRN(report, null);
    });

  // Tell the header which point is under the finger, only when it changes.
  useAnimatedReaction(
    () => scrubIndex.value,
    (index, previous) => {
      if (index >= 0 && index !== previous) scheduleOnRN(report, index);
    },
  );

  const cursorStyle = useAnimatedStyle(() => {
    const i = Math.max(scrubIndex.value, 0);
    return {
      opacity: scrubbing.value,
      transform: [{ translateX: xs[i] ?? 0 }],
    };
  });
  const scrubDotStyle = useAnimatedStyle(() => {
    const i = Math.max(scrubIndex.value, 0);
    return {
      opacity: scrubbing.value,
      transform: [{ translateX: (xs[i] ?? 0) - 6 }, { translateY: (ys[i] ?? 0) - 6 }],
    };
  });
  const last = points[points.length - 1];
  const endDotStyle = useAnimatedStyle(() => ({
    opacity: drawn.value * (1 - scrubbing.value),
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: (1 - pulse.value) * 0.5 * drawn.value * (1 - scrubbing.value),
    transform: [{ scale: 1 + pulse.value * 1.6 }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height }}>
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity={0.22} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </LinearGradient>
            <Pattern id="chart-dots" width={22} height={22} patternUnits="userSpaceOnUse">
              <Circle cx={1} cy={1} r={0.9} fill={c.divider} />
            </Pattern>
          </Defs>
          <Rect width={width} height={height} fill="url(#chart-dots)" />
        </Svg>

        <Animated.View style={[{ position: 'absolute', top: 0, left: 0 }, areaStyle]}>
          <Svg width={width} height={height}>
            <Path d={area} fill="url(#chart-fill)" />
          </Svg>
        </Animated.View>

        <Svg width={width} height={height} style={{ position: 'absolute', top: 0, left: 0 }}>
          <AnimatedPath
            d={line}
            stroke={color}
            strokeWidth={1.8}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill="none"
            strokeDasharray={[length, length]}
            animatedProps={lineProps}
          />
        </Svg>

        {/* Live end dot with a pulsing ring */}
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: last.x - 4,
              top: last.y - 4,
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: color,
            },
            endDotStyle,
          ]}
        >
          <Animated.View
            style={[
              {
                position: 'absolute',
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: color,
              },
              ringStyle,
            ]}
          />
        </Animated.View>

        {/* Scrub cursor */}
        <Animated.View
          pointerEvents="none"
          style={[
            { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: c.textSecondary },
            cursorStyle,
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              top: 0,
              left: 0,
              width: 12,
              height: 12,
              borderRadius: 6,
              backgroundColor: color,
              borderWidth: 2,
              borderColor: c.canvas,
            },
            scrubDotStyle,
          ]}
        />
      </View>
    </GestureDetector>
  );
}
