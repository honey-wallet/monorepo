// Motion: a 4×4 matrix of dots shares one colour pulse on a constant 1200ms clock:
// base → active at 15% of the cycle → back to base by 45%. Each column starts a tenth
// of the cycle after the last, so light scans across. Only colour changes, nothing
// moves; a decorative loop, so it holds still under Reduce Motion.
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme';

const CYCLE = 1200;
const DOTS = Array.from({ length: 16 }, (_, i) => i);

/** CSS ease-in-out, close enough as a smoothstep (and safe to call in a worklet). */
const inOut = (t: number) => {
  'worklet';
  return t * t * (3 - 2 * t);
};

/** A tiny inline loader: a column of light scanning across a 4×4 dot matrix. */
export function MatrixLoader({ dot = 2, gap = 2 }: { dot?: number; gap?: number }) {
  const reduceMotion = useReducedMotion();
  const clock = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    clock.value = withRepeat(withTiming(1, { duration: CYCLE, easing: Easing.linear }), -1);
    return () => cancelAnimation(clock);
  }, [reduceMotion, clock]);

  const size = dot * 4 + gap * 3;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, flexDirection: 'row', flexWrap: 'wrap', gap }}
    >
      {DOTS.map((i) => (
        <Dot key={i} clock={clock} delay={(i % 4) / 10} size={dot} />
      ))}
    </View>
  );
}

function Dot({ clock, delay, size }: { clock: SharedValue<number>; delay: number; size: number }) {
  const c = useTheme();
  const base = c.divider;
  const active = c.textSecondary;
  const style = useAnimatedStyle(() => {
    // Where this dot is in its own cycle, offset by its column's delay.
    const t = (clock.value - delay + 1) % 1;
    // 0% base → 15% active → 45% base, each leg ease-in-out; rest at base.
    const lit = t < 0.15 ? inOut(t / 0.15) : t < 0.45 ? 1 - inOut((t - 0.15) / 0.3) : 0;
    return { backgroundColor: interpolateColor(lit, [0, 1], [base, active]) };
  });
  return <Animated.View style={[{ width: size, height: size }, style]} />;
}
