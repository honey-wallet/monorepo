// Motion: a tray is a card that floats a little above the bottom edge and rises over
// the screen. It enters on the iOS sheet curve (300ms) while the backdrop fades in,
// and leaves the same way down, faster (200ms). When its content changes (the next
// step of a flow) the card's height eases to fit (250ms, snappy ease-out), so one tray
// grows or shrinks instead of a new one appearing. Dragging it down follows the
// finger; let go past a third of its height, or flick, and it closes, otherwise it
// springs back with a slight overshoot. Under Reduce Motion it fades instead of
// sliding, and the height changes at once.
import { usePreventRemove } from 'expo-router/react-navigation';
import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  ReduceMotion,
  runOnJS,
  useAnimatedKeyboard,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { isWeb } from '@/lib/platform';
import { trayOpened } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE, SPRING } from '@/theme/motion';

/** Gap between the tray and the screen's sides and bottom. */
export const TRAY_INSET = 10;
const RADIUS = 40;
/** The close button's corner of the tray, kept clear by tray headers. */
export const TRAY_CLOSE = { size: 32, top: 18, right: 20 } as const;
/**
 * Only the extension shows the close button: a popup has no swipe and little room to click
 * outside. On the phone a tray closes the iOS way, by dragging it down or tapping outside.
 */
export const TRAY_SHOWS_CLOSE = isWeb;
const ENTER = { duration: DURATION.slow, easing: EASE.sheet } as const;
const EXIT = {
  duration: DURATION.fast,
  easing: EASE.smoothOut,
  reduceMotion: ReduceMotion.Never,
} as const;
const RESIZE = { duration: DURATION.medium, easing: EASE.height } as const;

/** True inside a tray, so sheet frames drop the grabber gap and leave room for the close button. */
const TrayContext = createContext(false);
export const useInTray = () => useContext(TrayContext);

/**
 * The tray itself: backdrop, floating card, close button, drag to dismiss. `open`
 * false plays the exit, then `onExited`. `onClose` is any request to close (button,
 * backdrop, drag); the owner decides what closing means.
 */
function TrayFrame({
  open,
  onClose,
  onExited,
  dismissible = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onExited?: () => void;
  /** False for a step that must finish (a send in flight): no close button, drag or backdrop tap. */
  dismissible?: boolean;
  children: ReactNode;
}) {
  const styles = useStyles();
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screen } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const keyboard = useAnimatedKeyboard();

  const maxHeight = screen - insets.top - 24;
  const height = useSharedValue(0);
  const shown = useSharedValue(0); // 0 hidden, 1 in place: drives slide and backdrop.
  const drag = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const ownsDrag = useSharedValue(false);
  const scrollY = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  // Keep the top edge below the safe area when the keyboard lifts the card.
  // The scroll view takes over once the content no longer fits this viewport.
  const viewport = useDerivedValue(() => {
    const lift = Math.max(0, keyboard.height.value + 8 - TRAY_INSET);
    return Math.min(height.value, Math.max(1, maxHeight - lift));
  });
  const measured = useRef(false);

  // Toasts shown while it's open go to the top, clear of its title.
  useEffect(() => (open ? trayOpened() : undefined), [open]);

  const onContent = (e: LayoutChangeEvent) => {
    const natural = e.nativeEvent.layout.height;
    const h = Math.min(natural, maxHeight);
    contentHeight.value = natural;
    if (!measured.current) {
      measured.current = true;
      height.value = h;
      if (open) shown.value = withTiming(1, reduceMotion ? EXIT : ENTER);
      return;
    }
    height.value = reduceMotion ? h : withTiming(h, RESIZE);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: onExited is read when the exit ends; a new callback mustn't replay it.
  useEffect(() => {
    if (open) {
      if (measured.current) shown.value = withTiming(1, reduceMotion ? EXIT : ENTER);
      return;
    }
    const done = () => onExited?.();
    shown.value = withTiming(0, EXIT, (finished) => {
      if (finished) runOnJS(done)();
    });
  }, [open, reduceMotion, shown]);

  const nativeScroll = Gesture.Native();
  const pan = Gesture.Pan()
    .enabled(dismissible && open)
    .simultaneousWithExternalGesture(nativeScroll)
    .activeOffsetY(10)
    .failOffsetY(-10)
    .failOffsetX([-20, 20])
    .onBegin(() => {
      // Decide ownership before scrolling reaches zero: a fling inside a list
      // must not turn into a dismissal halfway through the same touch.
      ownsDrag.value = contentHeight.value <= viewport.value || scrollY.value <= 0;
    })
    .onStart(() => {
      if (!ownsDrag.value) return;
      cancelAnimation(drag);
      dragStart.value = drag.value;
    })
    .onUpdate((e) => {
      if (!ownsDrag.value) return;
      const next = dragStart.value + e.translationY;
      drag.value = next > 0 ? next : next * 0.15;
    })
    .onEnd((e) => {
      if (!ownsDrag.value) return;
      if (drag.value > viewport.value / 3 || e.velocityY > 900) {
        runOnJS(onClose)();
      } else {
        drag.value = reduceMotion ? 0 : withSpring(0, { ...SPRING.release, velocity: e.velocityY });
      }
    })
    .onFinalize((_e, finished) => {
      if (!finished && ownsDrag.value)
        drag.value = reduceMotion ? 0 : withSpring(0, SPRING.release);
      ownsDrag.value = false;
    });

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  const backdrop = useAnimatedStyle(() => ({
    opacity: shown.value * (1 - Math.min(1, Math.max(0, drag.value) / Math.max(1, viewport.value))),
  }));
  const card = useAnimatedStyle(() => {
    const offscreen = height.value + TRAY_INSET + 40;
    const lift = Math.max(TRAY_INSET, keyboard.height.value + 8);
    return {
      height: viewport.value,
      bottom: TRAY_INSET,
      opacity: reduceMotion ? shown.value : 1,
      transform: [
        {
          translateY:
            (reduceMotion ? 0 : (1 - shown.value) * offscreen) + drag.value - (lift - TRAY_INSET),
        },
      ],
    };
  });

  return (
    <TrayContext.Provider value>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdrop]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={dismissible ? onClose : undefined}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            accessibilityViewIsModal
            onAccessibilityEscape={dismissible ? onClose : undefined}
            style={[styles.card, card]}
          >
            <GestureDetector gesture={nativeScroll}>
              <Animated.ScrollView
                style={StyleSheet.absoluteFill}
                onScroll={onScroll}
                scrollEventThrottle={16}
                bounces={false}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                <View onLayout={onContent}>{children}</View>
              </Animated.ScrollView>
            </GestureDetector>
            {dismissible && TRAY_SHOWS_CLOSE ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={10}
                onPress={onClose}
                style={styles.close}
              >
                <Icon name="close" size={14} color={c.textSecondary} />
              </PressableScale>
            ) : null}
          </Animated.View>
        </GestureDetector>
      </View>
    </TrayContext.Provider>
  );
}

