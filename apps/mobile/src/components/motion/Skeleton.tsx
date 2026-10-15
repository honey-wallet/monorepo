// Motion: transitions.dev "Skeleton loader and reveal" (https://transitions.dev),
// ported to Reanimated. Placeholder bars pulse (1000ms, down to 0.5 opacity), then the
// skeleton and the real content cross-fade over 400ms. The 2px blur is omitted.
import { type ReactNode, useEffect } from 'react';
import { type DimensionValue, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

const REVEAL = Easing.inOut(Easing.ease);

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
    opacity.value = withRepeat(withTiming(0.5, { duration: 500, easing: REVEAL }), -1, true);
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
        <Animated.View key="skeleton" exiting={FadeOut.duration(DURATION.slow).easing(REVEAL)}>
          {skeleton}
        </Animated.View>
      ) : (
        <Animated.View key="content" entering={FadeIn.duration(DURATION.slow).easing(REVEAL)}>
          {children}
        </Animated.View>
      )}
    </View>
  );
}
