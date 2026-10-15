// Motion: transitions.dev "Menu dropdown" (https://transitions.dev), ported to
// Reanimated. The menu grows from the corner nearest its trigger (0.97 → 1, 250ms)
// and closes faster (→ 0.99, 150ms), both on the smooth ease-out curve.
import { Pressable, Text } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/Icon';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE, lazy } from '@/theme/motion';
import { PressableRow } from './PressableRow';

export type PopoverAction = { label: string; icon: IconName; onPress: () => void };

const enter = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ scale: 0.97 }] },
    100: { opacity: 1, transform: [{ scale: 1 }], easing: EASE.smoothOut },
  }).duration(DURATION.fast),
);

const exit = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ scale: 1 }] },
    100: { opacity: 0, transform: [{ scale: 0.99 }], easing: EASE.smoothOut },
  }).duration(DURATION.quick),
);

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
  if (!open) return null;
  return (
    <>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close menu" />
      <Animated.View
        entering={enter()}
        exiting={exit()}
        accessibilityRole="menu"
        style={[styles.menu, { bottom, right }]}
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
