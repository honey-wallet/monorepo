// Motion: transitions.dev "Number pop-in" (https://transitions.dev), ported to
// Reanimated. Each character rises 8px into place; the decimal point and the digits
// after it follow 70ms and 140ms later so the cents feel alive without looking
// chaotic. Replays whenever the value changes. The 2px blur is omitted (no iOS filter).
import type { StyleProp, TextStyle } from 'react-native';
import { View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import { DISTANCE } from '@/theme/motion';

const DIGIT_DURATION = 500;
const DIGIT_STAGGER = 70;
const DIGIT_EASE = Easing.bezier(0.34, 1.45, 0.64, 1);

/** One character's pop-in, e.g. a digit typed into a code box. */
export const popIn = (delay = 0) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: DISTANCE.base }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: DIGIT_EASE },
  })
    .duration(DIGIT_DURATION)
    .delay(delay);

type Props = {
  value: string;
  style?: StyleProp<TextStyle>;
  /** Style for the decimal point and everything after it, e.g. dimmed cents. */
  fractionStyle?: StyleProp<TextStyle>;
};

export function NumberPopIn({ value, style, fractionStyle }: Props) {
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
            entering={popIn(stagger * DIGIT_STAGGER)}
            style={[style, stagger > 0 && fractionStyle]}
          >
            {char}
          </Animated.Text>
        );
      })}
    </View>
  );
}
