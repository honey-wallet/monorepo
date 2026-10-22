/**
 * Where Google sends the browser back to after signing in (honeywallet://sso-callback).
 * The in-app browser session reads it; the router must not also open it as a screen.
 * Allow-list it in the Clerk Dashboard (Native applications → Redirect URLs).
 */
export const AUTH_CALLBACK_PATH = 'sso-callback';

/** True for the sign-in redirect, as a full URL or a bare path. */
export function isAuthCallback(path: string) {
  return /(?:^|[/:])sso-callback(?:[/?#]|$)/.test(path);
}
