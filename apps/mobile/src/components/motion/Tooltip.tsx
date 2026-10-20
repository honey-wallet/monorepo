// A tooltip names something; it shouldn't perform. After a short 80ms delay (so a
// brushing press doesn't flash it) it fades in and grows from 0.97 out of its anchor,
// top-centre under the icon (125ms, strong ease-out); it leaves almost at once (60ms)
// so it never lingers. Under Reduce Motion it only fades.
import { useEffect } from 'react';
import { Text } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { makeStyles, radius } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const IN_DUR = 125;
const OUT_DUR = 60;
const DELAY = DURATION.micro;
const SCALE = 0.97;

/**
 * A small label under its trigger, e.g. naming an icon on long-press. Place it inside
 * the trigger's (relatively positioned) wrapper and drive it with `visible`.
 */
export function Tooltip({ label, visible }: { label: string; visible: boolean }) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const shown = useSharedValue(0);

  useEffect(() => {
    shown.value = visible
      ? withDelay(
          DELAY,
          withTiming(1, {
            duration: IN_DUR,
            easing: reduceMotion ? EASE.ease : EASE.smoothOut,
            reduceMotion: ReduceMotion.Never,
          }),
        )
      : withTiming(0, { duration: OUT_DUR, easing: EASE.ease, reduceMotion: ReduceMotion.Never });
  }, [visible, reduceMotion, shown]);

  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ scale: reduceMotion ? 1 : SCALE + (1 - SCALE) * shown.value }],
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.anchor, style]}>
      <Text style={styles.bubble}>{label}</Text>
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  // Centred under the trigger, wider than it so the label never wraps.
  anchor: {
    position: 'absolute',
    top: '100%',
    left: -60,
    right: -60,
    marginTop: 10,
    alignItems: 'center',
    transformOrigin: 'center top',
  },
  bubble: {
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 5,
    ...radius(8),
    color: c.canvas,
    backgroundColor: c.text,
    fontSize: 13,
    fontWeight: '500',
  },
}));
