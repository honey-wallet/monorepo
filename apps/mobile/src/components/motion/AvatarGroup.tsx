// Press feedback for a stack of coins or avatars inside a row people tap often, so it
// stays small: while pressed, the focused item lifts 3px and grows to 1.02, and its
// neighbours lift less with distance (falloff 0.45). Up and back on a critically damped
// spring (no bounce, which would be decoration on a frequent action); being a spring,
// a quick tap that reverses mid-lift settles smoothly. Off under Reduce Motion.
import { Children, type ReactNode, useEffect } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { SPRING } from '@/theme/motion';

const LIFT = -3;
const SCALE = 1.02;
const FALLOFF = 0.45;
const LIFT_SPRING = { ...SPRING.ui, duration: 200 };

/**
 * A horizontal stack (coins, avatars) that lifts while `lifted`, centred on `focus`
 * (the middle item by default). Children keep their own size, overlap and borders.
 */
export function AvatarGroup({
  lifted,
  focus,
  style,
  children,
}: {
  lifted: boolean;
  focus?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const items = Children.toArray(children);
  const center = focus ?? Math.floor(items.length / 2);
  return (
    <View style={[{ flexDirection: 'row' }, style]}>
      {items.map((child, i) => (
        <Lift
          // biome-ignore lint/suspicious/noArrayIndexKey: the stack is static; position is identity.
          key={i}
          lifted={lifted}
          distance={Math.abs(i - center)}
          zIndex={items.length - i}
        >
          {child}
        </Lift>
      ))}
    </View>
  );
}

function Lift({
  lifted,
  distance,
  zIndex,
  children,
}: {
  lifted: boolean;
  distance: number;
  zIndex: number;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const shift = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) return;
    shift.value = withSpring(lifted ? LIFT * FALLOFF ** distance : 0, LIFT_SPRING);
    scale.value = withSpring(lifted && distance === 0 ? SCALE : 1, LIFT_SPRING);
  }, [lifted, distance, reduceMotion, shift, scale]);

  // translateY before scale, so the scale doesn't amplify the lift.
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: shift.value }, { scale: scale.value }],
  }));

  return <Animated.View style={[{ zIndex }, style]}>{children}</Animated.View>;
}
