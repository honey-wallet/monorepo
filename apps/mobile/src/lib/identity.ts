/**
 * Who the user is (Clerk: Sign in with Apple, Google or an emailed code), kept apart from
 * what they own. Clerk only ever sees an account id and an email address: recovery phrases
 * and keys stay in this device's vault, and nothing about them goes into Clerk metadata.
 *
 * With no EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY the app runs without it: the Apple / Google /
 * email ways in are hidden and a recovery phrase or an import is the only way in.
 * Honey for Chrome has its own (always disabled) version in identity.web.ts.
 */
export const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? '';

/** Whether Apple / Google / email sign-in is available in this build. */
export const IDENTITY_ENABLED = CLERK_PUBLISHABLE_KEY.length > 0;

/**
 * Ends the Clerk session on this device. Best effort: signing out of the wallet never
 * waits on, or fails because of, the identity service.
 */
export async function signOutIdentity() {
  if (!IDENTITY_ENABLED) return;
  try {
    const { getClerkInstance } = await import('@clerk/expo');
    await getClerkInstance().signOut();
  } catch (error) {
    console.warn('Couldn’t sign out of the Honey account', error);
  }
}
