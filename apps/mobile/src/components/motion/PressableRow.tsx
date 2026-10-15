// Press feedback for list rows. Rows are tapped constantly, so the highlight is near
// instant: it appears in 80ms and fades back in 150ms (plain ease, since only the
// colour changes).
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
        pressed.value = withTiming(1, { duration: DURATION.micro, easing: EASE.ease });
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.value = withTiming(0, { duration: DURATION.quick, easing: EASE.ease });
        onPressOut?.(event);
      }}
      style={[style, animatedStyle]}
    />
  );
}
