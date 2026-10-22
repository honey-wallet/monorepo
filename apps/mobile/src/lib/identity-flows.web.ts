/**
 * Honey for Chrome has no Clerk sign-in (see identity.web.ts), so nothing here is ever
 * rendered; these keep the shared screens compiling without bundling Clerk.
 */
export const APPLE_SIGN_IN = false;

export type Identity = { email?: string; name?: string };

export type SignInOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; cancelled: boolean; message: string };

export type EmailFlow = 'sign-in' | 'sign-up';

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
  return {
    start: async (
      _email: string,
    ): Promise<{ ok: true; flow: EmailFlow } | { ok: false; message: string }> => ({
      ok: false,
      message: UNAVAILABLE,
    }),
    resend: async (_flow: EmailFlow): Promise<{ ok: true } | { ok: false; message: string }> => ({
      ok: false,
      message: UNAVAILABLE,
    }),
    verify: async (_flow: EmailFlow, _code: string): Promise<CodeOutcome> => ({
      ok: false,
      reason: 'other',
      message: UNAVAILABLE,
    }),
  };
}
