// Motion: a rare, earned moment (a swap went through), so it can take 400ms. The disc
// fades in, rising 8px and growing from 90% (strong ease-out, no overshoot: nothing
// appears from nothing), then the tick draws on 120ms in (300ms). Under Reduce Motion
// the finished check fades in, without the rise or the draw.
import { useEffect } from 'react';
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/theme';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';

const CHECK = {
  appear: { duration: DURATION.verySlow, easing: EASE.smoothOut },
  draw: { duration: DURATION.slow, easing: EASE.smoothOut },
  fade: { duration: DURATION.fast, easing: EASE.ease },
  drawDelay: 120,
  scaleFrom: 0.9,
} as const;

/** The tick in a 48×48 box, and its length for the stroke draw. */
const TICK = 'M14.5 24.5L21 31L33.5 18.5';
const TICK_LENGTH = 27;

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** A green disc with a tick that draws on: shown when an action has gone through. */
export function SuccessCheck({ size = 64 }: { size?: number }) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const appear = useSharedValue(0);
  const draw = useSharedValue(reduceMotion ? 1 : 0);
  // Read in the worklet: under Reduce Motion only the opacity changes.
  const still = reduceMotion;

  useEffect(() => {
    if (reduceMotion) {
      appear.value = withTiming(1, CHECK.fade);
      return;
    }
    appear.value = withTiming(1, CHECK.appear);
    draw.value = withDelay(CHECK.drawDelay, withTiming(1, CHECK.draw));
  }, [reduceMotion, appear, draw]);

  const style = useAnimatedStyle(() => {
    const t = still ? 1 : appear.value;
    return {
      opacity: appear.value,
      transform: [
        { translateY: (1 - t) * DISTANCE.base },
        { scale: CHECK.scaleFrom + (1 - CHECK.scaleFrom) * t },
      ],
    };
  });
  const tick = useAnimatedProps(() => ({
    strokeDashoffset: (1 - draw.value) * TICK_LENGTH,
  }));

  return (
    <Animated.View style={style}>
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
  );
}
