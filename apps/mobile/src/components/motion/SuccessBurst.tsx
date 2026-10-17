// Motion: the end of a money flow is rare and earned, so this is the one place the app
// celebrates. The disc settles in from 90% with a little overshoot (small elements need
// more bounce to read), a ring ripples out behind it and fades, a handful of honey and
// green specks burst outward and shrink away, and the tick draws on as the disc lands.
// It all settles in about 500ms and never blocks the page. Under Reduce Motion the
// finished check fades in, with no burst, ring or spring.
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  ReduceMotion,
  type SharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const BURST = {
  pop: { duration: 400, dampingRatio: 0.85 },
  fade: { duration: DURATION.quick, easing: EASE.ease, reduceMotion: ReduceMotion.Never },
  ring: { duration: 450, easing: EASE.smoothOut },
  specks: { duration: 400, easing: EASE.smoothOut },
  draw: { duration: DURATION.slow, easing: EASE.smoothOut },
  ringDelay: 60,
  specksDelay: 90,
  drawDelay: 60,
  scaleFrom: 0.9,
} as const;

/** The tick in a 48×48 box, and its length for the stroke draw. */
const TICK = 'M14.5 24.5L21 31L33.5 18.5';
const TICK_LENGTH = 27;

/** Where each speck flies: angle (degrees), how far past the disc, and its size. */
const SPECKS = [
  { angle: -90, far: 46, size: 9 },
  { angle: -54, far: 32, size: 6 },
  { angle: -20, far: 52, size: 8 },
  { angle: 16, far: 34, size: 6 },
  { angle: 52, far: 48, size: 9 },
  { angle: 90, far: 30, size: 5 },
  { angle: 126, far: 46, size: 8 },
  { angle: 162, far: 34, size: 6 },
  { angle: 198, far: 52, size: 9 },
  { angle: 234, far: 32, size: 5 },
] as const;

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** A green check that pops in with a ring and a burst of specks: the action went through. */
export function SuccessBurst({ size = 72 }: { size?: number }) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const pop = useSharedValue(0);
  const fade = useSharedValue(0);
  const ring = useSharedValue(0);
  const burst = useSharedValue(0);
  const draw = useSharedValue(reduceMotion ? 1 : 0);
  const still = reduceMotion;

  useEffect(() => {
    fade.value = withTiming(1, BURST.fade);
    if (reduceMotion) return;
    pop.value = withSpring(1, BURST.pop);
    ring.value = withDelay(BURST.ringDelay, withTiming(1, BURST.ring));
    burst.value = withDelay(BURST.specksDelay, withTiming(1, BURST.specks));
    draw.value = withDelay(BURST.drawDelay, withTiming(1, BURST.draw));
  }, [reduceMotion, pop, fade, ring, burst, draw]);

  const disc = useAnimatedStyle(() => ({
    opacity: fade.value,
    transform: [{ scale: still ? 1 : BURST.scaleFrom + (1 - BURST.scaleFrom) * pop.value }],
  }));
  const ripple = useAnimatedStyle(() => ({
    opacity: still ? 0 : 0.35 * (1 - ring.value),
    transform: [{ scale: 1 + ring.value * 0.9 }],
  }));
  const tick = useAnimatedProps(() => ({
    strokeDashoffset: (1 - draw.value) * TICK_LENGTH,
  }));

  const colors = [c.primary, c.success, c.honey];
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: size / 2, backgroundColor: c.success },
          ripple,
        ]}
      />
      {still
        ? null
        : SPECKS.map((s, i) => (
            <Speck
              key={s.angle}
              progress={burst}
              center={size / 2}
              from={size / 2 - 4}
              {...s}
              color={colors[i % colors.length]}
            />
          ))}
      <Animated.View style={disc}>
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <Circle cx={24} cy={24} r={24} fill={c.success} />
          <AnimatedPath
            d={TICK}
            stroke="#FFFFFF"
            strokeWidth={3.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            strokeDasharray={TICK_LENGTH}
            animatedProps={tick}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

function Speck({
  progress,
  center,
  from,
  angle,
  far,
  size,
  color,
}: {
  progress: SharedValue<number>;
  center: number;
  from: number;
  angle: number;
  far: number;
  size: number;
  color: string;
}) {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const style = useAnimatedStyle(() => {
    const t = progress.value;
    const r = from + far * t;
    return {
      // Hidden until it leaves the disc's edge, then fades as it slows.
      opacity: t === 0 ? 0 : 1 - t * t,
      transform: [{ translateX: dx * r }, { translateY: dy * r }, { scale: 1 - 0.6 * t }],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: center - size / 2,
          top: center - size / 2,
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}
