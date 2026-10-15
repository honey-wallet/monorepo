// Motion: transitions.dev "Texts reveal" (https://transitions.dev), ported to
// Reanimated. A headline and a supporting line rise 12px into view (500ms, smooth
// ease-out), the second 40ms behind so the eye lands on the headline first. The 3px
// blur is omitted (no iOS filter). Replays whenever `id` changes.
import type { ReactNode } from 'react';
import { View } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';

const rise = (delay: number) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: DISTANCE.medium }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
  })
    .duration(DURATION.verySlow)
    .delay(delay);

type Props = {
  id: string;
  /** The headline. */
  first: ReactNode;
  /** The supporting line, held back by one stagger step. */
  second?: ReactNode;
  align?: 'flex-start' | 'center';
};

export function TextsReveal({ id, first, second, align = 'flex-start' }: Props) {
  return (
    <View key={id} style={{ alignItems: align }}>
      <Animated.View entering={rise(0)}>{first}</Animated.View>
      {second ? <Animated.View entering={rise(DURATION.stagger)}>{second}</Animated.View> : null}
    </View>
  );
}