type Navigation = {
  goBack: () => void;
  dispatch: (action: never) => void;
  getState: () => { key: string; routes: { key: string }[] };
};

/**
 * Wraps a screen presented as a tray (see `tray()` in the root layout). Every way out
 * (the close button, a drag, the backdrop, or code calling `router.back()`) plays the
 * same exit before the screen is removed.
 */
export function Tray({
  navigation,
  routeKey,
  children,
}: {
  navigation: Navigation;
  routeKey: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const pending = useRef<{ type: string; source?: string } | null>(null);
  const { dispatch } = navigation;
  // Hold every removal until the tray has slid away, then let it through.
  usePreventRemove(open, ({ data }) => {
    pending.current = data.action as { type: string; source?: string };
    setOpen(false);
  });
  const onExited = useCallback(() => {
    const action = pending.current;
    if (!action) return;
    // Something else (opening the next screen) already took the tray away: nothing left to do.
    const state = navigation.getState();
    if (!state.routes.some((r) => r.key === routeKey)) return;
    // A plain "back" is aimed at this tray: flows that close the tray and open the next
    // screen (back, then push) would otherwise pop that new screen once the exit ends.
    const own =
      action.type === 'GO_BACK' || action.type === 'POP'
        ? { ...action, source: routeKey, target: state.key }
        : action;
    dispatch(own as never);
  }, [dispatch, navigation, routeKey]);
  const close = useCallback(() => navigation.goBack(), [navigation]);
  return (
    <TrayFrame open={open} onClose={close} onExited={onExited}>
      {children}
    </TrayFrame>
  );
}

/**
 * A tray that rises inside a screen, over what's on it: a flow's review, then its
 * result, step by step in the same card (Family's pattern: enter the amount on the
 * page, confirm in a tray). `children` null closes it, with the exit played first.
 */
export function InlineTray({
  onClose,
  dismissible,
  children,
}: {
  onClose: () => void;
  dismissible?: boolean;
  children: ReactNode | null;
}) {
  // Keep the last content while the tray slides away.
  const [shown, setShown] = useState<ReactNode | null>(children);
  const open = children != null;
  if (open && shown !== children) setShown(children);
  if (!shown) return null;
  // Its own full-screen layer, so it covers the whole screen (status bar, padding,
  // the sheet it sits in) wherever in the tree it's placed.
  return (
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={dismissible === false ? undefined : onClose}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <TrayFrame
          open={open}
          onClose={onClose}
          onExited={() => setShown(null)}
          dismissible={dismissible}
        >
          {shown}
        </TrayFrame>
      </GestureHandlerRootView>
    </Modal>
  );
}

/**
 * A money flow's frame: the page (amount, keypad) plus an `InlineTray` child for its
 * review and result. On its own it shows the page with the tray rising over it; when
 * the flow is itself a tray, the steps swap inside that one card instead, which eases
 * its height to each step (Family's one tray per flow).
 */
export function FlowTray({ children }: { children: ReactNode }) {
  const inTray = useInTray();
  if (!inTray) return <View style={{ flex: 1 }}>{children}</View>;
  const parts = Children.toArray(children);
  const tray = parts.find((p) => isValidElement(p) && p.type === InlineTray);
  const overlay =
    tray && isValidElement<{ children?: ReactNode }>(tray) ? (tray.props.children ?? null) : null;
  const page = parts.filter((p) => p !== tray);
  return (
    <ContentSwap id={overlay ? 'step' : 'page'} index={overlay ? 1 : 0}>
      {overlay ?? page}
    </ContentSwap>
  );
}

const useStyles = makeStyles((c) => ({
  backdrop: {
    backgroundColor: c.scheme === 'dark' ? 'rgba(0, 0, 0, 0.6)' : 'rgba(19, 19, 19, 0.32)',
  },
  card: {
    position: 'absolute',
    left: TRAY_INSET,
    right: TRAY_INSET,
    ...radius(RADIUS),
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: c.sheet,
  },
  close: {
    position: 'absolute',
    top: TRAY_CLOSE.top,
    right: TRAY_CLOSE.right,
    width: TRAY_CLOSE.size,
    height: TRAY_CLOSE.size,
    borderRadius: TRAY_CLOSE.size / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
}));
