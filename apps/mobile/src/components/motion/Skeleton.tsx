// Motion: placeholder bars breathe between full and half opacity on a steady 1000ms
// cycle, then the skeleton and the real content crossfade (200ms, ease) so the
// content doesn't pop in. Under Reduce Motion the pulse (decorative) stops; the
// crossfade stays because it has no movement.
import { type ReactNode, useEffect } from 'react';
import { type DimensionValue, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const PULSE = { duration: 500, easing: EASE.ease } as const;
const REVEAL = { duration: DURATION.fast, easing: EASE.ease } as const;

/** A pulsing placeholder bar. */
export function SkeletonBar({
  width,
  height = 14,
  radius = 6,
}: {
  width: DimensionValue;
  height?: number;
  radius?: number;
}) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) return;
    opacity.value = withRepeat(withTiming(0.5, PULSE), -1, true);
  }, [reduceMotion, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[{ width, height, borderRadius: radius, backgroundColor: c.raised }, style]}
    />
  );
}

/** Shows `skeleton` while loading, then cross-fades to the content. */
export function SkeletonReveal({
  loading,
  skeleton,
  children,
}: {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  return (
    <View>
      {loading ? (
        <Animated.View
          key="skeleton"
          exiting={FadeOut.duration(REVEAL.duration)
            .easing(REVEAL.easing)
            .reduceMotion(ReduceMotion.Never)}
        >
          {skeleton}
        </Animated.View>
      ) : (
        <Animated.View
          key="content"
          entering={FadeIn.duration(REVEAL.duration)
            .easing(REVEAL.easing)
            .reduceMotion(ReduceMotion.Never)}
        >
          {children}
        </Animated.View>
      )}
    </View>
  );
}
