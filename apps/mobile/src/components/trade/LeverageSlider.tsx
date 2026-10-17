// Motion: leverage is picked by dragging a thumb along a thin track with a dot at each
// stop. The thumb follows the finger 1:1 (direct manipulation, no easing), grows a
// little while held, and on release settles onto the nearest stop on the release
// spring (the slight overshoot a drag earns). Each stop passed ticks a haptic; a tap
// on the track jumps to that stop. Under Reduce Motion the thumb moves without the
// spring or the grow.
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
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
  const dragging = useSharedValue(false);
  const selected = useSharedValue(index);
  const measuredWidth = useRef(0);

  // Placed at the current stop once the track is measured, and whenever it changes.
  useEffect(() => {
    // Not while held: the finger is moving it, and picking stops changes `index`.
    if (!width || dragging.get()) return;
    if (selected.get() === index && measuredWidth.current === width) return;
    measuredWidth.current = width;
    selected.set(index);
    x.set((index / last) * travel);
  }, [width, index, last, travel, x, dragging, selected]);

  const pick = (i: number) => {
    tap();
    onChange(stops[i]);
  };
  const settle = (i: number, velocity = 0) => {
    'worklet';
    const to = (i / last) * travel;
    x.set(reduceMotion ? to : withSpring(to, { ...SPRING.release, velocity }));
  };
  const drag = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .failOffsetY([-10, 10])
    .onStart(() => {
      cancelAnimation(x);
      dragging.set(true);
      held.set(reduceMotion ? 0 : withTiming(1, { duration: DURATION.micro, easing: EASE.press }));
    })
    .onUpdate((e) => {
      const next = Math.min(travel, Math.max(0, e.x - THUMB / 2));
      x.set(next);
      const i = Math.round((next / travel) * last);
      if (i !== selected.get()) {
        selected.set(i);
        scheduleOnRN(pick, i);
      }
    })
    .onFinalize((e) => {
      if (!dragging.get()) return;
      dragging.set(false);
      held.set(reduceMotion ? 0 : withTiming(0, { duration: DURATION.quick, easing: EASE.press }));
      settle(selected.get(), e.velocityX);
    });
  const press = Gesture.Tap().onEnd((e, finished) => {
    if (!finished) return;
    const i = Math.round((Math.min(travel, Math.max(0, e.x - THUMB / 2)) / travel) * last);
    x.set((i / last) * travel);
    if (i !== selected.get()) {
      selected.set(i);
      scheduleOnRN(pick, i);
    }
  });

  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { scale: reduceMotion ? 1 : 1 + held.get() * 0.08 }],
  }));
  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: x.get() / travel }] }));

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
            if (i !== index) pick(i);
          }}
        >
          <View style={styles.rail} />
          <Animated.View style={[styles.railFill, { width: travel }, fill]} />
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
    height: 44,
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
    left: THUMB / 2,
    transformOrigin: 'left center',
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
