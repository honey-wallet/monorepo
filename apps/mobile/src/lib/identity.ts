/**
 * Who the user is (Supabase Auth: Sign in with Apple, Google or an emailed code), kept
 * apart from what they own. Supabase only ever sees an account id, an email address and
 * the provider's profile: recovery phrases and keys stay in this device's vault, and
 * nothing about them is written to Supabase.
 *
 * Without EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY the app runs without
 * it: the Apple / Google / email ways in are hidden and a recovery phrase or an import is
 * the only way in. Honey for Chrome has its own (always disabled) version in identity.web.ts.
 */
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';

/** Whether Apple / Google / email sign-in is available in this build. */
export const IDENTITY_ENABLED = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;

/**
 * Ends the Supabase session on this device. Best effort: signing out of the wallet never
 * waits on, or fails because of, the identity service.
 */
export async function signOutIdentity() {
  if (!IDENTITY_ENABLED) return;
  try {
    const { identityClient } = await import('@/lib/identity-client');
    await identityClient().auth.signOut({ scope: 'local' });
  } catch (error) {
    console.warn('Couldn’t sign out of the Honey account', error);
  }
}
