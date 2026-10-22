import { isAuthCallback } from '@/lib/auth-callback';

/**
 * Incoming links. The Google sign-in redirect belongs to the in-app browser session that
 * is waiting for it, so it opens no screen (null keeps the current one); on a cold start
 * it falls back to the app's first screen.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (isAuthCallback(path)) return initial ? '/' : null;
  return path;
}
