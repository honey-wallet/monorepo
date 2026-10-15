// Motion: transitions.dev "Accordion" (https://transitions.dev), ported to Reanimated.
// The panel's height eases between 0 and its content height while the content fades
// (250ms, smooth ease-out); the header chevron flips from "v" to "^" via scaleY.
import { type ReactNode, useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { DURATION, EASE } from '@/theme/motion';

const timing = (reduce: boolean) => ({
  duration: reduce ? 0 : DURATION.fast,
  easing: EASE.smoothOut,
});

/** A collapsible panel. Renders its children even when closed, to measure them. */
export function Accordion({ open, children }: { open: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const [height, setHeight] = useState(0);
  const progress = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, timing(reduceMotion));
  }, [open, reduceMotion, progress]);

  const panelStyle = useAnimatedStyle(() => ({
    height: progress.value * height,
    opacity: progress.value,
  }));

  return (
    <Animated.View
      style={[{ overflow: 'hidden' }, panelStyle]}
      pointerEvents={open ? 'auto' : 'none'}
    >
      <View
        style={{ position: 'absolute', left: 0, right: 0 }}
        onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      >
        {children}
      </View>
    </Animated.View>
  );
}

/** The accordion header's chevron: flips from "v" to "^" through a flat line. */
export function AccordionChevron({
  open,
  size,
  color,
}: {
  open: boolean;
  size: number;
  color: string;
}) {
  const reduceMotion = useReducedMotion();
  const flip = useSharedValue(open ? -1 : 1);
  useEffect(() => {
    flip.value = withTiming(open ? -1 : 1, timing(reduceMotion));
  }, [open, reduceMotion, flip]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: flip.value }] }));
  return (
    <Animated.View style={style}>
      <Icon name="chevronDown" size={size} color={color} />
    </Animated.View>
  );
}
