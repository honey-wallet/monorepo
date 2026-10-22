/**
 * Honey for Chrome: no Apple / Google / email sign-in yet. Native Sign in with Apple is
 * iOS only, OAuth redirects would leave the popup, and the extension keeps no account
 * session. The browser keeps the recovery phrase, import and pairing ways in.
 * See docs/launch/SUPABASE-SETUP.md.
 */
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

export const IDENTITY_ENABLED = false;

export async function signOutIdentity() {}
