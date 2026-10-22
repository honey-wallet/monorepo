import {
  isClerkAPIResponseError,
  useAuth,
  useClerk,
  useSignIn,
  useSignUp,
  useSSO,
  useUser,
} from '@clerk/expo';
import { useSignInWithApple } from '@clerk/expo/apple';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { AUTH_CALLBACK_PATH } from '@/lib/auth-callback';

/**
 * Clerk sign-in, for screens that only render when IDENTITY_ENABLED (ClerkProvider is
 * mounted then). Every flow ends in a Clerk session and nothing else: the caller decides
 * what happens to the wallet, which stays on this device. No metadata is written to Clerk.
 */

// Completes a browser redirect if this bundle was opened by one (a no-op on phones).
WebBrowser.maybeCompleteAuthSession();

/** Native Sign in with Apple is iOS only; Android offers Google and email. */
export const APPLE_SIGN_IN = Platform.OS === 'ios';

/** What the app may use from the Clerk account: a name for the profile, nothing more. */
export type Identity = { email?: string; name?: string };

export type SignInOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; cancelled: boolean; message: string };

type ClerkUser = ReturnType<typeof useUser>['user'];

const describe = (user: ClerkUser | undefined): Identity => ({
  email: user?.primaryEmailAddress?.emailAddress ?? undefined,
  name: user?.firstName ?? undefined,
});

/** Clerk's own codes for an error, from an API response or a client-side error. */
function errorCodes(error: unknown): string[] {
  if (isClerkAPIResponseError(error)) return error.errors.map((e) => e.code);
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return [error.code];
  return [];
}

/** A sentence for the user: Clerk's long message when it has one, ours otherwise. */
function errorMessage(error: unknown, fallback: string) {
  if (isClerkAPIResponseError(error)) {
    const first = error.errors[0];
    return first?.longMessage || first?.message || fallback;
  }
  return fallback;
}

const CONNECTING = 'Still connecting. Try again in a moment.';

/** The signed-in Clerk account, if any, and how it signs in. */
export function useIdentity() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const providers = user?.externalAccounts.map((account) => account.provider) ?? [];
  const method: 'apple' | 'google' | 'email' = providers.includes('apple')
    ? 'apple'
    : providers.includes('google')
      ? 'google'
      : 'email';
  return {
    loaded: isLoaded,
    signedIn: !!isSignedIn,
    method,
    ...describe(user),
    signOut: () => clerk.signOut(),
  };
}

// Android: start the browser early so Google's page opens faster.
function useWarmUpBrowser() {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

/** Sign in with Apple (native, iOS) and Google (Clerk's browser OAuth flow). */
export function useSocialSignIn() {
  useWarmUpBrowser();
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const { startSSOFlow } = useSSO();
  const { startAppleAuthenticationFlow } = useSignInWithApple();

  const finish = async (
    name: string,
    start: () => Promise<{
      createdSessionId: string | null;
      setActive?: (params: { session: string }) => Promise<void>;
      cancelled: boolean;
    }>,
  ): Promise<SignInOutcome> => {
    if (!isLoaded) return { ok: false, cancelled: false, message: CONNECTING };
    try {
      const { createdSessionId, setActive, cancelled } = await start();
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        return { ok: true, identity: describe(clerk.user) };
      }
      return cancelled
        ? { ok: false, cancelled: true, message: `Sign-in with ${name} was cancelled.` }
        : {
            ok: false,
            cancelled: false,
            message: `Couldn’t finish signing in with ${name}. Try again or use another way.`,
          };
    } catch (error) {
      if (errorCodes(error).includes('ERR_REQUEST_CANCELED'))
        return { ok: false, cancelled: true, message: `Sign-in with ${name} was cancelled.` };
      console.warn(`Sign in with ${name} failed`, error);
      return {
        ok: false,
        cancelled: false,
        message: errorMessage(
          error,
          `Couldn’t reach ${name}. Check your connection and try again.`,
        ),
      };
    }
  };

  return {
    apple: () =>
      finish('Apple', async () => {
        // The hook resolves without a session when the Apple sheet is dismissed.
        const result = await startAppleAuthenticationFlow();
        return { ...result, cancelled: !result.createdSessionId };
      }),
    google: () =>
      finish('Google', async () => {
        const result = await startSSOFlow({
          strategy: 'oauth_google',
          redirectUrl: AuthSession.makeRedirectUri({ path: AUTH_CALLBACK_PATH }),
        });
        const type = result.authSessionResult?.type;
        return { ...result, cancelled: type === 'cancel' || type === 'dismiss' };
      }),
  };
}

