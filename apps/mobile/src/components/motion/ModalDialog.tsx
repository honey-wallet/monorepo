// A dialog sits on top of the page rather than coming from a trigger, so it scales from
// its centre: 0.95 → 1 with a fade over 250ms on a strong ease-out, and leaves faster
// (150ms). With `placement="bottom"` it's a sheet: it rises on the iOS sheet curve
// (450ms; the steep start keeps it snappy) and follows the finger 1:1 when dragged
// down. Let go past 40% of its height or with a downward flick and it carries that
// speed out; otherwise it springs back. It rubber-bands if pulled up, and the backdrop
// dims with the sheet's position, so the two can never drift apart. Under Reduce
// Motion both only fade.
import { type ReactNode, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { DURATION, EASE, SPRING } from '@/theme/motion';

const DIALOG = { open: 250, close: DURATION.quick, scale: 0.95 } as const;
const SHEET = { open: 450, close: DURATION.medium } as const;
/** Share of the sheet's height dragged down that dismisses it on release. */
const DISMISS_AT = 0.4;
/** Downward release speed (pt/s) that dismisses even a short drag (a flick). */
const FLICK = 500;
/** Pulling up past the top moves it this fraction of the finger's distance. */
const RUBBER = 0.2;

/**
 * A centred dialog or a bottom sheet over a dimmed backdrop. It stays mounted through
 * its close animation.
 */
export function ModalDialog({
  visible,
  onRequestClose,
  dismissable = true,
  placement = 'center',
  children,
}: {
  visible: boolean;
  /** `center` for a dialog, `bottom` for a sheet that rises from the bottom edge. */
  placement?: 'center' | 'bottom';
  onRequestClose: () => void;
  /** Whether tapping the backdrop, dragging down or Android back closes it; off while busy. */
  dismissable?: boolean;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const bottom = placement === 'bottom';
  // Dialog: 0 closed → 1 open. Sheet: how far down it sits, 0 = fully open.
  const progress = useSharedValue(0);
  const y = useSharedValue(1000);
  const height = useSharedValue(1000);
  const dragStart = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      if (bottom && !reduceMotion) {
        y.value = withTiming(0, { duration: SHEET.open, easing: EASE.sheet });
        progress.value = 1;
      } else {
        y.value = 0;
        progress.value = withTiming(1, {
          duration: reduceMotion ? DURATION.fast : DIALOG.open,
          easing: reduceMotion ? EASE.ease : EASE.smoothOut,
        });
      }
      return;
    }
    const close = bottom ? SHEET.close : DIALOG.close;
    if (bottom && !reduceMotion) {
      y.value = withTiming(height.value, { duration: close, easing: EASE.sheet });
    } else {
      progress.value = withTiming(0, {
        duration: close,
        easing: reduceMotion ? EASE.ease : EASE.smoothOut,
      });
    }
    // Unmount once the close has played.
    const done = setTimeout(() => setMounted(false), close);
    return () => clearTimeout(done);
  }, [visible, bottom, reduceMotion, progress, y, height]);

  const close = () => {
    if (dismissable) onRequestClose();
  };

  // Track: the sheet is the finger. Release: a spring seeded with the finger's speed.
  const drag = Gesture.Pan()
    .enabled(bottom && dismissable)
    .activeOffsetY([-8, 8])
    .onStart(() => {
      cancelAnimation(y);
      dragStart.value = y.value;
    })
    .onUpdate((e) => {
      const next = dragStart.value + e.translationY;
      y.value = next < 0 ? next * RUBBER : next;
    })
    .onEnd((e) => {
      const dismiss = y.value > height.value * DISMISS_AT || e.velocityY > FLICK;
      if (dismiss) {
        y.value = withSpring(height.value, { ...SPRING.ui, velocity: e.velocityY });
        scheduleOnRN(onRequestClose);
      } else {
        y.value = withSpring(0, { ...SPRING.ui, velocity: e.velocityY });
      }
    });

  const backdrop = useAnimatedStyle(() => ({
    opacity: bottom
      ? progress.value * interpolate(y.value, [0, height.value], [1, 0], 'clamp')
      : progress.value,
  }));
  const surface = useAnimatedStyle(() => {
    if (bottom) {
      return reduceMotion ? { opacity: progress.value } : { transform: [{ translateY: y.value }] };
    }
    return reduceMotion
      ? { opacity: progress.value }
      : {
          opacity: progress.value,
          transform: [{ scale: DIALOG.scale + (1 - DIALOG.scale) * progress.value }],
        };
  });

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={close}
    >
      {/* A Modal is its own native root, so gestures inside need their own handler root. */}
      <GestureHandlerRootView style={styles.flex}>
        <View style={[styles.root, bottom && styles.rootBottom]}>
          <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdrop]}>
            <Pressable
              accessibilityLabel="Close"
              accessible={dismissable}
              style={StyleSheet.absoluteFill}
              onPress={close}
            />
          </Animated.View>
          <GestureDetector gesture={drag}>
            <Animated.View
              accessibilityViewIsModal
              onLayout={(e) => {
                height.value = e.nativeEvent.layout.height;
              }}
              style={[styles.dialog, surface]}
            >
              {children}
            </Animated.View>
          </GestureDetector>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  root: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  rootBottom: {
    justifyContent: 'flex-end',
    padding: 0,
  },
  backdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  dialog: {
    alignSelf: 'stretch',
  },
});
