// Candlestick chart for perps. On a new range the candles fade and rise 10px into
// place (smooth ease-out, a little longer for more candles); dragging a finger along
// it highlights one candle and reports it, like the line chart's scrub.
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, G, Line, Pattern, Rect } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { ChartEmpty } from '@/components/charts/PriceChart';
import { tap } from '@/lib/haptics';
import type { Candle } from '@/lib/perps';
import { useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const PAD_Y = 12;
/** Extra reveal time per candle, so a dense chart doesn't snap in. */
const PER_CANDLE = 12;

type Props = {
  data: Candle[];
  width: number;
  height: number;
  /** Called with the candle under the finger while scrubbing, then null on release. */
  onScrub?: (index: number | null) => void;
};

export function CandleChart(props: Props) {
  if (props.data.length === 0) return <ChartEmpty height={props.height} />;
  return <Candles {...props} />;
}

function Candles({ data, width, height, onScrub }: Props) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const slot = width / data.length;
  const body = Math.max(2, slot * 0.62);

  const { y } = useMemo(() => {
    const max = Math.max(...data.map((d) => d.high));
    const min = Math.min(...data.map((d) => d.low));
    const span = max - min || 1;
    return { y: (v: number) => PAD_Y + (1 - (v - min) / span) * (height - PAD_Y * 2) };
  }, [data, height]);

  // Rise in whenever the data changes (first load, or a new range).
  const reveal = useSharedValue(0);
  useEffect(() => {
    reveal.value = 0;
    reveal.value = withTiming(1, {
      duration: reduceMotion ? 0 : DURATION.fast + PER_CANDLE * data.length,
      easing: EASE.smoothOut,
    });
  }, [data, reduceMotion, reveal]);
  const revealStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: [{ translateY: (1 - reveal.value) * 10 }],
  }));

  // Scrubbing
  const scrubX = useSharedValue(-1);
  const scrubbing = useSharedValue(0);
  const index = useDerivedValue(() =>
    scrubX.value < 0 ? -1 : Math.min(Math.max(Math.floor(scrubX.value / slot), 0), data.length - 1),
  );
  const report = (i: number | null) => onScrub?.(i);
  const gesture = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      scrubX.value = e.x;
      scrubbing.value = withTiming(1, { duration: DURATION.quick });
      scheduleOnRN(tap);
    })
    .onUpdate((e) => {
      scrubX.value = e.x;
    })
    .onFinalize(() => {
      scrubbing.value = withTiming(0, { duration: DURATION.fast, easing: EASE.smoothOut });
      scrubX.value = -1;
      scheduleOnRN(report, null);
    });
  useAnimatedReaction(
    () => index.value,
    (i, previous) => {
      if (i >= 0 && i !== previous) {
        scheduleOnRN(report, i);
        scheduleOnRN(tap);
      }
    },
  );
  const cursorStyle = useAnimatedStyle(() => ({
    opacity: scrubbing.value,
    transform: [{ translateX: Math.max(index.value, 0) * slot }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height }}>
        <Svg width={width} height={height} style={{ position: 'absolute' }}>
          <Defs>
            <Pattern id="candle-dots" width={22} height={22} patternUnits="userSpaceOnUse">
              <Circle cx={1} cy={1} r={0.9} fill={c.divider} />
            </Pattern>
          </Defs>
          <Rect width={width} height={height} fill="url(#candle-dots)" />
        </Svg>

        {/* Highlight behind the candle under the finger */}
        <Animated.View
          pointerEvents="none"
          style={[
            { position: 'absolute', top: 0, bottom: 0, width: slot, backgroundColor: c.raised },
            cursorStyle,
          ]}
        />

        <Animated.View style={[{ position: 'absolute', top: 0, left: 0 }, revealStyle]}>
          <Svg width={width} height={height}>
            {data.map((d, i) => {
              const color = d.close >= d.open ? c.success : c.error;
              const x = i * slot + slot / 2;
              const top = y(Math.max(d.open, d.close));
              const bottom = y(Math.min(d.open, d.close));
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: candles are positional.
                <G key={i}>
                  <Line x1={x} x2={x} y1={y(d.high)} y2={y(d.low)} stroke={color} strokeWidth={1} />
                  <Rect
                    x={x - body / 2}
                    y={top}
                    width={body}
                    height={Math.max(bottom - top, 1)}
                    rx={1}
                    fill={color}
                  />
                </G>
              );
            })}
          </Svg>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
