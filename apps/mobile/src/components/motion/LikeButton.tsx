// Motion: favouriting a token is occasional, so it earns a small moment of delight,
// kept quiet: the heart fills (150ms), dips to 0.9 and settles back to 1 (250ms,
// ease-out, no overshoot), and eight particles drift 16px out and fade (400ms).
// Unliking only reverses the fill. Under Reduce Motion only the fill crossfades.
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const PARTICLES = 8;
const DISTANCE = 16;

type Props = { liked: boolean; onToggle: () => void; size?: number };

export function LikeButton({ liked, onToggle, size = 24 }: Props) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const fill = useSharedValue(liked ? 1 : 0);
  const scale = useSharedValue(1);
  const burst = useSharedValue(0);

  useEffect(() => {
    fill.value = withTiming(liked ? 1 : 0, { duration: DURATION.quick, easing: EASE.smoothOut });
  }, [liked, fill]);

  const press = () => {
    tap();
    if (!liked && !reduceMotion) {
      scale.value = withSequence(
        withTiming(0.9, { duration: DURATION.micro, easing: EASE.press }),
        withTiming(1, { duration: DURATION.medium - DURATION.micro, easing: EASE.smoothOut }),
      );
      burst.value = 0;
      burst.value = withTiming(1, { duration: DURATION.verySlow, easing: EASE.smoothOut });
    }
    onToggle();
  };

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const filledStyle = useAnimatedStyle(() => ({ opacity: fill.value }));

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={liked ? 'Remove from favourites' : 'Add to favourites'}
      accessibilityState={{ selected: liked }}
      hitSlop={10}
      scaleTo={1}
      onPress={press}
    >
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        {Array.from({ length: PARTICLES }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed set of particles; the index is the identity.
          <Particle key={i} angle={(i / PARTICLES) * Math.PI * 2} burst={burst} color={c.primary} />
        ))}
        <Animated.View style={iconStyle}>
          <Icon name="heart" size={size} color={c.textSecondary} />
          <Animated.View style={[{ position: 'absolute' }, filledStyle]}>
            <Icon name="heartFill" size={size} color={c.primary} />
          </Animated.View>
        </Animated.View>
      </View>
    </PressableScale>
  );
}

function Particle({
  angle,
  burst,
  color,
}: {
  angle: number;
  burst: ReturnType<typeof useSharedValue<number>>;
  color: string;
}) {
  const style = useAnimatedStyle(() => {
    const t = burst.value;
    // Fade in over the first 20%, then out; travel the whole way.
    const opacity = t === 0 || t === 1 ? 0 : t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
    return {
      opacity,
      transform: [
        { translateX: Math.cos(angle) * DISTANCE * t },
        { translateY: Math.sin(angle) * DISTANCE * t },
        { scale: 0.4 + Math.min(t / 0.2, 1) * 0.6 - Math.max(t - 0.2, 0) * 0.5 },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', width: 4, height: 4, borderRadius: 2, backgroundColor: color },
        style,
      ]}
    />
  );
}
