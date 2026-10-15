import * as Haptics from 'expo-haptics';
import { getProfile } from '@/lib/profile';

/** A light tap, unless the user turned off Haptic touch in Settings. */
export function tap() {
  if (getProfile().haptics) Haptics.selectionAsync();
}
