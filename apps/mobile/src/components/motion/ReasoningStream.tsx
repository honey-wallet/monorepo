// Motion: a small card plays back a transcript, stepping it up two lines at a time
// (300ms, ease-in-out, since the text is already on screen), holding 840ms between
// steps so each pair can be read. The transcript is drawn twice so the offset can wrap
// by one copy's height without a visible jump. React Native has no masks, so the 28px
// top and bottom fades are gradients in the card's own colour. Under Reduce Motion
// it holds still (a decorative loop).
import { useEffect } from 'react';
import { type StyleProp, StyleSheet, Text, type TextStyle, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { DURATION, EASE } from '@/theme/motion';

const REASON = { hold: 840, step: DURATION.slow, lines: 2, fade: 28 } as const;

/** A short transcript of what's happening, scrolling by two lines at a time. */
export function ReasoningStream({
  lines,
  background,
  lineHeight = 18,
  visibleLines = 5,
  textStyle,
}: {
  lines: string[];
  /** The card's colour, which the edge fades blend into. */
  background: string;
  lineHeight?: number;
  visibleLines?: number;
  textStyle?: StyleProp<TextStyle>;
}) {
  const reduceMotion = useReducedMotion();
  const offset = useSharedValue(0);
  const copyHeight = lines.length * lineHeight;
  const height = visibleLines * lineHeight;

  useEffect(() => {
    if (reduceMotion) return;
    let at = 0;
    const step = () => {
      at += REASON.lines * lineHeight;
      offset.value = withTiming(at, { duration: REASON.step, easing: EASE.inOut });
    };
    const timer = setInterval(() => {
      // Past one copy: jump back by a copy's height (identical text underneath),
      // then take the step from there.
      if (at >= copyHeight) {
        at -= copyHeight;
        offset.value = at;
      }
      step();
    }, REASON.hold + REASON.step);
    return () => {
      clearInterval(timer);
      cancelAnimation(offset);
    };
  }, [reduceMotion, lineHeight, copyHeight, offset]);

  const scroll = useAnimatedStyle(() => ({ transform: [{ translateY: -offset.value }] }));

  const transcript = lines.map((line) => (
    <Text key={line} numberOfLines={1} style={[textStyle, { height: lineHeight, lineHeight }]}>
      {line}
    </Text>
  ));

  return (
    <View accessible accessibilityLabel={lines.join('. ')} style={{ height, overflow: 'hidden' }}>
      <Animated.View style={scroll}>
        <View>{transcript}</View>
        <View>{transcript}</View>
      </Animated.View>
      <Fade color={background} edge="top" />
      <Fade color={background} edge="bottom" />
    </View>
  );
}

/** A soft edge: the card's colour fading to clear over 28px. */
function Fade({ color, edge }: { color: string; edge: 'top' | 'bottom' }) {
  const id = `reason-fade-${edge}`;
  return (
    <Svg
      pointerEvents="none"
      width="100%"
      height={REASON.fade}
      style={[styles.fade, edge === 'top' ? styles.top : styles.bottom]}
    >
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={edge === 'top' ? 1 : 0} />
          <Stop offset="1" stopColor={color} stopOpacity={edge === 'top' ? 0 : 1} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height={REASON.fade} fill={`url(#${id})`} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  top: {
    top: 0,
  },
  bottom: {
    bottom: 0,
  },
});
