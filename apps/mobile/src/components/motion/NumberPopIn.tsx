// Motion: when a balance or price changes, each character rises 6px into place
// (250ms, ease-out, no overshoot); the point and the cents follow one 40ms stagger
// step behind so the whole part reads first. Numbers change occasionally, so this
// stays short and quiet. Under Reduce Motion the new value just fades in.
import type { StyleProp, TextStyle } from 'react-native';
import { View } from 'react-native';
import Animated, { Keyframe, useReducedMotion } from 'react-native-reanimated';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';
import { fadeIn } from './reducedFade';

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
  const point = value.indexOf('.');
  return (
    <View key={value} accessible accessibilityLabel={value} style={{ flexDirection: 'row' }}>
      {[...value].map((char, i) => {
        // 0 for the whole part, 1 for the point, 2 for the digits after it.
        const stagger = point < 0 || i < point ? 0 : Math.min(i - point + 1, 2);
        return (
          <Animated.Text
            // biome-ignore lint/suspicious/noArrayIndexKey: characters repeat; position is the identity.
            key={i}
            entering={reduceMotion ? fadeIn() : popIn(stagger * DURATION.stagger)}
            style={[style, stagger > 0 && fractionStyle]}
          >
            {char}
          </Animated.Text>
        );
      })}
    </View>
  );
}
