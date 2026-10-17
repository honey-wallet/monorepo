import * as SecureStore from 'expo-secure-store';
import { confirmOwner, isAuthenticatingOwner } from '@/lib/auth';
import { updateSettings } from '@/lib/settings';
import { createStore } from '@/lib/store';

const KEY = 'honey.app-lock';
export const appLock = createStore({
  loaded: false,
  enabled: false,
  unlocked: false,
  busy: false,
  error: false,
});
let generation = 0;
let foreground = true;

export async function loadAppLock() {
  try {
    const enabled = (await SecureStore.getItemAsync(KEY)) === 'true';
    updateSettings({ faceIdAppAccess: enabled });
    appLock.set({ loaded: true, enabled, unlocked: !enabled, busy: false, error: false });
  } catch {
    appLock.set((s) => ({ ...s, error: true }));
  }
}

export function appVisibility(state: string) {
  foreground = state === 'active';
  const lock = appLock.get();
  // The authentication dialog itself may make iOS inactive. Background always invalidates it.
  if (state === 'background' || (state === 'inactive' && !lock.busy && !isAuthenticatingOwner())) {
    generation++;
    if (lock.enabled) appLock.set((s) => ({ ...s, unlocked: false }));
  }
}

export async function unlockApp() {
  const state = appLock.get();
  if (!state.loaded || state.busy) return;
  const current = generation;
  appLock.set((s) => ({ ...s, busy: true, error: false }));
  try {
    const accepted = await confirmOwner('Unlock Honey', true);
    if (accepted && current === generation && foreground)
      appLock.set((s) => ({ ...s, unlocked: true }));
  } catch {
    appLock.set((s) => ({ ...s, error: true }));
  } finally {
    appLock.set((s) => ({ ...s, busy: false }));
  }
}

export async function setAppLock(enabled: boolean) {
  if (appLock.get().busy) return;
  const current = generation;
  appLock.set((s) => ({ ...s, busy: true }));
  try {
    if (!(await confirmOwner('Change app access protection', true))) return false;
    if (current !== generation || !foreground) return false;
    await SecureStore.setItemAsync(KEY, String(enabled));
    updateSettings({ faceIdAppAccess: enabled });
    appLock.set((s) => ({ ...s, enabled, unlocked: current === generation && foreground }));
    return true;
  } finally {
    appLock.set((s) => ({ ...s, busy: false }));
  }
}
