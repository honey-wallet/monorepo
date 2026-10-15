// Motion: transitions.dev "Toggle" (https://transitions.dev), ported to Reanimated.
// The thumb travels 1px past the end, swings back and settles (55% / 80% / 100% of
// 350ms); the track colour switches at once. No animation on first render.
import { useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const WIDTH = 52;
const THUMB = 26;
const PAD = 3;
const TRAVEL = WIDTH - THUMB - PAD * 2;
const OVERSHOOT = 1;
const TOGGLE_DURATION = DURATION.medium;

function travel(to: number, from: number) {
  const past = to > from ? to + OVERSHOOT : to - OVERSHOOT;
  const ease = { easing: EASE.bounce };
  return withSequence(
    withTiming(past, { duration: TOGGLE_DURATION * 0.55, ...ease }),
    withTiming(to, { duration: TOGGLE_DURATION * 0.25, ...ease }),
    withTiming(to, { duration: TOGGLE_DURATION * 0.2 }),
  );
}

type Props = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  accessibilityLabel: string;
};

/** On/off switch with a honey track and a check in the thumb when on. */
export function Toggle({ value, onValueChange, accessibilityLabel }: Props) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const x = useSharedValue(value ? TRAVEL : 0);
  const mounted = useRef(false);

  useEffect(() => {
    const to = value ? TRAVEL : 0;
    // Skip the first run so switches don't animate when the screen opens.
    if (!mounted.current || reduceMotion) x.value = to;
    else x.value = travel(to, x.value);
    mounted.current = true;
  }, [value, reduceMotion, x]);

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const checkStyle = useAnimatedStyle(() => ({
    opacity: Math.min(Math.max(x.value / TRAVEL, 0), 1),
  }));

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value }}
      hitSlop={8}
      onPress={() => onValueChange(!value)}
    >
      <View style={[styles.track, { backgroundColor: value ? c.primary : c.raised }]}>
        <Animated.View style={[styles.thumb, thumbStyle]}>
          <Animated.View style={checkStyle}>
            <Icon name="check" size={12} color={c.accentText} />
          </Animated.View>
        </Animated.View>
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles(() => ({
  track: {
    width: WIDTH,
    height: THUMB + PAD * 2,
    padding: PAD,
    borderRadius: (THUMB + PAD * 2) / 2,
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
}));
