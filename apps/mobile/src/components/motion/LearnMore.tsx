// Press feedback for a "Learn more ›" link: while the link (or the card it sits in) is
// pressed, the chevron nudges 2px toward the reading direction and its arms open 6°,
// pointing where the tap leads. It's felt more than seen: 150ms on the press curve,
// back on a strong ease-out. Off under Reduce Motion (it's movement, not information).
import { useEffect } from 'react';
import { type StyleProp, Text, type TextStyle, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { DURATION, EASE } from '@/theme/motion';

const SHIFT = 2;
const SPREAD = 6;

const W = 7;
const H = 11;
// Both arms meet at the tip, at the right middle of the box.
const ORIGIN: ViewStyle = { position: 'absolute', transformOrigin: [W - 1, H / 2, 0] };

/**
 * A "Learn more ›" style label with a drawn chevron that acknowledges presses.
 * `active` is the press state of whatever is tappable around it.
 */
export function LearnMore({
  label,
  active,
  color,
  style,
}: {
  label: string;
  active: boolean;
  color: string;
  style?: StyleProp<TextStyle>;
}) {
  const reduceMotion = useReducedMotion();
  const p = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    p.value = withTiming(active ? 1 : 0, {
      duration: DURATION.quick,
      easing: active ? EASE.press : EASE.smoothOut,
    });
  }, [active, reduceMotion, p]);

  const shift = useAnimatedStyle(() => ({ transform: [{ translateX: SHIFT * p.value }] }));
  const upper = useAnimatedStyle(() => ({ transform: [{ rotate: `${SPREAD * p.value}deg` }] }));
  const lower = useAnimatedStyle(() => ({ transform: [{ rotate: `${-SPREAD * p.value}deg` }] }));

  const arm = (d: string) => (
    <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <Path d={d} stroke={color} strokeWidth={1.6} strokeLinecap="round" fill="none" />
    </Svg>
  );

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <Text style={[style, { color }]}>{label}</Text>
      <Animated.View style={[{ width: W, height: H }, shift]}>
        <Animated.View style={[ORIGIN, upper]}>{arm(`M1 1L${W - 1} ${H / 2}`)}</Animated.View>
        <Animated.View style={[ORIGIN, lower]}>
          {arm(`M${W - 1} ${H / 2}L1 ${H - 1}`)}
        </Animated.View>
      </Animated.View>
    </View>
  );
}
