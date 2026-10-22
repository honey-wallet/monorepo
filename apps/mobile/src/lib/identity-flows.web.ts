/**
 * Honey for Chrome has no account sign-in (see identity.web.ts), so nothing here is ever
 * rendered; these keep the shared screens compiling without bundling Supabase.
 */
export const APPLE_SIGN_IN = false;

export type Identity = { email?: string; name?: string };

export type SignInOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; cancelled: boolean; message: string };

export type CodeOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; reason: 'wrong' | 'expired' | 'other'; message: string };

const UNAVAILABLE = 'Sign-in isn’t available in the browser.';

export function useIdentity() {
  return {
    loaded: true,
    signedIn: false,
    method: 'email' as 'apple' | 'google' | 'email',
    email: undefined as string | undefined,
    name: undefined as string | undefined,
    signOut: async () => {},
  };
}

export function useSocialSignIn() {
  const unavailable = async (): Promise<SignInOutcome> => ({
    ok: false,
    cancelled: false,
    message: UNAVAILABLE,
  });
  return { apple: unavailable, google: unavailable };
}

export function useEmailCode() {
  const unavailable = async (
    _email: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> => ({
    ok: false,
    message: UNAVAILABLE,
  });
  return {
    start: unavailable,
    resend: unavailable,
    verify: async (_email: string, _code: string): Promise<CodeOutcome> => ({
      ok: false,
      reason: 'other',
      message: UNAVAILABLE,
    }),
  };
}