export type EmailFlow = 'sign-in' | 'sign-up';

export type CodeOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; reason: 'wrong' | 'expired' | 'other'; message: string };

const WRONG_CODE = ['form_code_incorrect'];
const DEAD_CODE = ['verification_expired', 'verification_failed', 'too_many_requests'];

/**
 * Sign in or up with a 6-digit code emailed by Clerk. An address without an account
 * gets one (sign-up), so "create" and "restore" both just work.
 */
export function useEmailCode() {
  const clerk = useClerk();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();

  const sendFailure = (error: unknown) => ({
    ok: false as const,
    message: errorMessage(error, 'Couldn’t send a code. Check the address and try again.'),
  });

  const codeFailure = (error: unknown): CodeOutcome => {
    const codes = errorCodes(error);
    if (codes.some((code) => WRONG_CODE.includes(code)))
      return { ok: false, reason: 'wrong', message: 'That code isn’t right.' };
    if (codes.some((code) => DEAD_CODE.includes(code)))
      return {
        ok: false,
        reason: 'expired',
        message: 'That code can’t be used anymore. Get a new code to keep going.',
      };
    return { ok: false, reason: 'other', message: errorMessage(error, 'Couldn’t check the code.') };
  };

  /** Sends the first code. */
  const start = async (
    email: string,
  ): Promise<{ ok: true; flow: EmailFlow } | { ok: false; message: string }> => {
    const created = await signIn.create({ identifier: email });
    if (!created.error) {
      const sent = await signIn.emailCode.sendCode();
      return sent.error ? sendFailure(sent.error) : { ok: true, flow: 'sign-in' };
    }
    if (!errorCodes(created.error).includes('form_identifier_not_found'))
      return sendFailure(created.error);
    const registered = await signUp.create({ emailAddress: email });
    if (registered.error) return sendFailure(registered.error);
    const sent = await signUp.verifications.sendEmailCode();
    return sent.error ? sendFailure(sent.error) : { ok: true, flow: 'sign-up' };
  };

  /** Sends a fresh code for the same attempt. */
  const resend = async (flow: EmailFlow) => {
    const sent =
      flow === 'sign-in'
        ? await signIn.emailCode.sendCode()
        : await signUp.verifications.sendEmailCode();
    return sent.error ? sendFailure(sent.error) : { ok: true as const };
  };

  /** Checks the code and, when it's right, makes the new session active. */
  const verify = async (flow: EmailFlow, code: string): Promise<CodeOutcome> => {
    if (flow === 'sign-in') {
      const checked = await signIn.emailCode.verifyCode({ code });
      if (checked.error) return codeFailure(checked.error);
      if (signIn.status !== 'complete')
        return {
          ok: false,
          reason: 'other',
          message: 'This account needs another sign-in step that Honey doesn’t support yet.',
        };
      const done = await signIn.finalize();
      if (done.error) return codeFailure(done.error);
    } else {
      const checked = await signUp.verifications.verifyEmailCode({ code });
      if (checked.error) return codeFailure(checked.error);
      if (signUp.status !== 'complete')
        return {
          ok: false,
          reason: 'other',
          message: 'Couldn’t finish creating your account. Try again later.',
        };
      const done = await signUp.finalize();
      if (done.error) return codeFailure(done.error);
    }
    return { ok: true, identity: describe(clerk.user) };
  };

  return { start, resend, verify };
}
