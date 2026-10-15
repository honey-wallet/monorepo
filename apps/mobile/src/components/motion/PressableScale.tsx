import type { Ref } from 'react';
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { DURATION, EASE, PRESS_SCALE } from '@/theme/motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** Scale while pressed: 0.97 for buttons, 0.98 for large cards. Never below 0.95. */
  scaleTo?: number;
  ref?: Ref<View>;
};

/**
 * A Pressable that dips slightly while held and returns on release. Press feedback is
 * felt, not seen: 0.97 over ~150ms on the press ease-out. Both directions animate from
 * wherever the scale is, so quick taps never jump.
 */
export function PressableScale({
  style,
  scaleTo = PRESS_SCALE,
  onPressIn,
  onPressOut,
  ...props
}: Props) {
  const scale = useSharedValue(1);
  const reduceMotion = useReducedMotion();
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <AnimatedPressable
      {...props}
      onPressIn={(event) => {
        if (!reduceMotion)
          scale.value = withTiming(Math.max(scaleTo, 0.95), {
            duration: DURATION.quick,
            easing: EASE.press,
          });
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        scale.value = withTiming(1, { duration: DURATION.quick, easing: EASE.press });
        onPressOut?.(event);
      }}
      style={[style, animatedStyle]}
    />
  );
}
