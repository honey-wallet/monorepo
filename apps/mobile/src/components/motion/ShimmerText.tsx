// Motion: a soft highlight band sweeps across the glyphs every 1600ms. It's constant
// motion that signals "still working", so it's linear; a quicker sweep makes the wait
// feel shorter. With no text clipping in React Native, the band is built from thin
// slices of a highlight copy of the text, each clipped to its slice and faded to make
// the gradient. A decorative loop, so it holds still under Reduce Motion.
import { useEffect, useState } from 'react';
import { type StyleProp, StyleSheet, Text, type TextStyle, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme';

const SHIMMER = {
  duration: 1600,
  /** A band 0.8× the text wide, lit in the middle and clear at its edges. */
  band: 0.8,
} as const;

/** Slices in the band; their opacities ramp up to the middle and back down. */
const SLICES = 9;

/** A label that shimmers while something is in progress, e.g. "Finding best route". */
export function ShimmerText({
  text,
  style,
  base,
  highlight,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  /** Resting text colour; defaults to the secondary text colour. */
  base?: string;
  /** The sweep's colour; defaults to the primary text colour. */
  highlight?: string;
}) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (!width || reduceMotion) return;
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: SHIMMER.duration, easing: Easing.linear }),
      -1,
    );
    return () => cancelAnimation(progress);
  }, [width, reduceMotion, progress]);

  const bandWidth = width * SHIMMER.band;
  const slice = bandWidth / SLICES;
  const lit = highlight ?? c.text;

  return (
    <View>
      <Text
        numberOfLines={1}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={[style, { color: base ?? c.textSecondary }]}
      >
        {text}
      </Text>
      {width > 0 && !reduceMotion && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip]}>
          {Array.from({ length: SLICES }, (_, i) => (
            <Slice
              // biome-ignore lint/suspicious/noArrayIndexKey: slices are fixed positions
              key={i}
              index={i}
              slice={slice}
              width={width}
              progress={progress}
              text={text}
              style={[style, { color: lit }]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** One slice of the band: a window onto a highlight copy of the text, kept aligned. */
function Slice({
  index,
  slice,
  width,
  progress,
  text,
  style,
}: {
  index: number;
  slice: number;
  width: number;
  progress: SharedValue<number>;
  text: string;
  style: StyleProp<TextStyle>;
}) {
  // Triangle ramp: clear at the band's edges, solid in the middle.
  const mid = (SLICES - 1) / 2;
  const opacity = 1 - Math.abs(index - mid) / (mid + 1);
  const window = useAnimatedStyle(() => {
    // The band's centre travels from one text-width before the start to two after,
    // so it enters and leaves fully off the text.
    const centre = -width + 3 * width * progress.value;
    const left = centre - (slice * SLICES) / 2 + index * slice;
    return { transform: [{ translateX: left }] };
  });
  const copy = useAnimatedStyle(() => {
    const centre = -width + 3 * width * progress.value;
    const left = centre - (slice * SLICES) / 2 + index * slice;
    return { transform: [{ translateX: -left }] };
  });
  return (
    <Animated.View style={[styles.slice, { width: slice, opacity }, window]}>
      <Animated.Text numberOfLines={1} style={[style, { width }, copy]}>
        {text}
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
  slice: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
  },
});
