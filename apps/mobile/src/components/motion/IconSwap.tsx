// Motion: transitions.dev "Icon swap" (https://transitions.dev), ported to Reanimated.
// The incoming content scales up from 0.25 and fades in while the outgoing content does
// the reverse, both in the same slot (250ms, ease-in-out). The 2px blur is omitted.
import type { ReactNode } from 'react';
import { View } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/Icon';
import { DURATION, EASE, lazy } from '@/theme/motion';
import { useHasMounted } from './useHasMounted';

const START_SCALE = 0.25;

const enter = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ scale: START_SCALE }] },
    100: { opacity: 1, transform: [{ scale: 1 }], easing: EASE.inOut },
  }).duration(DURATION.fast),
);

const exit = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ scale: 1 }] },
    100: { opacity: 0, transform: [{ scale: START_SCALE }], easing: EASE.inOut },
  }).duration(DURATION.fast),
);

/** Swaps whatever is in a fixed-size slot whenever `id` changes, e.g. an avatar. */
export function Swap({ id, size, children }: { id: string; size: number; children: ReactNode }) {
  const mounted = useHasMounted();
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View
        key={id}
        entering={mounted ? enter() : undefined}
        exiting={exit()}
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
