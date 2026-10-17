import * as Haptics from 'expo-haptics';
import { AppState, Platform } from 'react-native';
import { getProfile } from '@/lib/profile';

// Feedback is supplementary: unsupported hardware or a rejected native request
// must never interrupt a wallet action. Android uses its semantic system effects,
// not the legacy Vibrator fallback. Web stays quiet rather than producing a buzz.
function play(android: Haptics.AndroidHaptics, ios: () => Promise<void>) {
  if (!getProfile().haptics || AppState.currentState !== 'active' || Platform.OS === 'web') return;
  try {
    const result = Platform.OS === 'android' ? Haptics.performAndroidHapticsAsync(android) : ios();
    void result.catch(() => {});
  } catch {
    // Haptics are unavailable on some devices and in some system states.
  }
}

/** A discrete selection changed: tabs, chips, switches and picker stops. */
export function tap() {
  play(Haptics.AndroidHaptics.Segment_Tick, () => Haptics.selectionAsync());
}

/** Frequent input needs the lightest feedback, synchronous with the digit. */
export function keypress() {
  play(Haptics.AndroidHaptics.Keyboard_Tap, () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft),
  );
}

/** Picking an object up, once when a drag actually starts. */
export function grab() {
  play(Haptics.AndroidHaptics.Drag_Start, () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  );
}

/** A completed action, never the start of a request. */
export function success() {
  play(Haptics.AndroidHaptics.Confirm, () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  );
}

/** A rejected action, paired with visible explanation and recovery. */
export function failure() {
  play(Haptics.AndroidHaptics.Reject, () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  );
}
