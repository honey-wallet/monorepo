// The menu grows out of the footer button that opens it: from its bottom-right corner,
// 0.97 → 1 with a fade (200ms, strong ease-out), and closes faster (150ms).
// Retargeting the same surface keeps rapid toggles continuous. Under Reduce Motion it only fades.
import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/Icon';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';
import { PressableRow } from './PressableRow';

export type PopoverAction = { label: string; icon: IconName; onPress: () => void };

/**
 * A menu of large actions that opens above a footer button, like Uniswap's token
 * page. The parent owns `open` so its trigger can stay visible and swap to ✕;
 * render this as a sibling placed before the footer, so the footer stays on top.
 */
export function PopoverMenu({
  open,
  onClose,
  actions,
  bottom,
  right,
}: {
  open: boolean;
  onClose: () => void;
  actions: PopoverAction[];
  /** Distance from the screen's bottom edge to the menu's bottom edge. */
  bottom: number;
  right: number;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, {
      duration: open ? DURATION.fast : DURATION.quick,
      easing: reduceMotion ? EASE.ease : EASE.smoothOut,
      reduceMotion: ReduceMotion.Never,
    });
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), DURATION.quick);
    return () => clearTimeout(timer);
  }, [open, reduceMotion, progress]);
  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: reduceMotion ? 1 : 0.97 + 0.03 * progress.value }],
  }));
  if (!mounted) return null;
  return (
    <>
      {open && (
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close menu" />
      )}
      <Animated.View
        pointerEvents={open ? 'auto' : 'none'}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
        accessibilityRole="menu"
        style={[styles.menu, { bottom, right }, animated]}
      >
        {actions.map((action) => (
          <PressableRow
            key={action.label}
            accessibilityRole="menuitem"
            onPress={() => {
              tap();
              onClose();
              action.onPress();
            }}
            style={styles.item}
          >
            <Icon name={action.icon} size={22} color={c.accentText} />
            <Text style={styles.label}>{action.label}</Text>
          </PressableRow>
        ))}
      </Animated.View>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  menu: {
    position: 'absolute',
    minWidth: 220,
    paddingVertical: 8,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: c.divider,
    backgroundColor: c.card,
    transformOrigin: 'right bottom',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    height: 56,
    marginHorizontal: 8,
    paddingHorizontal: 14,
    // Keeps the press highlight inside the menu's rounded corners.
    borderRadius: 16,
  },
  label: {
    color: c.text,
    fontSize: 18,
    fontWeight: '600',
  },
}));
