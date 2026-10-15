// Motion: transitions.dev "Page side-by-side" (https://transitions.dev), ported to
// Reanimated. Incoming content fades in while sliding 8px from the side you moved
// towards; outgoing content fades out towards the other side (250ms, smooth ease-out).
// Without an `index` it's a plain cross-fade. The 3px blur is omitted (no iOS filter).
import { type ReactNode, useRef } from 'react';
import { View } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';
import { useHasMounted } from './useHasMounted';

const enter = (fromX: number) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateX: fromX }] },
    100: { opacity: 1, transform: [{ translateX: 0 }], easing: EASE.smoothOut },
  }).duration(DURATION.fast);

const exit = (toX: number) =>
  new Keyframe({
    0: { opacity: 1, transform: [{ translateX: 0 }] },
    100: { opacity: 0, transform: [{ translateX: toX }], easing: EASE.smoothOut },
  }).duration(DURATION.fast);

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
  const previous = useRef(index);
  const direction =
    index === undefined || previous.current === undefined ? 0 : Math.sign(index - previous.current);
  previous.current = index;
  const d = direction * DISTANCE.base;
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
