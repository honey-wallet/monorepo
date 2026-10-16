// Swapping similar content (tabs, steps) is a crossfade with a subtle 8px directional
// hint rather than a full slide: moving forward, the new view comes in from the right
// and the old one leaves to the left (back is the mirror), so the space stays
// consistent. Enter 200ms on a strong ease-out; the old view just fades out (150ms,
// exits are shorter), since its direction would be the one it was rendered with, not
// the one you're going. Without an `index` it's a plain crossfade, and under Reduce
// Motion it only fades.
import { type ReactNode, useRef } from 'react';
import { View } from 'react-native';
import Animated, { Keyframe, ReduceMotion, useReducedMotion } from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';
import { fadeOut } from './reducedFade';
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
  // The direction is worked out once per swap (when the id changes), so re-renders in
  // between don't reset it.
  const last = useRef({ id, index, direction: 0 });
  if (last.current.id !== id) {
    const from = last.current.index;
    last.current = {
      id,
      index,
      direction: index === undefined || from === undefined ? 0 : Math.sign(index - from),
    };
  }
  const { direction } = last.current;
  const d = reduceMotion ? 0 : direction * DISTANCE.base;
  return (
    <View style={fill && FILL}>
      <Animated.View
        key={id}
        entering={mounted ? enter(d) : undefined}
        exiting={fadeOut()}
        style={fill && FILL}
      >
        {children}
      </Animated.View>
    </View>
  );
}
