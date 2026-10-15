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
import { DURATION, EASE } from '@/theme/motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** Scale while pressed. */
  scaleTo?: number;
  ref?: Ref<View>;
};

/** A Pressable that eases down slightly while held and back on release. */
export function PressableScale({ style, scaleTo = 0.97, onPressIn, onPressOut, ...props }: Props) {
  const scale = useSharedValue(1);
  const reduceMotion = useReducedMotion();
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <AnimatedPressable
      {...props}
      onPressIn={(event) => {
        if (!reduceMotion)
          scale.value = withTiming(scaleTo, { duration: DURATION.quick, easing: EASE.smoothOut });
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        scale.value = withTiming(1, { duration: DURATION.fast, easing: EASE.smoothOut });
        onPressOut?.(event);
      }}
      style={[style, animatedStyle]}
    />
  );
}
