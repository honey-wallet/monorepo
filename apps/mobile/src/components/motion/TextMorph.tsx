// Motion: when a label changes to one that shares letters at its start or end
// ("Save" → "Saved"), the shared letters stay put; only the differing part crossfades
// (150ms) while its width eases to the new text (250ms, snappy ease-out), so the
// label grows or shrinks as one piece. Under Reduce Motion the new label just fades
// in. For labels that share nothing, use TextSwap.
import { useEffect, useRef, useState } from 'react';
import { type StyleProp, Text, type TextStyle, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { DURATION, EASE } from '@/theme/motion';
import { fadeIn } from './reducedFade';

const DUR = DURATION.quick;
const RESIZE_DUR = DURATION.medium;

type Parts = { start: string; from: string; to: string; end: string };

/** Splits two labels into their shared start, the differing middles and shared end. */
function diff(prev: string, next: string): Parts {
  let s = 0;
  while (s < prev.length && s < next.length && prev[s] === next[s]) s++;
  let e = 0;
  while (
    e < prev.length - s &&
    e < next.length - s &&
    prev[prev.length - 1 - e] === next[next.length - 1 - e]
  )
    e++;
  return {
    start: next.slice(0, s),
    from: prev.slice(s, prev.length - e),
    to: next.slice(s, next.length - e),
    end: next.slice(next.length - e),
  };
}

/** A label that morphs in place when `text` changes. */
export function TextMorph({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const reduceMotion = useReducedMotion();
  const [parts, setParts] = useState<Parts | null>(null);
  const shown = useRef(text);
  const width = useSharedValue(-1);
  const fade = useSharedValue(0);
  const fromWidth = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const prev = shown.current;
    if (prev === text) return;
    shown.current = text;
    clearTimeout(settle.current);
    if (reduceMotion) {
      setParts(null);
      return;
    }
    width.value = -1;
    fade.value = 0;
    setParts(diff(prev, text));
    // Once it settles, put the plain text back.
    settle.current = setTimeout(() => setParts(null), RESIZE_DUR + 40);
  }, [text, reduceMotion, width, fade]);

  useEffect(() => () => clearTimeout(settle.current), []);

  const box = useAnimatedStyle(() => (width.value < 0 ? {} : { width: width.value }));
  const outgoing = useAnimatedStyle(() => ({ opacity: 1 - fade.value }));
  const incoming = useAnimatedStyle(() => ({ opacity: fade.value }));

  if (!parts) {
    // Under Reduce Motion a changed label fades in; otherwise it's the settled text.
    return reduceMotion ? (
      <Animated.Text key={text} entering={fadeIn()} style={style}>
        {text}
      </Animated.Text>
    ) : (
      <Text style={style}>{text}</Text>
    );
  }

  return (
    <View style={{ flexDirection: 'row' }} accessible accessibilityLabel={text}>
      <Text style={style}>{parts.start}</Text>
      {/* The old middle sizes the box first; the new one is measured, then the box eases to it. */}
      <Animated.View style={[box, { overflow: 'hidden' }]}>
        <Animated.Text
          style={[style, outgoing]}
          numberOfLines={1}
          ellipsizeMode="clip"
          onLayout={(e) => {
            fromWidth.current = e.nativeEvent.layout.width;
          }}
        >
          {parts.from}
        </Animated.Text>
        {/* A wide, clipped track: the new middle lays out at its own width (not the old
            one's) so it's measured right and never shows an ellipsis while it grows. */}
        <View style={{ position: 'absolute', left: 0, top: 0, width: 1000, flexDirection: 'row' }}>
          <Animated.Text
            style={[style, incoming]}
            numberOfLines={1}
            ellipsizeMode="clip"
            onLayout={(e) => {
              const to = e.nativeEvent.layout.width;
              width.value = fromWidth.current;
              width.value = withTiming(to, { duration: RESIZE_DUR, easing: EASE.height });
              fade.value = withTiming(1, { duration: DUR, easing: EASE.ease });
            }}
          >
            {parts.to}
          </Animated.Text>
        </View>
      </Animated.View>
      <Text style={style}>{parts.end}</Text>
    </View>
  );
}
