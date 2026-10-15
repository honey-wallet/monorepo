// A card whose content changes size eases its width and height to the new size on the
// snappy height ease-out (250ms), with siblings gliding along, so the change reads as
// one continuous surface instead of a jump. Under Reduce Motion it snaps.
import { LinearTransition } from 'react-native-reanimated';
import { DURATION, EASE } from '@/theme/motion';

/** Layout transition for a card whose size changes, e.g. a legend gaining rows. */
export const RESIZE = LinearTransition.duration(DURATION.medium).easing(EASE.height);
