// Motion: a pure crossfade for values that change in place (a chart's period, a
// filter): old and new fade together in the same spot (200ms, ease) with no movement,
// while the value's width eases to the new text (250ms, snappy ease-out). The fade has
// no movement, so it stays under Reduce Motion; only the resize is dropped.
import type { StyleProp, TextStyle } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { DURATION, EASE, lazy } from '@/theme/motion';
import { useHasMounted } from './useHasMounted';

const enter = lazy(() =>
  FadeIn.duration(DURATION.fast).easing(EASE.ease).reduceMotion(ReduceMotion.Never),
);
const exit = lazy(() =>
  FadeOut.duration(DURATION.fast).easing(EASE.ease).reduceMotion(ReduceMotion.Never),
);
const resize = lazy(() => LinearTransition.duration(DURATION.medium).easing(EASE.height));

/**
 * A value that cross-fades in place when it changes, e.g. amounts when a chart's
 * period or a filter changes. `align="end"` keeps right-aligned values on their edge.
 */
export function TextSoftSwap({
  text,
  style,
  align = 'start',
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  align?: 'start' | 'end';
}) {
  const mounted = useHasMounted();
  return (
    <Animated.View
      layout={resize()}
      style={{ flexDirection: 'row', justifyContent: align === 'end' ? 'flex-end' : 'flex-start' }}
    >
      <Animated.Text
        key={text}
        entering={mounted ? enter() : undefined}
        exiting={exit()}
        style={style}
      >
        {text}
      </Animated.Text>
    </Animated.View>
  );
}
