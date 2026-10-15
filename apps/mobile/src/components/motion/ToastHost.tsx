// Motion: transitions.dev "Toast open/close" (https://transitions.dev), ported to
// Reanimated. Rises 16px with a fade and a 0.97 → 1 scale on the slower open clock
// (350ms); leaves on the faster close clock (250ms). The 2px blur is omitted.
import { Text } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import { useToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE, lazy } from '@/theme/motion';

/** The toast floats this far above the tab bar, so it never covers it. */
const GAP_ABOVE_TAB_BAR = 18;

const DISTANCE = 16;
const SCALE = 0.97;

const open = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: DISTANCE }, { scale: SCALE }] },
    100: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }], easing: EASE.smoothOut },
  }).duration(DURATION.medium),
);

const close = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
    100: {
      opacity: 0,
      transform: [{ translateY: DISTANCE }, { scale: SCALE }],
      easing: EASE.smoothOut,
    },
  }).duration(DURATION.fast),
);

/** Renders the current toast above the tab bar. Mount once, at the root. */
export function ToastHost() {
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  if (!toast) return null;
  return (
    <Animated.View
      key={toast.id}
      entering={open()}
      exiting={close()}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[styles.toast, { bottom: insets.bottom + TAB_BAR_HEIGHT + GAP_ABOVE_TAB_BAR }]}
    >
      <Icon name="check" size={14} color={c.success} />
      <Text style={styles.message}>{toast.message}</Text>
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    height: 44,
    borderRadius: 22,
    backgroundColor: c.raised,
    borderWidth: 1,
    borderColor: c.divider,
  },
  message: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
}));
