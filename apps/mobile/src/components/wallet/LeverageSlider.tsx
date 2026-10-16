// Motion: leverage is picked by dragging a thumb along a thin track with a dot at each
// stop. The thumb follows the finger 1:1 (direct manipulation, no easing), grows a
// little while held, and on release settles onto the nearest stop on the release
// spring (the slight overshoot a drag earns). Each stop passed ticks a haptic; a tap
// on the track jumps to that stop. Under Reduce Motion the thumb moves without the
// spring or the grow.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { tap } from '@/lib/haptics';
import { makeStyles } from '@/theme';
import { DURATION, EASE, SPRING } from '@/theme/motion';

const THUMB = 24;

/** "Leverage  10x" above a track of stops, e.g. 1x · 2x · 5x · 10x · 20x · 40x. */
export function LeverageSlider({
  stops,
  value,
  onChange,
}: {
  stops: number[];
  value: number;
  onChange: (value: number) => void;
}) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const travel = Math.max(1, width - THUMB);
  const last = stops.length - 1;
  const index = Math.max(0, stops.indexOf(value));
  const x = useSharedValue(0);
  const held = useSharedValue(0);

  // Placed at the current stop once the track is measured, and whenever it changes.
  useEffect(() => {
    // Not while held: the finger is moving it, and picking stops changes `index`.
    if (!width || held.value > 0) return;
    x.value = (index / last) * travel;
  }, [width, index, last, travel, x, held]);

  const pick = (i: number) => {
    tap();
    onChange(stops[i]);
  };
  useAnimatedReaction(
    () => Math.round((x.value / travel) * last),
    (i, prev) => {
      if (prev !== null && i !== prev && held.value > 0) scheduleOnRN(pick, i);
    },
  );

  const settle = (i: number) => {
    'worklet';
    const to = (i / last) * travel;
    x.value = reduceMotion ? to : withSpring(to, SPRING.release);
  };
  const drag = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .failOffsetY([-10, 10])
    .onStart(() => {
      held.value = reduceMotion
        ? 1
        : withTiming(1, { duration: DURATION.quick, easing: EASE.press });
    })
    .onUpdate((e) => {
      x.value = Math.min(travel, Math.max(0, e.x - THUMB / 2));
    })
    .onFinalize(() => {
      held.value = reduceMotion
        ? 0
        : withTiming(0, { duration: DURATION.quick, easing: EASE.press });
      settle(Math.round((x.value / travel) * last));
    });
  const press = Gesture.Tap().onEnd((e) => {
    const i = Math.round((Math.min(travel, Math.max(0, e.x - THUMB / 2)) / travel) * last);
    settle(i);
    scheduleOnRN(pick, i);
  });

  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { scale: 1 + held.value * 0.15 }],
  }));
  const fill = useAnimatedStyle(() => ({ width: x.value + THUMB / 2 }));

  return (
    <View>
      <View style={styles.head}>
        <Text style={styles.label}>Leverage</Text>
        <Text style={styles.value}>{value}x</Text>
      </View>
      <GestureDetector gesture={Gesture.Exclusive(drag, press)}>
        <View
          style={styles.track}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Leverage"
          accessibilityValue={{ text: `${value}x` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            const i = Math.min(
              last,
              Math.max(0, index + (e.nativeEvent.actionName === 'increment' ? 1 : -1)),
            );
            onChange(stops[i]);
          }}
        >
          <View style={styles.rail} />
          <Animated.View style={[styles.railFill, fill]} />
          {stops.map((s, i) => (
            <View
              key={s}
              style={[
                styles.stop,
                { left: THUMB / 2 + (i / last) * travel - 3 },
                i <= index && styles.stopOn,
              ]}
            />
          ))}
          <Animated.View style={[styles.thumb, thumb]} />
        </View>
      </GestureDetector>
      <View style={styles.marks}>
        {stops.map((s) => (
          <Text key={s} style={[styles.mark, s === value && styles.markOn]}>
            {s}x
          </Text>
        ))}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  label: {
    color: c.textSecondary,
    fontSize: 15,
  },
  value: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  track: {
    marginTop: 8,
    height: THUMB + 8,
    justifyContent: 'center',
  },
  rail: {
    position: 'absolute',
    left: THUMB / 2,
    right: THUMB / 2,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.raised,
  },
  railFill: {
    position: 'absolute',
    left: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.primary,
  },
  stop: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.divider,
  },
  stopOn: {
    backgroundColor: c.primary,
  },
  thumb: {
    position: 'absolute',
    left: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: c.sheet,
    borderWidth: 2,
    borderColor: c.primary,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  marks: {
    marginTop: 2,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  mark: {
    minWidth: THUMB,
    color: c.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  markOn: {
    color: c.text,
    fontWeight: '600',
  },
}));
