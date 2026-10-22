/**
 * Where Google sends the browser back to after signing in (honeywallet://auth-callback).
 * The in-app browser session reads it; the router must not also open it as a screen.
 * Allow-list it in Supabase (Authentication → URL Configuration → Redirect URLs).
 */
export const AUTH_CALLBACK_PATH = 'auth-callback';

/** True for the sign-in redirect, as a full URL or a bare path. */
export function isAuthCallback(path: string) {
  return /(?:^|[/:])auth-callback(?:[/?#]|$)/.test(path);
}
