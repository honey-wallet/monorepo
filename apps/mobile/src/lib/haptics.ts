import * as Haptics from 'expo-haptics';
import { getProfile } from '@/lib/profile';

/** A light tap, unless the user turned off Haptic touch in Settings. */
export function tap() {
  if (getProfile().haptics) Haptics.selectionAsync();
}

/** The success notification buzz, for a finished send or swap. */
export function success() {
  if (getProfile().haptics) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

/** The error notification buzz, for a payment or order that didn't go through. */
export function failure() {
  if (getProfile().haptics) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}
