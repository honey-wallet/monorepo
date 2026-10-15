// Motion: a status line shimmers (see ShimmerText) while a state holds for 2000ms,
// then swaps with a small directional hint: the old line leaves up 6px (150ms) and
// the new one rises in from 6px below (200ms, ease-out), 50ms later. A hidden copy of
// the longest state holds the box's size so it never resizes mid-swap. Under Reduce
// Motion the lines only crossfade.
import { useEffect, useRef, useState } from 'react';
import { type StyleProp, StyleSheet, Text, type TextStyle, View } from 'react-native';
import Animated, { Keyframe, useReducedMotion } from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE, lazy } from '@/theme/motion';
import { fadeIn, fadeOut } from './reducedFade';
import { ShimmerText } from './ShimmerText';
import { useHasMounted } from './useHasMounted';

const THINK = { hold: 2000, gap: 50, distance: DISTANCE.small } as const;

const exit = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ translateY: 0 }] },
    100: { opacity: 0, transform: [{ translateY: -THINK.distance }], easing: EASE.smoothOut },
  }).duration(DURATION.quick),
);

const enter = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: THINK.distance }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
  })
    .duration(DURATION.fast)
    .delay(THINK.gap),
);

/**
 * A status line that narrates progress, e.g. "Preparing swap" → "Signing". Plays the
 * states once, holding each, and calls `onDone` after the last one's hold.
 */
export function ThinkingStates({
  states,
  onDone,
  style,
}: {
  states: string[];
  onDone?: () => void;
  style?: StyleProp<TextStyle>;
}) {
  const mounted = useHasMounted();
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  // Latest callback, so a parent re-render doesn't restart the hold timer.
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const last = index >= states.length - 1;
    const next = setTimeout(
      () => (last ? done.current?.() : setIndex(index + 1)),
      THINK.hold + (index > 0 ? DURATION.fast + THINK.gap : 0),
    );
    return () => clearTimeout(next);
  }, [index, states.length]);

  const longest = states.reduce((a, b) => (b.length > a.length ? b : a), '');
  const text = states[index];

  return (
    <View accessible accessibilityRole="text" accessibilityLiveRegion="polite">
      {/* Sizes the box to the longest state; never shown. */}
      <Text style={[style, styles.sizer]} numberOfLines={1}>
        {longest}
      </Text>
      <Animated.View
        key={text}
        entering={mounted ? (reduceMotion ? fadeIn() : enter()) : undefined}
        exiting={reduceMotion ? fadeOut() : exit()}
        style={styles.line}
      >
        <ShimmerText text={text} style={style} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sizer: {
    opacity: 0,
  },
  line: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
});
