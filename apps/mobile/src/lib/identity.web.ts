/**
 * Honey for Chrome: no Apple / Google / email sign-in yet. Clerk's web SDK loads its
 * runtime script from Clerk's servers, which a Manifest V3 extension may not do, and
 * OAuth redirects would leave the popup. The browser keeps the recovery phrase, import
 * and pairing ways in. See docs/launch/CLERK-SETUP.md.
 */
export const CLERK_PUBLISHABLE_KEY = '';

export const IDENTITY_ENABLED = false;

export async function signOutIdentity() {}
