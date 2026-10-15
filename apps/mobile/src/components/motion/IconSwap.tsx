// Motion: the course's icon swap (copy → check): the incoming icon scales up from 50%
// and fades in while the outgoing one shrinks and fades, 100ms each, ease-out, in the
// same slot. Small icons need the larger scale change to read. Under Reduce Motion
// it's a plain crossfade.
import type { ReactNode } from 'react';
import { View } from 'react-native';
import Animated, { Keyframe, useReducedMotion } from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/Icon';
import { EASE, lazy } from '@/theme/motion';
import { fadeIn, fadeOut } from './reducedFade';
import { useHasMounted } from './useHasMounted';

const START_SCALE = 0.5;
const SWAP_DURATION = 100;

const enter = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ scale: START_SCALE }] },
    100: { opacity: 1, transform: [{ scale: 1 }], easing: EASE.smoothOut },
  }).duration(SWAP_DURATION),
);

const exit = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ scale: 1 }] },
    100: { opacity: 0, transform: [{ scale: START_SCALE }], easing: EASE.smoothOut },
  }).duration(SWAP_DURATION),
);

/** Swaps whatever is in a fixed-size slot whenever `id` changes, e.g. an avatar. */
export function Swap({ id, size, children }: { id: string; size: number; children: ReactNode }) {
  const mounted = useHasMounted();
  const reduceMotion = useReducedMotion();
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View
        key={id}
        entering={mounted ? (reduceMotion ? fadeIn() : enter()) : undefined}
        exiting={reduceMotion ? fadeOut() : exit()}
        style={{ position: 'absolute' }}
      >
        {children}
      </Animated.View>
    </View>
  );
}

/** Swaps between icons in one slot whenever `name` changes, e.g. copy → check. */
export function IconSwap({ name, size, color }: { name: IconName; size: number; color: string }) {
  return (
    <Swap id={name} size={size}>
      <Icon name={name} size={size} color={color} />
    </Swap>
  );
}
