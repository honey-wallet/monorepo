// Motion: the badge slides in diagonally toward the bell's corner (from -8px, 12px,
// 200ms, strong ease-out) while the dot fades in from 90% scale, with no overshoot;
// it leaves faster than it came, fading and dipping back to 90% (150ms). The trigger
// never moves. Under Reduce Motion it only fades.
import { type StyleProp, StyleSheet, type ViewStyle } from 'react-native';
import Animated, { Keyframe, useReducedMotion } from 'react-native-reanimated';
import { makeStyles } from '@/theme';
import { DURATION, EASE, lazy } from '@/theme/motion';
import { fadeIn, fadeOut } from './reducedFade';

const OFFSET_X = -8;
const OFFSET_Y = 12;
const SCALE_FROM = 0.9;

const slideIn = lazy(() =>
  new Keyframe({
    0: { transform: [{ translateX: OFFSET_X }, { translateY: OFFSET_Y }] },
    100: { transform: [{ translateX: 0 }, { translateY: 0 }], easing: EASE.smoothOut },
  }).duration(DURATION.fast),
);

const popIn = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ scale: SCALE_FROM }] },
    100: { opacity: 1, transform: [{ scale: 1 }], easing: EASE.smoothOut },
  }).duration(DURATION.fast),
);

const close = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ scale: 1 }] },
    100: { opacity: 0, transform: [{ scale: SCALE_FROM }], easing: EASE.smoothOut },
  }).duration(DURATION.quick),
);

/**
 * A small dot pinned to a trigger's corner (e.g. unread notifications). Mount it
 * while there's something new and unmount it to dismiss; the motion handles both.
 */
export function NotificationBadge({ style }: { style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  return (
    <Animated.View
      pointerEvents="none"
      entering={reduceMotion ? fadeIn() : slideIn()}
      exiting={reduceMotion ? fadeOut() : close()}
      style={[styles.anchor, style]}
    >
      <Animated.View entering={reduceMotion ? undefined : popIn()} style={styles.dot} />
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  anchor: {
    position: 'absolute',
    top: -2,
    right: -2,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth * 3,
    borderColor: c.canvas,
    backgroundColor: c.error,
  },
}));
