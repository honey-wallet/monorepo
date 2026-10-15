// Motion: a headline and its supporting line rise 12px into view (400ms, ease-out;
// these are rare, first-time screens like onboarding, so they can take a little
// longer). The second line follows one 40ms stagger step behind and travels less, so
// the eye lands on the headline first. Under Reduce Motion both just fade in. Replays
// whenever `id` changes.
import type { ReactNode } from 'react';
import { View } from 'react-native';
import Animated, { Keyframe, useReducedMotion } from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';
import { fadeIn } from './reducedFade';

const rise = (delay: number, distance: number) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: distance }] },
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
  const reduceMotion = useReducedMotion();
  return (
    <View key={id} style={{ alignItems: align }}>
      <Animated.View entering={reduceMotion ? fadeIn() : rise(0, DISTANCE.medium)}>
        {first}
      </Animated.View>
      {second ? (
        <Animated.View entering={reduceMotion ? fadeIn() : rise(DURATION.stagger, DISTANCE.base)}>
          {second}
        </Animated.View>
      ) : null}
    </View>
  );
}
