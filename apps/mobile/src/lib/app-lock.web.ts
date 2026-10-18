import { vaultStatus, webVault } from '@/lib/secure-store.web';
import { createStore } from '@/lib/store';

/**
 * The browser's lock is the vault itself: a password unlocks it, and it locks after
 * a while unused (see secure-store.web.ts). Same shape as the phone's app lock, so
 * code that only asks "is the app unlocked?" works unchanged.
 */
export const appLock = createStore({
  loaded: false,
  enabled: true,
  unlocked: false,
  busy: false,
  error: false,
});

vaultStatus.subscribe(() => {
  const status = vaultStatus.get();
  appLock.set((s) => ({ ...s, loaded: status !== 'loading', unlocked: status === 'unlocked' }));
});

export async function loadAppLock() {
  try {
    await webVault.load();
  } catch {
    appLock.set((s) => ({ ...s, error: true }));
  }
}

/** Coming back to the popup re-checks the idle timeout. */
export function appVisibility(state: string) {
  if (state === 'active') void webVault.load();
}

/** The phone's Face ID unlock; in a browser the password screen does this. */
export async function unlockApp() {}

/** Face ID for opening the app doesn't exist in a browser; the password always applies. */
export async function setAppLock(_enabled: boolean) {
  return false;
}

/** The Settings button: locks the vault, back to the password screen. */
export const lockNow = () => webVault.lock();
