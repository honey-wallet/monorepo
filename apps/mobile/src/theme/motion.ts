import { Easing, LinearTransition } from 'react-native-reanimated';

/**
 * Motion tokens, following Emil Kowalski's "Animations on the Web" course
 * (https://animations.dev). Use these rather than one-off timings so the app moves
 * as one. The rules behind them:
 * - Ask how often the user sees it first. Anything done 100+ times a day (typing on
 *   the keypad) doesn't animate; things seen tens of times a day barely do.
 * - Interface motion stays under ~300ms; exits are shorter than entries. Only rare,
 *   first-time moments (onboarding, celebrations) go longer.
 * - Custom, asymmetric curves: ease-out to enter or leave, ease-in-out to move
 *   something already on screen, never ease-in.
 * - No bounce by default; overshoot is reserved for a drag being released.
 * - Under Reduce Motion, keep the fades and drop the movement (gentler, not zero).
 */
export const DURATION = {
  /** Stagger between items in a group (30–80ms; decorative, never blocking). */
  stagger: 40,
  micro: 80,
  /** Press feedback, exits, tooltips. */
  quick: 150,
  /** Dropdowns, swaps, tabs. */
  fast: 200,
  /** Small sheets and panels, height changes. */
  medium: 250,
  /** The ceiling for everyday interface motion. */
  slow: 300,
  /** Rare, first-time moments only (onboarding, a completed swap). */
  verySlow: 400,
} as const;

export const EASE = {
  /** Entering or leaving: a strong ease-out (fast start, long gentle settle). */
  smoothOut: Easing.bezier(0.19, 1, 0.22, 1),
  /** Moving or morphing something already on screen. */
  inOut: Easing.bezier(0.645, 0.045, 0.355, 1),
  /** Press feedback. */
  press: Easing.bezier(0.25, 0.46, 0.45, 0.94),
  /** Sheets and drawers (iOS sheet curve, extremely steep start). */
  sheet: Easing.bezier(0.32, 0.72, 0, 1),
  /** Height changes: a snappy ease-out. */
  height: Easing.bezier(0.25, 1, 0.5, 1),
  /** Opacity and colour on their own. */
  ease: Easing.bezier(0.25, 0.1, 0.25, 1),
} as const;

/** Springs for interruptible motion: critically damped (no bounce) unless released from a drag. */
export const SPRING = {
  /** State and position changes that may be interrupted (toggles, tabs, stacks). */
  ui: { duration: 300, dampingRatio: 1 },
  /** Settling after the finger lets go of a drag: a slight, earned overshoot. */
  release: { duration: 450, dampingRatio: 0.82 },
} as const;

/** Press feedback is felt, not seen. Large surfaces (cards) can use 0.98. */
export const PRESS_SCALE = 0.97;

export const DISTANCE = {
  micro: 4,
  small: 6,
  base: 8,
  medium: 12,
} as const;

/** Layout move for items that shift when siblings appear, vanish or reorder. */
export const LAYOUT_MOVE = LinearTransition.duration(DURATION.medium).easing(EASE.inOut);

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
