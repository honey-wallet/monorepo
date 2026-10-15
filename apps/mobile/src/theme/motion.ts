import { Easing, LinearTransition } from 'react-native-reanimated';

/**
 * Motion tokens, ported from the transitions.dev shared scale
 * (https://transitions.dev, Transitions.dev License). Use these rather than
 * one-off timings so the app moves as one.
 */
export const DURATION = {
  stagger: 40,
  micro: 80,
  quick: 150,
  fast: 250,
  medium: 350,
  slow: 400,
  verySlow: 500,
} as const;

export const EASE = {
  /** Opens, closes, slides and resizes. */
  smoothOut: Easing.bezier(0.22, 1, 0.36, 1),
  /** Icon and text swaps. */
  inOut: Easing.inOut(Easing.ease),
  /** A small settle past the target, e.g. the toggle thumb. */
  bounce: Easing.bezier(0.34, 1.36, 0.64, 1),
} as const;

export const DISTANCE = {
  micro: 4,
  small: 6,
  base: 8,
  medium: 12,
} as const;

/** Layout move for items that shift when siblings appear, vanish or reorder. */
export const LAYOUT_MOVE = LinearTransition.duration(DURATION.fast).easing(EASE.smoothOut);

/**
 * Builds an animation on first use instead of when the module loads. Keyframes with
 * an easing must be created this way: building one while modules load races the
 * worklets runtime's startup and crashes Expo Go on a cold start.
 */
export function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => {
    if (value === undefined) value = make();
    return value;
  };
}
