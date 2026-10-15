// Swapping similar content (tabs, steps) is a crossfade with a subtle 8px directional
// hint rather than a full slide: moving forward, the new view comes in from the right
// and the old one leaves to the left (back is the mirror), so the space stays
// consistent. Enter 200ms, exit 150ms (exits are shorter), strong ease-out. Without an
// `index` it's a plain crossfade, and under Reduce Motion it only fades.
import { type ReactNode, useRef } from 'react';
import { View } from 'react-native';
import Animated, { Keyframe, ReduceMotion, useReducedMotion } from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';
import { useHasMounted } from './useHasMounted';

// Reduce Motion is handled here (no offset), so the fade still plays rather than the
// library skipping the animation outright.
const enter = (fromX: number) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateX: fromX }] },
    100: { opacity: 1, transform: [{ translateX: 0 }], easing: EASE.smoothOut },
  })
    .duration(DURATION.fast)
    .reduceMotion(ReduceMotion.Never);

const exit = (toX: number) =>
  new Keyframe({
    0: { opacity: 1, transform: [{ translateX: 0 }] },
    100: { opacity: 0, transform: [{ translateX: toX }], easing: EASE.smoothOut },
  })
    .duration(DURATION.quick)
    .reduceMotion(ReduceMotion.Never);

const FILL = { flex: 1 } as const;

type Props = {
  /** Changing the id swaps the content. */
  id: string;
  /** Position among sibling views (e.g. tab order), so the slide follows the direction. */
  index?: number;
  /** Stretch to the parent's height, so content can pin things to the bottom. */
  fill?: boolean;
  children: ReactNode;
};

export function ContentSwap({ id, index, fill, children }: Props) {
  const mounted = useHasMounted();
  const reduceMotion = useReducedMotion();
  const previous = useRef(index);
  const direction =
    index === undefined || previous.current === undefined ? 0 : Math.sign(index - previous.current);
  previous.current = index;
  const d = reduceMotion ? 0 : direction * DISTANCE.base;
  return (
    <View style={fill && FILL}>
      <Animated.View
        key={id}
        entering={mounted ? enter(d) : undefined}
        exiting={exit(-d)}
        style={fill && FILL}
      >
        {children}
      </Animated.View>
    </View>
  );
}
