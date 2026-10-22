import { isAuthApiError, isAuthError, type User } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useIdentityState } from '@/components/IdentityProvider';
import { AUTH_CALLBACK_PATH } from '@/lib/auth-callback';
import { identityClient } from '@/lib/identity-client';

/**
 * Supabase sign-in, for screens that only render when IDENTITY_ENABLED. Every flow ends
 * in a Supabase session and nothing else: the caller decides what happens to the wallet,
 * which stays on this device. No profile data or metadata is written to Supabase.
 */

// Completes a browser redirect if this bundle was opened by one (a no-op on phones).
WebBrowser.maybeCompleteAuthSession();

/** Native Sign in with Apple is iOS only; Android offers Google and email. */
export const APPLE_SIGN_IN = Platform.OS === 'ios';

/** What the app may use from the account: a name for the profile, nothing more. */
export type Identity = { email?: string; name?: string };

export type SignInOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; cancelled: boolean; message: string };

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The first name the provider gave us (Google's profile; Apple sends one on first sign-in). */
const describe = (user: User | null | undefined, name?: string): Identity => {
  const meta = user?.user_metadata ?? {};
  const full = text(meta.full_name) ?? text(meta.name);
  return {
    email: user?.email || undefined,
    name: name ?? text(meta.given_name) ?? full?.split(/\s+/)[0],
  };
};

/** Supabase's error code, when the Auth server sent one. */
const errorCode = (error: unknown) => (isAuthApiError(error) ? error.code : undefined);

const RATE_LIMITED = ['over_email_send_rate_limit', 'over_request_rate_limit'];
const UNAVAILABLE = [
  'otp_disabled',
  'provider_disabled',
  'email_provider_disabled',
  'signup_disabled',
];

/** A sentence for the user: ours for the errors we know, the fallback otherwise. */
function errorMessage(error: unknown, fallback: string) {
  const code = errorCode(error);
  if ((code && RATE_LIMITED.includes(code)) || (isAuthError(error) && error.status === 429))
    return 'Too many tries. Wait a minute, then try again.';
  if (code && UNAVAILABLE.includes(code))
    return 'This way of signing in isn’t available right now. Try another.';
  if (code === 'email_address_invalid') return 'That email address can’t be used. Try another.';
  if (code === 'user_banned') return 'This account can’t sign in.';
  return fallback;
}

/** The signed-in Supabase account, if any, and how it signs in. */
export function useIdentity() {
  const { loaded, user } = useIdentityState();
  const providers: unknown[] = Array.isArray(user?.app_metadata.providers)
    ? user.app_metadata.providers
    : [user?.app_metadata.provider];
  const method: 'apple' | 'google' | 'email' = providers.includes('apple')
    ? 'apple'
    : providers.includes('google')
      ? 'google'
      : 'email';
  return {
    loaded,
    signedIn: !!user,
    method,
    ...describe(user),
    signOut: async () => {
      await identityClient().auth.signOut({ scope: 'local' });
    },
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

const cancelledBy = (name: string): SignInOutcome => ({
  ok: false,
  cancelled: true,
  message: `Sign-in with ${name} was cancelled.`,
});

const failedWith = (name: string, error?: unknown): SignInOutcome => ({
  ok: false,
  cancelled: false,
  message: errorMessage(
    error,
    `Couldn’t finish signing in with ${name}. Try again or use another way.`,
  ),
});

/**
 * Sign in with Apple: the native sheet (iOS), then its identity token to Supabase. A
 * random nonce goes to Apple hashed and to Supabase raw, so a token can't be replayed.
 */
async function signInWithApple(): Promise<SignInOutcome> {
  const nonce = Crypto.randomUUID();
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashed,
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ERR_REQUEST_CANCELED'
    )
      return cancelledBy('Apple');
    console.warn('Sign in with Apple failed', error);
    return failedWith('Apple');
  }
  if (!credential.identityToken) return failedWith('Apple');
  const { data, error } = await identityClient().auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
    nonce,
  });
  if (error || !data.user) {
    console.warn('Supabase rejected the Apple sign-in', error);
    return failedWith('Apple', error);
  }
  // Apple shares the name on the first sign-in only. It's used for the profile on this
  // device and not written back to the account.
  return { ok: true, identity: describe(data.user, text(credential.fullName?.givenName)) };
}

/**
 * Sign in with Google: Supabase's OAuth page in the in-app browser, back to
 * honeywallet://auth-callback with a one-time code (PKCE), exchanged for a session.
 */
async function signInWithGoogle(): Promise<SignInOutcome> {
  const auth = identityClient().auth;
  const redirectTo = AuthSession.makeRedirectUri({ path: AUTH_CALLBACK_PATH });
  const { data, error } = await auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error || !data.url) return failedWith('Google', error);
  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type === 'cancel' || result.type === 'dismiss') return cancelledBy('Google');
  if (result.type !== 'success') return failedWith('Google');
  const url = new URL(result.url);
  const code = url.searchParams.get('code');
  if (!code) {
    // Supabase reports provider errors in the query or the fragment.
    const reason =
      url.searchParams.get('error_description') ??
      new URLSearchParams(url.hash.slice(1)).get('error_description');
    console.warn('Google sign-in came back without a code', reason);
    return failedWith('Google');
  }
  const exchanged = await auth.exchangeCodeForSession(code);
  if (exchanged.error || !exchanged.data.user) return failedWith('Google', exchanged.error);
  return { ok: true, identity: describe(exchanged.data.user) };
}

/** Sign in with Apple (native, iOS) and Google (Supabase's browser OAuth flow). */
export function useSocialSignIn() {
  useWarmUpBrowser();
  const guard =
    (name: string, run: () => Promise<SignInOutcome>) => async (): Promise<SignInOutcome> => {
      try {
        return await run();
      } catch (error) {
        console.warn(`Sign in with ${name} failed`, error);
        return {
          ok: false,
          cancelled: false,
          message: `Couldn’t reach ${name}. Check your connection and try again.`,
        };
      }
    };
  return { apple: guard('Apple', signInWithApple), google: guard('Google', signInWithGoogle) };
}

export type CodeOutcome =
  | { ok: true; identity: Identity }
  | { ok: false; reason: 'wrong' | 'expired' | 'other'; message: string };

/**
 * Sign in or up with a 6-digit code emailed by Supabase. An address without an account
 * gets one, so "create" and "restore" both just work.
 */
export function useEmailCode() {
  const send = async (email: string): Promise<{ ok: true } | { ok: false; message: string }> => {
    const { error } = await identityClient().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    return error
      ? {
          ok: false,
          message: errorMessage(error, 'Couldn’t send a code. Check the address and try again.'),
        }
      : { ok: true };
  };

  /** Checks the code and, when it's right, the session starts. */
  const verify = async (email: string, code: string): Promise<CodeOutcome> => {
    const { data, error } = await identityClient().auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    });
    if (!error && data.user) return { ok: true, identity: describe(data.user) };
    // Supabase answers a wrong code and an expired one the same way (otp_expired).
    if (errorCode(error) === 'otp_expired')
      return { ok: false, reason: 'wrong', message: 'That code isn’t right or has expired.' };
    return { ok: false, reason: 'other', message: errorMessage(error, 'Couldn’t check the code.') };
  };

  /** Sends the first code, and fresh ones for the same address. */
  return { start: send, resend: send, verify };
}
