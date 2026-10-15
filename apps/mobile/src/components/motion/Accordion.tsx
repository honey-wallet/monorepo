// The panel's height eases between 0 and its content height while the content fades,
// on the snappy height ease-out (250ms; collapsing is quicker, 200ms). The header
// chevron flips from "v" to "^" through a flat line on ease-in-out, since it moves in
// place. Under Reduce Motion the height jumps and only the content fades.
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

const panelTiming = (open: boolean) => ({
  duration: open ? DURATION.medium : DURATION.fast,
  easing: EASE.height,
});

/** A collapsible panel. Renders its children even when closed, to measure them. */
export function Accordion({ open, children }: { open: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const [height, setHeight] = useState(0);
  const progress = useSharedValue(open ? 1 : 0);
  const fade = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    progress.value = reduceMotion ? (open ? 1 : 0) : withTiming(open ? 1 : 0, panelTiming(open));
    fade.value = withTiming(open ? 1 : 0, {
      duration: open ? DURATION.medium : DURATION.fast,
      easing: EASE.ease,
    });
  }, [open, reduceMotion, progress, fade]);

  const panelStyle = useAnimatedStyle(() => ({
    height: progress.value * height,
    opacity: fade.value,
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
    flip.value = reduceMotion
      ? open
        ? -1
        : 1
      : withTiming(open ? -1 : 1, { duration: DURATION.medium, easing: EASE.inOut });
  }, [open, reduceMotion, flip]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: flip.value }] }));
  return (
    <Animated.View style={style}>
      <Icon name="chevronDown" size={size} color={color} />
    </Animated.View>
  );
}
