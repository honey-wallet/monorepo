// Motion: transitions.dev "Text states swap" (https://transitions.dev), ported to
// Reanimated. The old text exits up 4px while fading, then the new text enters from
// 4px below. The recipe's 2px blur is omitted (no iOS filter).
import type { StyleProp, TextStyle } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE, lazy } from '@/theme/motion';
import { useHasMounted } from './useHasMounted';

const exit = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ translateY: 0 }] },
    100: { opacity: 0, transform: [{ translateY: -DISTANCE.micro }], easing: EASE.inOut },
  }).duration(DURATION.quick),
);

const enter = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: DISTANCE.micro }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.inOut },
  })
    .duration(DURATION.quick)
    .delay(DURATION.quick),
);

/** Text that swaps in place whenever it changes, e.g. "Enter an amount" → "Review". */
export function TextSwap({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const mounted = useHasMounted();
  return (
    <Animated.Text
      key={text}
      entering={mounted ? enter() : undefined}
      exiting={exit()}
      style={style}
    >
      {text}
    </Animated.Text>
  );
}
