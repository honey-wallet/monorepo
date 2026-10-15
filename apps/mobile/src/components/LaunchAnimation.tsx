// Opening animation, played once per cold start over the app. It starts exactly where
// the native splash leaves off (the mark, 110pt wide, centred on white or black), then:
//   pop    – the mark gives a small press-like dip (0.96) and eases back, barely past 1
//   lift   – the mark rises as the "honey" wordmark fades and rises in beneath it
//   blink  – the eyes close and open twice
//   reveal – everything fades out and grows slightly, uncovering the app
// It's a once-per-cold-start brand moment, so it may take its time (about 1.4s in all),
// but every step uses ease-out or ease-in-out (never ease-in) and the exit is a short
// 250ms fade. Under Reduce Motion it holds briefly, then just fades.

import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import {
  EYES_PATH,
  MARK_VIEWBOX,
  RING_PATH,
  WORDMARK_PATH,
  WORDMARK_VIEWBOX,
} from '@/components/logo/paths';
import { revealApp } from '@/lib/launch';
import { useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

// Keep the native splash up until this screen has drawn, so the handoff is seamless.
SplashScreen.preventAutoHideAsync().catch(() => {});

/** Matches `imageWidth` of the native splash in app.json. */
const MARK_WIDTH = 110;
const MARK_HEIGHT = (MARK_WIDTH * 350) / 400;
const WORD_HEIGHT = 40;
const WORD_WIDTH = (WORD_HEIGHT * 459) / 160;
const GAP = 16;
/** Where the mark sits once the wordmark joins it, so the pair stays centred. */
const LIFT = -(GAP + WORD_HEIGHT) / 2;
/**
 * Matches the native splash, which follows the system theme: white in light mode,
 * black in dark. The honey ring keeps its colour; the wordmark is dark on white and
 * light on black.
 */
const SPLASH = {
  light: { background: '#FFFFFF', eyes: '#4B2817', word: '#4B2817' },
  dark: { background: '#000000', eyes: '#4B2817', word: '#F6F3EB' },
} as const;

/** When the overlay starts fading out to reveal the app. */
const FADE_AT = 1150;
const REDUCED_FADE_AT = 400;

const smooth = (duration: number) => ({ duration, easing: EASE.smoothOut });

export function LaunchAnimation({ onDone }: { onDone: () => void }) {
  const c = useTheme();
  const colors = SPLASH[c.scheme];
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const lift = useSharedValue(0);
  const word = useSharedValue(0);
  const blink = useSharedValue(1);
  const fade = useSharedValue(1);

  const started = useRef(false);

  const start = () => {
    // onLayout can fire more than once (e.g. rotation); play only the first time.
    if (started.current) return;
    started.current = true;
    SplashScreen.hideAsync().catch(() => {});
    if (reduceMotion) {
      fade.value = withDelay(
        REDUCED_FADE_AT,
        withTiming(0, { duration: DURATION.fast, easing: EASE.ease }),
      );
      reveal.current = setTimeout(revealApp, REDUCED_FADE_AT);
      end.current = setTimeout(onDone, REDUCED_FADE_AT + DURATION.fast);
      return;
    }
    scale.value = withSequence(
      withTiming(0.96, { duration: 120, easing: EASE.press }),
      withTiming(1.02, smooth(200)),
      withTiming(1, { duration: 160, easing: EASE.inOut }),
    );
    lift.value = withDelay(300, withTiming(LIFT, smooth(DURATION.slow)));
    word.value = withDelay(340, withTiming(1, smooth(DURATION.slow)));
    blink.value = withDelay(
      700,
      withSequence(
        withTiming(0.1, { duration: 70 }),
        withTiming(1, { duration: 110 }),
        withDelay(90, withTiming(0.1, { duration: 70 })),
        withTiming(1, { duration: 110 }),
      ),
    );
    fade.value = withDelay(FADE_AT, withTiming(0, smooth(DURATION.medium)));
    // Unmount on the JS clock once the fade has finished (no worklet callback needed).
    end.current = setTimeout(onDone, FADE_AT + DURATION.medium);
    // Screens start their entrances as the overlay starts to fade.
    reveal.current = setTimeout(revealApp, FADE_AT);
  };

  const end = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reveal = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(end.current);
      clearTimeout(reveal.current);
      revealApp();
    },
    [],
  );

  const root = useAnimatedStyle(() => ({ opacity: fade.value }));
  const content = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (1 - fade.value) * 0.06 }],
  }));
  const mark = useAnimatedStyle(() => ({
    transform: [{ translateY: lift.value }, { scale: scale.value }],
  }));
  const eyes = useAnimatedStyle(() => ({ transform: [{ scaleY: blink.value }] }));
  const wordmark = useAnimatedStyle(() => ({
    opacity: word.value,
    transform: [{ translateY: LIFT + (1 - word.value) * 12 }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      onLayout={start}
      accessible
      accessibilityLabel="Honey"
      style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: colors.background }, root]}
    >
      <StatusBar style={c.scheme === 'dark' ? 'light' : 'dark'} />
      <Animated.View style={[styles.center, content]}>
        <Animated.View style={mark}>
          <Svg width={MARK_WIDTH} height={MARK_HEIGHT} viewBox={MARK_VIEWBOX}>
            <Path fill={c.brandYellow} fillRule="evenodd" d={RING_PATH} />
          </Svg>
          {/* Eyes on their own layer so they can blink; origin at the eyes' centre. */}
          <Animated.View style={[styles.eyes, eyes]}>
            <Svg width={MARK_WIDTH} height={MARK_HEIGHT} viewBox={MARK_VIEWBOX}>
              <Path fill={colors.eyes} d={EYES_PATH} />
            </Svg>
          </Animated.View>
        </Animated.View>
        <Animated.View style={[styles.word, wordmark]}>
          <Svg width={WORD_WIDTH} height={WORD_HEIGHT} viewBox={WORDMARK_VIEWBOX}>
            <Path fill={colors.word} fillRule="evenodd" d={WORDMARK_PATH} />
          </Svg>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    zIndex: 100,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyes: {
    position: 'absolute',
    top: 0,
    left: 0,
    // The eyes sit at the mark's horizontal centre, about 12% down from its top.
    transformOrigin: ['50%', '12%', 0],
  },
  word: {
    position: 'absolute',
    // Just below where the mark settles.
    top: '50%',
    marginTop: MARK_HEIGHT / 2 + GAP,
  },
});
