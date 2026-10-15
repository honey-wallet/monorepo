// Motion: words resolve in order, one every 40ms, each fading in over 300ms on a
// strong ease-out. It only plays once, after a swap lands (a rare moment), and the
// stagger never blocks anything. Under Reduce Motion the sentence fades in whole.
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { DURATION, EASE } from '@/theme/motion';
import { fadeIn } from './reducedFade';

const STREAM = { gap: DURATION.stagger, fade: DURATION.slow } as const;

/** A sentence that streams in word by word, e.g. a summary after a swap goes through. */
export function StreamingText({
  text,
  style,
  align = 'center',
  containerStyle,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  align?: 'left' | 'center';
  containerStyle?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReducedMotion();
  const words = text.trim().split(/\s+/);
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={[
        {
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: align === 'center' ? 'center' : 'flex-start',
        },
        containerStyle,
      ]}
    >
      {words.map((word, i) => (
        <Animated.Text
          // biome-ignore lint/suspicious/noArrayIndexKey: words keep their order
          key={`${i}-${word}`}
          entering={
            reduceMotion
              ? fadeIn()
              : FadeIn.duration(STREAM.fade)
                  .delay(i * STREAM.gap)
                  .easing(EASE.smoothOut)
          }
          style={style}
        >
          {i < words.length - 1 ? `${word} ` : word}
        </Animated.Text>
      ))}
    </View>
  );
}
