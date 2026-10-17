// A screen's first-visit entrance. Each block fades in and rises 8px on a strong
// ease-out, 40ms after the block above it, so the eye reads the page top-down: the
// most important block (the balance, the title) lands first. It plays once per
// session per screen (tabs are revisited tens of times a day, so a repeat would only
// slow them down) and waits for the launch overlay to start fading, so it plays in
// view. Under Reduce Motion the blocks only fade.
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useAppRevealed } from '@/lib/launch';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';

const RISE = {
  duration: DURATION.medium,
  easing: EASE.smoothOut,
  reduceMotion: ReduceMotion.Never,
} as const;
/** Past this many blocks the rest arrive together, so long lists never keep you waiting. */
const MAX_STEPS = 3;

const played = new Set<string>();
const EntranceContext = createContext(false);

/**
 * Marks a screen whose `Rise` blocks should play their entrance, the first time the
 * screen shows this session. `id` names the screen.
 */
export function Entrance({ id, children }: { id: string; children: ReactNode }) {
  const [play] = useState(() => !played.has(id));
  useEffect(() => {
    played.add(id);
  }, [id]);
  return <EntranceContext.Provider value={play}>{children}</EntranceContext.Provider>;
}

/**
 * One block of a screen's entrance; `index` is its place in the reading order. Outside
 * a playing `Entrance` it renders as a plain view.
 */
export function Rise({
  index = 0,
  style,
  children,
}: {
  index?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const play = useContext(EntranceContext);
  const revealed = useAppRevealed();
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(play ? 0 : 1);

  useEffect(() => {
    if (!play || !revealed) return;
    const delay = reduceMotion ? 0 : Math.min(index, MAX_STEPS) * DURATION.stagger;
    progress.set(reduceMotion ? withTiming(1, RISE) : withDelay(delay, withTiming(1, RISE)));
  }, [play, revealed, index, reduceMotion, progress]);

  const animated = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: reduceMotion ? 0 : (1 - progress.get()) * DISTANCE.base }],
  }));

  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}

/** True while this screen's entrance is still to play (for parts with their own, e.g. charts). */
export function useEntrancePlaying() {
  const play = useContext(EntranceContext);
  const revealed = useAppRevealed();
  return { play, revealed };
}
