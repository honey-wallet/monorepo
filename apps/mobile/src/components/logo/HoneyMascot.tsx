// Motion: the welcome screen's honey is alive but calm, an ambient loop that never
// asks for attention. Every few seconds it glances left, then right, then back
// (ease-in-out, since the eyes are already on screen), and blinks, sometimes twice.
// It's the one screen a new user lingers on, so it may take its time; nothing else
// on the screen moves. Under Reduce Motion it stays still (decorative motion only).
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { EYES_PATH, MARK_VIEWBOX, RING_PATH } from '@/components/logo/paths';
import { useTheme } from '@/theme';
import { EASE } from '@/theme/motion';

const EYES = '#4B2817';

/** How far the eyes travel when they glance, as a fraction of the mark's width. */
const GLANCE = 0.035;

const look = (to: number, duration: number) => withTiming(to, { duration, easing: EASE.inOut });
const shut = () =>
  withSequence(withTiming(0.1, { duration: 70 }), withTiming(1, { duration: 110 }));

/** The Honey mark, looking around and blinking. `width` sets its size. */
export function HoneyMascot({ width = 160 }: { width?: number }) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const height = (width * 350) / 400;
  const glance = width * GLANCE;
  const x = useSharedValue(0);
  const blink = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) return;
    // One 6.4s cycle: rest, glance left, glance right, back to centre, blink; then a
    // rest and a double blink, so the rhythm doesn't feel mechanical.
    x.value = withRepeat(
      withSequence(
        withDelay(1400, look(-glance, 320)),
        withDelay(700, look(glance, 460)),
        withDelay(800, look(0, 320)),
        withDelay(2400, look(0, 0)),
      ),
      -1,
    );
    blink.value = withRepeat(
      withSequence(
        withDelay(600, shut()),
        withDelay(3700, shut()),
        withDelay(120, shut()),
        withDelay(1100, withTiming(1, { duration: 0 })),
      ),
      -1,
    );
    return () => {
      cancelAnimation(x);
      cancelAnimation(blink);
    };
  }, [reduceMotion, glance, x, blink]);

  const eyes = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { scaleY: blink.value }],
  }));

  return (
    <View style={{ width, height }} accessible accessibilityLabel="Honey">
      <Svg width={width} height={height} viewBox={MARK_VIEWBOX}>
        <Path fill={c.brandYellow} fillRule="evenodd" d={RING_PATH} />
      </Svg>
      {/* Eyes on their own layer so they can move and blink; origin at their centre. */}
      <Animated.View
        style={[
          { position: 'absolute', top: 0, left: 0, transformOrigin: ['50%', '12%', 0] },
          eyes,
        ]}
      >
        <Svg width={width} height={height} viewBox={MARK_VIEWBOX}>
          <Path fill={EYES} d={EYES_PATH} />
        </Svg>
      </Animated.View>
    </View>
  );
}
