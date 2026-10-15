// Under Reduce Motion, swaps keep a plain crossfade instead of vanishing: movement
// goes, the fade that explains the change stays (gentler, not zero). These ignore the
// system setting on purpose, since they are the reduced variant.
import { Keyframe, ReduceMotion } from 'react-native-reanimated';
import { DURATION, EASE, lazy } from '@/theme/motion';

export const fadeIn = lazy(() =>
  new Keyframe({
    0: { opacity: 0 },
    100: { opacity: 1, easing: EASE.ease },
  })
    .duration(DURATION.fast)
    .reduceMotion(ReduceMotion.Never),
);

export const fadeOut = lazy(() =>
  new Keyframe({
    0: { opacity: 1 },
    100: { opacity: 0, easing: EASE.ease },
  })
    .duration(DURATION.quick)
    .reduceMotion(ReduceMotion.Never),
);
