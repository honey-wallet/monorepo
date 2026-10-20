// Direct manipulation: press and drag on the card and it leans toward your finger in 3D
// (up to 14° at the edges), tracking the finger 1:1 with no easing, while a soft glare
// follows the touch. Let go and it settles flat on a spring that carries the finger's
// last tilt, with the slight overshoot a released drag earns. Flat under Reduce Motion
// (the glare is decoration). The screen blend mode is omitted (no iOS blend modes).
import type { ReactNode } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import { squircle } from '@/theme';
import { DURATION, EASE, SPRING } from '@/theme/motion';

const MAX = 14;
const PERSPECTIVE = 1000;
const GLARE_FADE = { duration: DURATION.fast, easing: EASE.ease };
const GLARE_OPACITY = 0.32;
/** The glare's outer radius, as in the recipe's widest layer. */
const GLARE = 200;

/** A card that tilts toward a pressed finger, e.g. the My QR code. */
export function TiltCard({
  children,
  radius = 16,
  style,
}: {
  children: ReactNode;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReducedMotion();
  const size = useSharedValue({ width: 1, height: 1 });
  const rx = useSharedValue(0);
  const ry = useSharedValue(0);
  const gx = useSharedValue(0);
  const gy = useSharedValue(0);
  const glare = useSharedValue(0);

  const track = (x: number, y: number) => {
    'worklet';
    const px = Math.min(1, Math.max(0, x / size.value.width));
    const py = Math.min(1, Math.max(0, y / size.value.height));
    ry.value = (px - 0.5) * MAX;
    rx.value = (0.5 - py) * MAX;
    gx.value = x;
    gy.value = y;
    glare.value = withTiming(GLARE_OPACITY, GLARE_FADE);
  };
  const reset = () => {
    'worklet';
    rx.value = withSpring(0, SPRING.release);
    ry.value = withSpring(0, SPRING.release);
    glare.value = withTiming(0, GLARE_FADE);
  };

  // Starts on touch (no drag distance needed), like the recipe's pointerdown.
  const pan = Gesture.Pan()
    .enabled(!reduceMotion)
    .minDistance(0)
    .onBegin((e) => track(e.x, e.y))
    .onUpdate((e) => track(e.x, e.y))
    .onFinalize(reset);

  const card = useAnimatedStyle(() => ({
    transform: [
      { perspective: PERSPECTIVE },
      { rotateX: `${rx.value}deg` },
      { rotateY: `${ry.value}deg` },
    ],
  }));
  const light = useAnimatedStyle(() => ({
    opacity: glare.value,
    transform: [{ translateX: gx.value - GLARE }, { translateY: gy.value - GLARE }],
  }));

  return (
    <GestureDetector gesture={pan}>
      {/* The flat hit area never transforms; only the card inside it tilts. */}
      <View
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          size.value = { width, height };
        }}
        style={style}
      >
        <Animated.View style={[{ borderRadius: radius, ...squircle, overflow: 'hidden' }, card]}>
          {children}
          <Animated.View
            pointerEvents="none"
            style={[
              { position: 'absolute', top: 0, left: 0, width: GLARE * 2, height: GLARE * 2 },
              light,
            ]}
          >
            <Svg width={GLARE * 2} height={GLARE * 2}>
              <Defs>
                <RadialGradient id="tiltGlare" cx="50%" cy="50%" r="50%">
                  <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.6} />
                  <Stop offset="0.25" stopColor="#FFFFFF" stopOpacity={0.24} />
                  <Stop offset="0.6" stopColor="#FFFFFF" stopOpacity={0.06} />
                  <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Circle cx={GLARE} cy={GLARE} r={GLARE} fill="url(#tiltGlare)" />
            </Svg>
          </Animated.View>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
