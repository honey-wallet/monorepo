// A panel appearing inside a card fades in with a short 8px rise as a directional hint
// (250ms, strong ease-out) and leaves faster (150ms). A long travel would make a small
// panel feel heavy; the hint is enough. Under Reduce Motion it only fades.
import { type ReactNode, useEffect } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';

const PANEL = { open: DURATION.medium, close: DURATION.quick } as const;

/**
 * A panel that slides into view inside its container. It keeps its space while
 * closed, so opening it never shifts what's around it.
 */
export function PanelReveal({
  open,
  style,
  children,
}: {
  open: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    const duration = open ? PANEL.open : PANEL.close;
    progress.value = withTiming(open ? 1 : 0, {
      duration,
      easing: reduceMotion ? EASE.ease : EASE.smoothOut,
    });
  }, [open, reduceMotion, progress]);

  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: reduceMotion ? 0 : (1 - progress.value) * DISTANCE.base }],
  }));

  return (
    <Animated.View
      pointerEvents={open ? 'auto' : 'none'}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      style={[style, animated]}
    >
      {children}
    </Animated.View>
  );
}
