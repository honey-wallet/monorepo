// Motion: a crossfade with a small directional hint. The old text leaves up 4px
// (150ms), then the new one enters from 4px below (200ms, ease-out), so the label
// reads as changing rather than blinking. Under Reduce Motion it only fades.
import type { StyleProp, TextStyle } from 'react-native';
import Animated, { Keyframe, useReducedMotion } from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE, lazy } from '@/theme/motion';
import { fadeIn, fadeOut } from './reducedFade';
import { useHasMounted } from './useHasMounted';

const exit = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ translateY: 0 }] },
    100: { opacity: 0, transform: [{ translateY: -DISTANCE.micro }], easing: EASE.smoothOut },
  }).duration(DURATION.quick),
);

const enter = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: DISTANCE.micro }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
  })
    .duration(DURATION.fast)
    .delay(DURATION.micro),
);

/** Text that swaps in place whenever it changes, e.g. "Enter an amount" → "Review". */
export function TextSwap({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const mounted = useHasMounted();
  const reduceMotion = useReducedMotion();
  return (
    <Animated.Text
      key={text}
      entering={mounted ? (reduceMotion ? fadeIn() : enter()) : undefined}
      exiting={reduceMotion ? fadeOut() : exit()}
      style={style}
    >
      {text}
    </Animated.Text>
  );
}
