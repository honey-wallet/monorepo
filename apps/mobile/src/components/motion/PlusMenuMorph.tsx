// The round + grows into the menu it opens, from the corner it sits in (top-right), so
// the menu clearly comes from the button. The box widens, lengthens and relaxes its
// corners on a critically damped spring (300ms, no overshoot; a morph is serious UI,
// and a spring stays smooth if it's reversed mid-way); closing is quicker (200ms).
// The + turns into the close position and fades early while the items fade in with an
// 8px hint from the right. Under Reduce Motion the box appears at full size and the
// contents only fade.
import { type ReactNode, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DISTANCE, DURATION, EASE, SPRING } from '@/theme/motion';

const OPEN = SPRING.ui;
const CLOSE = { ...SPRING.ui, duration: DURATION.fast };
const SLIDE = DISTANCE.base;
const SCALE = 0.97;

const BUTTON = 30;
const MENU_WIDTH = 220;
const ROW = 48;
const PAD = 6;
const HEADER = 40;

export type PlusMenuItem = { label: string; leading: ReactNode; onPress: () => void };

/**
 * A round + that morphs into a small menu of `items`, anchored at its top-right
 * corner so it opens over the content below. Place it where the + should sit; it
 * keeps the button's footprint in the layout.
 */
export function PlusMenuMorph({
  label,
  title,
  items,
}: {
  /** Accessibility label for the closed button, e.g. "Add". */
  label: string;
  /** Shown at the top of the open menu. */
  title: string;
  items: PlusMenuItem[];
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  // `progress` drives the shape; `shown` the contents' fade, on its own shorter clock.
  const progress = useSharedValue(0);
  const shown = useSharedValue(0);
  const height = HEADER + items.length * ROW + PAD;

  useEffect(() => {
    if (reduceMotion) progress.value = open ? 1 : 0;
    else progress.value = withSpring(open ? 1 : 0, open ? OPEN : CLOSE);
    shown.value = withTiming(open ? 1 : 0, {
      duration: open ? DURATION.fast : DURATION.quick,
      easing: EASE.ease,
    });
  }, [open, reduceMotion, progress, shown]);

  const toggle = (next: boolean) => {
    tap();
    setOpen(next);
  };

  const surface = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [BUTTON, MENU_WIDTH]),
    height: interpolate(progress.value, [0, 1], [BUTTON, height]),
    borderRadius: interpolate(progress.value, [0, 1], [BUTTON / 2, 20]),
  }));
  const plus = useAnimatedStyle(() => ({
    opacity: interpolate(shown.value, [0, 0.5], [1, 0], 'clamp'),
    transform: [
      { translateX: -SLIDE * progress.value },
      { rotate: `${45 * progress.value}deg` },
      { scale: interpolate(progress.value, [0, 1], [1, SCALE]) },
    ],
  }));
  const menu = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [
      { translateX: SLIDE * (1 - progress.value) },
      { scale: interpolate(progress.value, [0, 1], [SCALE, 1]) },
    ],
  }));

  return (
    <View style={styles.anchor}>
      <Animated.View style={[styles.surface, surface]}>
        <Animated.View
          style={[styles.menu, { width: MENU_WIDTH, height }, menu]}
          pointerEvents={open ? 'auto' : 'none'}
          accessibilityElementsHidden={!open}
        >
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={10}
              onPress={() => toggle(false)}
              style={styles.close}
            >
              <Icon name="close" size={13} color={c.accentText} />
            </Pressable>
          </View>
          {items.map((item) => (
            <Pressable
              key={item.label}
              accessibilityRole="button"
              onPress={() => {
                toggle(false);
                item.onPress();
              }}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              {item.leading}
              <Text style={styles.rowLabel}>{item.label}</Text>
            </Pressable>
          ))}
        </Animated.View>
        <Animated.View style={[styles.plus, plus]} pointerEvents={open ? 'none' : 'auto'}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ expanded: open }}
            hitSlop={10}
            onPress={() => toggle(true)}
            style={styles.plusHit}
          >
            <Icon name="plus" size={14} color={c.accentText} />
          </Pressable>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  // Holds the closed button's footprint; the open surface overflows it.
  anchor: {
    width: BUTTON,
    height: BUTTON,
    zIndex: 10,
  },
  surface: {
    position: 'absolute',
    top: 0,
    right: 0,
    overflow: 'hidden',
    backgroundColor: c.accentSurface,
  },
  menu: {
    position: 'absolute',
    top: 0,
    right: 0,
    paddingBottom: PAD,
  },
  header: {
    height: HEADER,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 8,
  },
  title: {
    color: c.accentText,
    fontSize: 14,
    fontWeight: '600',
  },
  close: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    height: ROW,
    marginHorizontal: PAD,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 14,
  },
  rowPressed: {
    backgroundColor: `${c.accentText}1A`,
  },
  rowLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
  plus: {
    position: 'absolute',
    top: 0,
    right: 0,
  },
  plusHit: {
    width: BUTTON,
    height: BUTTON,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
