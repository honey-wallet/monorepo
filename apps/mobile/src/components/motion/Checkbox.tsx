// Motion: checking fills the box (150ms), then the checkmark draws itself along its
// stroke (200ms, strong ease-out); unchecking clears both faster (150ms). Every change
// starts from the current state, so quick re-taps never jump. Under Reduce Motion the
// filled box and its check simply fade in and out together.
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { tap } from '@/lib/haptics';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const BOX = { duration: DURATION.quick, easing: EASE.smoothOut } as const;
const DRAW = { duration: DURATION.fast, easing: EASE.smoothOut } as const;
const CLEAR = { duration: DURATION.quick, easing: EASE.smoothOut } as const;
const FADE = {
  duration: DURATION.quick,
  easing: EASE.ease,
  reduceMotion: ReduceMotion.Never,
} as const;

const SIZE = 22;
/** The box's size, for lining other rows up with a checkbox's label. */
export const CHECKBOX_SIZE = SIZE;
/** Length of the check's stroke below; the dash hides exactly this much. */
const CHECK_LENGTH = 16.2;

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** A labelled checkbox row, for confirmations like "I've written it down". */
export function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const fill = useSharedValue(checked ? 1 : 0);
  const draw = useSharedValue(checked ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) {
      // The check is drawn whole; it fades in and out with the fill.
      fill.value = withTiming(checked ? 1 : 0, FADE);
      draw.value = 1;
      return;
    }
    if (checked) {
      fill.value = withTiming(1, BOX);
      draw.value = withDelay(BOX.duration / 2, withTiming(1, DRAW));
    } else {
      fill.value = withTiming(0, CLEAR);
      draw.value = withTiming(0, CLEAR);
    }
  }, [checked, reduceMotion, fill, draw]);

  const boxFill = useAnimatedStyle(() => ({ opacity: fill.value }));
  const reduced = reduceMotion;
  const checkFade = useAnimatedStyle(() => ({ opacity: reduced ? fill.value : 1 }));
  const checkProps = useAnimatedProps(() => ({
    strokeDashoffset: CHECK_LENGTH * (1 - draw.value),
  }));

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      hitSlop={6}
      onPress={() => {
        tap();
        onChange(!checked);
      }}
      style={styles.row}
    >
      <View style={styles.box}>
        <Animated.View style={[styles.fill, boxFill]} />
        <Animated.View style={checkFade}>
          <Svg width={SIZE} height={SIZE} viewBox="0 0 24 24">
            <AnimatedPath
              d="M6.5 12.5l3.6 3.6 7.4-8.2"
              stroke={c.onPrimary}
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              strokeDasharray={CHECK_LENGTH}
              animatedProps={checkProps}
            />
          </Svg>
        </Animated.View>
      </View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  box: {
    width: SIZE,
    height: SIZE,
    ...radius(7),
    borderWidth: 2,
    borderColor: c.divider,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Covers the border too, so a checked box is one solid honey square.
  fill: {
    position: 'absolute',
    top: -2,
    left: -2,
    right: -2,
    bottom: -2,
    backgroundColor: c.primary,
  },
  label: {
    flex: 1,
    color: c.text,
    fontSize: 16,
  },
}));
