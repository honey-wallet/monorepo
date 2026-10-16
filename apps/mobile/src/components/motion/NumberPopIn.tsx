// Motion: when a balance or price changes, only the characters that changed move:
// each new one rises 6px into place (250ms, ease-out, no overshoot) while the one it
// replaces fades out (150ms), and the point and cents follow one 40ms step behind so
// the whole part reads first. Characters that stayed the same don't move, and the
// value that's there when it first shows doesn't animate, so a price that ticks every
// few seconds stays calm. Under Reduce Motion the changed characters just crossfade.
import type { StyleProp, TextStyle } from 'react-native';
import { View } from 'react-native';
import Animated, { Keyframe, useReducedMotion } from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';
import { fadeIn, fadeOut } from './reducedFade';
import { useHasMounted } from './useHasMounted';

/** One character rising into place, e.g. a digit of a changed balance. */
export const popIn = (delay = 0) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: DISTANCE.small }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE.smoothOut },
  })
    .duration(DURATION.medium)
    .delay(delay);

type Props = {
  value: string;
  style?: StyleProp<TextStyle>;
  /** Style for the decimal point and everything after it, e.g. dimmed cents. */
  fractionStyle?: StyleProp<TextStyle>;
};

export function NumberPopIn({ value, style, fractionStyle }: Props) {
  const reduceMotion = useReducedMotion();
  const mounted = useHasMounted();
  const point = value.indexOf('.');
  return (
    <View accessible accessibilityLabel={value} style={{ flexDirection: 'row' }}>
      {[...value].map((char, i) => {
        // 0 for the whole part, 1 for the point, 2 for the digits after it.
        const stagger = point < 0 || i < point ? 0 : Math.min(i - point + 1, 2);
        return (
          <Animated.Text
            // A character keeps its identity while it's the same character in the same
            // place (counted from the right, where digits change); a change remounts it.
            // biome-ignore lint/suspicious/noArrayIndexKey: position plus character is the identity.
            key={`${value.length - i}:${char}`}
            entering={
              mounted ? (reduceMotion ? fadeIn() : popIn(stagger * DURATION.stagger)) : undefined
            }
            exiting={fadeOut()}
            style={[style, stagger > 0 && fractionStyle]}
          >
            {char}
          </Animated.Text>
        );
      })}
    </View>
  );
}
