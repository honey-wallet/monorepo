import { webVault } from '@/lib/secure-store.web';
import { createStore } from '@/lib/store';

/**
 * In a browser there's no Face ID: sensitive actions (showing the phrase, signing out,
 * pairing) ask for the password instead. `PasswordPrompt` (mounted by AppGate) shows
 * the request and resolves it.
 */
export type PasswordRequest = { reason: string; resolve: (ok: boolean) => void };
export const passwordRequest = createStore<PasswordRequest | null>(null);

export const isAuthenticatingOwner = () => passwordRequest.get() !== null;

export function confirmOwner(reason: string, _requireDeviceLock = false): Promise<boolean> {
  passwordRequest.get()?.resolve(false);
  return new Promise((resolve) => {
    passwordRequest.set({
      reason,
      resolve: (ok) => {
        passwordRequest.set(null);
        resolve(ok);
      },
    });
  });
}

/** Checks a password typed into the prompt. */
export const checkPassword = (password: string) => webVault.verify(password);
