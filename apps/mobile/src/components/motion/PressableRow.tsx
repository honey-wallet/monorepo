// Press feedback for list rows: the row's background fades to a highlight on the
// transitions.dev quick clock and fades back on the fast clock (smooth ease-out).
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle> };

/** A tappable list row. Rows run edge to edge; pass horizontal padding in `style`. */
export function PressableRow({ style, onPressIn, onPressOut, ...props }: Props) {
  const c = useTheme();
  const pressed = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(pressed.value, [0, 1], ['transparent', c.raised]),
  }));
  return (
    <AnimatedPressable
      {...props}
      onPressIn={(event) => {
        pressed.value = withTiming(1, { duration: DURATION.quick, easing: EASE.smoothOut });
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.value = withTiming(0, { duration: DURATION.fast, easing: EASE.smoothOut });
        onPressOut?.(event);
      }}
      style={[style, animatedStyle]}
    />
  );
}
