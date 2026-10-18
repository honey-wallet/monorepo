import { View } from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { makeStyles } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

/**
 * A row of page dots, the current one widened into a short bar: where you are in a
 * guide's steps, or in a sideways row that scrolls (so it's clear there's more).
 */
export function PageDots({
  count,
  index,
  label,
}: {
  count: number;
  index: number;
  /** Read instead of the dots, e.g. "Step 2 of 3". */
  label?: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.dots} accessible={!!label} accessibilityLabel={label}>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: dots are positions, never reordered
        <Dot key={i} active={i === index} />
      ))}
    </View>
  );
}

/** A page dot that widens into a short bar when active. */
export function Dot({ active }: { active: boolean }) {
  const styles = useStyles();
  const style = useAnimatedStyle(() => ({
    // The dot reshapes in place, so ease-in-out.
    width: withTiming(active ? 18 : 6, { duration: DURATION.fast, easing: EASE.inOut }),
    opacity: withTiming(active ? 1 : 0.35, { duration: DURATION.fast, easing: EASE.ease }),
  }));
  return <Animated.View style={[styles.dot, style]} />;
}

const useStyles = makeStyles((c) => ({
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    height: 6,
    borderRadius: 3,
    backgroundColor: c.text,
  },
}));
