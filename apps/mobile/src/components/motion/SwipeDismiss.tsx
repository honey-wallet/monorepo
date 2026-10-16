// A card you can throw away (a dismissable suggestion). Drag it sideways and it follows
// the finger 1:1, fading as it goes; let go past a third of its width, or with a flick,
// and it carries on out in the direction it was thrown (200ms, strong ease-out, since
// it's leaving), then the space it left closes up (the parent collapses it). Let go
// early and it springs back with the slight overshoot a released drag earns. The X
// button sends it out to the right the same way. Under Reduce Motion it only fades.
import type { ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { DURATION, EASE, SPRING } from '@/theme/motion';

/** Sideways speed (pt/s) that throws the card even from a short drag. */
const FLICK = 700;

export function SwipeDismiss({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  /** Gets `dismiss`, for a close button inside the card. */
  children: (dismiss: () => void) => ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const { width } = useWindowDimensions();
  const x = useSharedValue(0);
  const fade = useSharedValue(1);

  const out = (direction: number) => {
    'worklet';
    const done = (finished?: boolean) => {
      'worklet';
      if (finished) scheduleOnRN(onDismiss);
    };
    const timing = { duration: DURATION.fast, easing: EASE.smoothOut };
    if (reduceMotion) {
      fade.value = withTiming(0, timing, done);
      return;
    }
    x.value = withTiming(direction * width, timing, done);
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      x.value = e.translationX;
    })
    .onEnd((e) => {
      const thrown = Math.abs(e.translationX) > width / 3 || Math.abs(e.velocityX) > FLICK;
      if (thrown) out(Math.sign(e.translationX || e.velocityX));
      else x.value = withSpring(0, SPRING.release);
    });

  const style = useAnimatedStyle(() => ({
    opacity: fade.value * interpolate(Math.abs(x.value), [0, width * 0.6], [1, 0], 'clamp'),
    transform: [{ translateX: x.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>{children(() => out(1))}</Animated.View>
    </GestureDetector>
  );
}
