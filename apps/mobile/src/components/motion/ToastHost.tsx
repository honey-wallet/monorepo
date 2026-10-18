// Toasts follow the Sonner lessons. A new toast rises one full toast-height from
// below with a fade and a 0.97 → 1 scale (250ms on `ease`: a toast isn't urgent, so
// it can be a touch slower and elegant). Older ones push back rather than leave: each
// step back rises 13% of a toast, shrinks 5% and dims. Every move is a transition from wherever the toast
// is now, never a restarting keyframe, so a toast arriving mid-animation doesn't make
// the others jump. Swipe the front toast down (the way it came in) to dismiss it: it
// follows the finger, and a 40px pull or a flick sends it off at the finger's speed.
// Leaving is quicker than arriving (200ms). Under Reduce Motion toasts only fade.
import { useEffect, useState } from 'react';
import { Keyboard, Platform, Text } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Keyframe,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { Icon } from '@/components/Icon';
import { TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import { dismissToast, type Toast, useToasts } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE, lazy, SPRING } from '@/theme/motion';

/** The toast floats this far above the tab bar, so it never covers it. */
const GAP_ABOVE_TAB_BAR = 18;

/** Over an open tray, the toast sits above the tray's footer buttons, not on them. */
const ABOVE_TRAY_FOOTER = 92;
/** Above the keyboard when it's up, never over it. */
const GAP_ABOVE_KEYBOARD = 12;

/** The on-screen keyboard's height, 0 while it's down (none on the web). */
function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    // iOS reports just before the keyboard moves; Android only after.
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subs = [
      Keyboard.addListener(show, (e) => setHeight(e.endCoordinates.height)),
      Keyboard.addListener(hide, () => setHeight(0)),
    ];
    return () => {
      for (const sub of subs) sub.remove();
    };
  }, []);
  return height;
}

/** Matches the toast's height: it enters from one full toast below (Sonner: translateY(100%)). */
const TOAST_HEIGHT = 44;
const RISE = TOAST_HEIGHT;
const SCALE = 0.97;
/** Each pushed-back toast rises 13% of a toast and shrinks 5% (the course's stack). */
const PEEK = TOAST_HEIGHT * 0.13;
const DEPTH_SCALE = 0.05;
const DEPTH_FADE = 0.4;
/** Sonner's toast clock: `ease`, slightly slower than other UI. */
const STACK = {
  duration: DURATION.medium,
  easing: EASE.ease,
  reduceMotion: ReduceMotion.Never,
};
/** A pull this far down, or a flick this fast (pt/s), dismisses. */
const DISMISS_DISTANCE = 40;
const FLICK = 500;
const RUBBER = 0.2;

const leave = lazy(() =>
  new Keyframe({
    0: { opacity: 1, transform: [{ translateY: 0 }] },
    100: { opacity: 0, transform: [{ translateY: RISE / 2 }], easing: EASE.ease },
  }).duration(DURATION.fast),
);

const fadeOut = lazy(() =>
  new Keyframe({
    0: { opacity: 1 },
    100: { opacity: 0, easing: EASE.ease },
  })
    .duration(DURATION.fast)
    .reduceMotion(ReduceMotion.Never),
);

/** Renders the toasts, newest in front, above the tab bar. Mount once, at the root. */
export function ToastHost() {
  const toasts = useToasts();
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const keyboard = useKeyboardHeight();
  const bottom = insets.bottom + TAB_BAR_HEIGHT + GAP_ABOVE_TAB_BAR;
  // Always at the bottom (review: toasts at the top looked out of place).
  const place = (overTray: boolean) => {
    const base = overTray ? insets.bottom + ABOVE_TRAY_FOOTER : bottom;
    return keyboard ? Math.max(base, keyboard + GAP_ABOVE_KEYBOARD) : base;
  };

  return (
    <>
      {toasts.map((toast, depth) => (
        <Animated.View
          key={toast.id}
          exiting={reduceMotion ? fadeOut() : leave()}
          // Only the front toast takes touches (to swipe it away).
          pointerEvents={depth === 0 ? 'box-none' : 'none'}
          style={[
            styles.slot,
            // toast.top ? { top: insets.top + 12 } : { bottom },
            { bottom: place(toast.top) },
            { zIndex: toasts.length - depth },
          ]}
        >
          <StackedToast toast={toast} depth={depth} />
        </Animated.View>
      ))}
    </>
  );
}

/** One toast, pushed back by `depth` (0 is the newest, in front). */
function StackedToast({ toast, depth }: { toast: Toast; depth: number }) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const appear = useSharedValue(0);
  const d = useSharedValue(depth);
  const drag = useSharedValue(0);
  const start = useSharedValue(0);

  useEffect(() => {
    appear.value = withTiming(1, STACK);
  }, [appear]);

  useEffect(() => {
    d.value = withTiming(depth, STACK);
  }, [depth, d]);

  // Track: the toast is the finger. Release: a spring carrying the finger's speed.
  const swipe = Gesture.Pan()
    .enabled(depth === 0)
    .activeOffsetY([-6, 6])
    .onStart(() => {
      cancelAnimation(drag);
      start.value = drag.value;
    })
    .onUpdate((e) => {
      const next = start.value + e.translationY;
      drag.value = next < 0 ? next * RUBBER : next;
    })
    .onEnd((e) => {
      if (drag.value > DISMISS_DISTANCE || e.velocityY > FLICK) {
        if (!reduceMotion)
          drag.value = withSpring(RISE * 6, { ...SPRING.ui, velocity: e.velocityY });
        appear.value = withTiming(0, { duration: DURATION.quick, easing: EASE.ease });
        scheduleOnRN(dismissToast, toast.id);
      } else {
        drag.value = reduceMotion ? 0 : withSpring(0, { ...SPRING.ui, velocity: e.velocityY });
      }
    })
    .onFinalize((_e, finished) => {
      if (!finished) drag.value = reduceMotion ? 0 : withSpring(0, SPRING.ui);
    });

  // Depth 1 dims to 0.6 and depth 2 to 0.36.
  const style = useAnimatedStyle(() => {
    const dim =
      d.value <= 1
        ? 1 - DEPTH_FADE * d.value
        : 1 - DEPTH_FADE - DEPTH_FADE * 0.6 * Math.min(d.value - 1, 1);
    const pulled = Math.max(drag.value, 0);
    if (reduceMotion) {
      return {
        opacity: appear.value * dim,
        transform: [{ translateY: -PEEK * depth + drag.value }],
      };
    }
    return {
      opacity: appear.value * dim * (1 - Math.min(pulled / (RISE * 6), 1)),
      transform: [
        { translateY: (1 - appear.value) * RISE - PEEK * d.value + drag.value },
        { scale: (SCALE + (1 - SCALE) * appear.value) * (1 - DEPTH_SCALE * d.value) },
      ],
    };
  });

  return (
    <GestureDetector gesture={swipe}>
      <Animated.View
        accessibilityLiveRegion={depth === 0 ? 'polite' : 'none'}
        importantForAccessibility={depth === 0 ? 'auto' : 'no-hide-descendants'}
        style={[styles.toast, style]}
      >
        <Icon name="check" size={14} color={c.success} />
        <Text style={styles.message}>{toast.message}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

const useStyles = makeStyles((c) => ({
  slot: {
    position: 'absolute',
    alignSelf: 'center',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    height: TOAST_HEIGHT,
    borderRadius: 22,
    backgroundColor: c.raised,
    borderWidth: 1,
    borderColor: c.divider,
    // Pushed-back toasts shrink toward their bottom edge, so they peek out above.
    transformOrigin: 'center bottom',
  },
  message: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
}));
