// Motion: transitions.dev "Like button" (https://transitions.dev), ported to
// Reanimated. On like the heart fills (150ms), pops 1 → 0.82 → 1 (350ms, overshoot)
// and eight particles fly 20px out and fade (600ms). Unliking only reverses the fill.
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
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

const POP_EASE = Easing.bezier(0.34, 1.96, 0.64, 1);
const PARTICLES = 8;
const DISTANCE = 20;

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
        withTiming(0.82, { duration: DURATION.medium * 0.3 }),
        withTiming(1, { duration: DURATION.medium * 0.7, easing: POP_EASE }),
      );
      burst.value = 0;
      burst.value = withTiming(1, { duration: 600, easing: Easing.out(Easing.quad) });
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
