import { type Href, Redirect, router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { ActivityIndicator, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { Icon, type IconName } from '@/components/Icon';
import { AppleGlyph } from '@/components/logo/AppleGlyph';
import { useErrorShake } from '@/components/motion/ErrorShake';
import { PressableScale } from '@/components/motion/PressableScale';
import { KeyGlyph, PhraseGlyph } from '@/components/onboarding/icons';
import { SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { LabeledRule } from '@/components/wallet/parts';
import { failure, tap } from '@/lib/haptics';
import { IDENTITY_ENABLED } from '@/lib/identity';
import { APPLE_SIGN_IN, useIdentity, useSocialSignIn } from '@/lib/identity-flows';
import { continueAfterSignIn, type IdentityMethod } from '@/lib/identity-onboarding';
import { leaveSheetTo } from '@/lib/navigation';
import { HERE, isWeb } from '@/lib/platform';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

type Busy = IdentityMethod | 'continue' | null;

/**
 * The two ways in, after Phantom: Apple, Google or email first (no recovery phrase to
 * write down and no password, so nothing to lose people on before the wallet exists),
 * with a recovery phrase or an import tucked under them for people who want it.
 *
 *   create  → Continue with Apple / Google / email, or create with a recovery phrase
 *   restore → Continue with Apple / Google / email, then bring the keys back (backup,
 *             phrase, key or the other device), or go straight to those
 *
 * Apple, Google and email are a Clerk account (identity only): the keys are made or
 * restored on this device either way (lib/identity-onboarding.ts). Without a Clerk key
 * (and always in the browser) only the phrase and import ways are shown.
 */
export default function GetStartedSheet() {
  const { mode = 'create' } = useLocalSearchParams<{ mode?: 'create' | 'restore' }>();
  const restore = mode === 'restore';
  const styles = useStyles();
  const compact = useCompact();
  const [busy, setBusy] = useState<Busy>(null);
  // Restore: pairing first; the phrase, key and backup ways one tap further.
  // const [otherWays, setOtherWays] = useState(false);

  // A sheet over Welcome only. Opened on its own (a reload that reopens a deep link),
  // it would be a bare page with nothing under it, so start from Welcome instead.
  if (!router.canGoBack()) return <Redirect href="/welcome" />;

  // Leave the sheet, then open the next step full screen.
  const go = (href: Href) => {
    tap();
    leaveSheetTo(href);
  };

  return (
    <SheetScreen>
      <Text style={[styles.title, compact && styles.titleCompact]}>
        {restore ? 'Use an existing wallet' : 'Create a new wallet'}
      </Text>

      {IDENTITY_ENABLED ? (
        <IdentityWays restore={restore} busy={busy} setBusy={setBusy} go={go} />
      ) : (
        <SheetText center>
          {restore
            ? 'Bring back your keys from a backup, your phrase or your other device.'
            : `Your keys stay on ${HERE}.`}
        </SheetText>
      )}

      {restore ? (
        <View style={[styles.buttons, compact && styles.buttonsCompact]}>
          {/* In a browser, the easiest way in is the wallet already on the phone. */}
          {isWeb ? (
            <MoreRow
              disabled={!!busy}
              icon="qr"
              title="Pair with your phone"
              onPress={() => {
                tap();
                router.push({ pathname: '/pair-phone', params: { onboarding: '1' } });
              }}
            />
          ) : (
            // On the phone, the wallet you made in Honey for Chrome, by its QR code.
            <MoreRow
              disabled={!!busy}
              icon="qr"
              title="Scan from the browser extension"
              onPress={() => {
                tap();
                // Over this sheet, like Pair with your phone in the browser: leaving the
                // sheet first could undo the scanner's push while the sheet closed.
                router.push({ pathname: '/scan', params: { purpose: 'pair' } });
              }}
            />
          )}
          {/* One button each for a phrase and a key (review); the backup, rarer, a
              link under them. Before: one "I have a recovery phrase or key" row. */}
          <MoreRow
            disabled={!!busy}
            icon="phrase"
            title="I have a recovery phrase"
            onPress={() => go({ pathname: '/import-wallet', params: { onboarding: '1' } })}
          />
          <MoreRow
            disabled={!!busy}
            icon="privateKey"
            title="I have a private key"
            onPress={() =>
              go({ pathname: '/import-wallet', params: { onboarding: '1', kind: 'key' } })
            }
          />
          {/* A button like the others (review), not a link. */}
          <MoreRow
            disabled={!!busy}
            icon="cloud"
            title="Restore from a backup"
            onPress={() => go({ pathname: '/restore-backup', params: { onboarding: '1' } })}
          />
          {/*
          {otherWays ? (
            <Animated.View entering={FadeIn.duration(DURATION.fast)} style={styles.otherWays}>
              <MoreRow
                disabled={!!busy}
                icon="phrase"
                title="Import a recovery phrase"
                onPress={() => go({ pathname: '/import-wallet', params: { onboarding: '1' } })}
              />
              <MoreRow
                disabled={!!busy}
                icon="cloud"
                title="Restore from a backup"
                onPress={() => go({ pathname: '/restore-backup', params: { onboarding: '1' } })}
              />
              <MoreRow
                disabled={!!busy}
                icon="privateKey"
                title="Import a private key"
                onPress={() =>
                  go({ pathname: '/import-wallet', params: { onboarding: '1', kind: 'key' } })
                }
              />
            </Animated.View>
          ) : (
            <MoreRow
              disabled={!!busy}
              icon="phrase"
              title="I have a recovery phrase or key"
              onPress={() => {
                tap();
                setOtherWays(true);
              }}
            />
          )}

          */}
        </View>
      ) : (
        <View style={styles.buttons}>
          <MoreRow
            disabled={!!busy}
            icon="phrase"
            title="Create with a recovery phrase"
            onPress={() => go({ pathname: '/recovery-phrase', params: { onboarding: '1' } })}
          />
        </View>
      )}
    </SheetScreen>
  );
}

/**
 * Apple (iOS), Google and email, through Clerk. Once signed in: Continue (create), or
 * the account's name over the restore ways, since the account can't bring keys back.
 */
function IdentityWays({
  restore,
  busy,
  setBusy,
  go,
}: {
  restore: boolean;
  busy: Busy;
  setBusy: (busy: Busy) => void;
  go: (href: Href) => void;
}) {
  const styles = useStyles();
  const compact = useCompact();
  const c = useTheme();
  const identity = useIdentity();
  const social = useSocialSignIn();
  const [error, setError] = useState<string | null>(null);
  const { shake, style: shaken } = useErrorShake();

  const fail = (message: string) => {
    failure();
    setBusy(null);
    setError(message);
    shake();
  };

  // The account is identity only: make or find the wallet on this device.
  const proceed = async (method: IdentityMethod, who: { email?: string; name?: string }) => {
    try {
      if ((await continueAfterSignIn(method, { restore, identity: who })) === 'needs-keys')
        setBusy(null);
    } catch (cause) {
      console.warn('Couldn’t set up the wallet after sign-in', cause);
      fail(restore ? 'Couldn’t open your wallet. Try again.' : 'Couldn’t create your wallet.');
    }
  };

  const signIn = async (provider: 'apple' | 'google') => {
    tap();
    setError(null);
    setBusy(provider);
    const outcome = await social[provider]();
    if (!outcome.ok) {
      fail(outcome.cancelled ? `${outcome.message} Nothing was created.` : outcome.message);
      return;
    }
    await proceed(provider, outcome.identity);
  };

  if (identity.signedIn) {
    const who = identity.email ?? identity.name ?? 'your account';
    return (
      <>
        <SheetText center>
          {restore
            ? `Signed in as ${who}. Your keys never leave your devices, so bring them back here.`
            : `Signed in as ${who}. Your keys stay on ${HERE}.`}
        </SheetText>
        <Text
          accessibilityRole="button"
          style={[styles.link, !!busy && styles.disabled]}
          disabled={!!busy}
          onPress={() => {
            tap();
            setError(null);
            void identity.signOut();
          }}
        >
          Use another account
        </Text>
        {restore ? null : (
          <Animated.View style={[styles.buttons, compact && styles.buttonsCompact, shaken]}>
            <AuthButton
              label="Continue"
              icon={<Icon name="checkCircle" size={18} color={c.canvas} />}
              tone="inverse"
              busy={busy === 'continue'}
              disabled={!!busy}
              onPress={() => {
                tap();
                setError(null);
                setBusy('continue');
                void proceed(identity.method, identity);
              }}
            />
          </Animated.View>
        )}
        {error ? (
          <Animated.Text entering={FadeIn.duration(DURATION.fast)} style={styles.error}>
            {error}
          </Animated.Text>
        ) : null}
        {restore ? null : <LabeledRule label="or" />}
      </>
    );
  }

  return (
    <>
      <SheetText center>
        {restore
          ? 'Sign in, then bring back your keys. They never leave your devices.'
          : 'No password or phrase to remember.'}
      </SheetText>
      <Animated.View style={[styles.buttons, compact && styles.buttonsCompact, shaken]}>
        {APPLE_SIGN_IN ? (
          <AuthButton
            label="Continue with Apple"
            icon={<AppleGlyph color={c.canvas} />}
            tone="inverse"
            busy={busy === 'apple'}
            disabled={!!busy}
            onPress={() => signIn('apple')}
          />
        ) : null}
        <AuthButton
          label="Continue with Google"
          icon={<GoogleGlyph />}
          busy={busy === 'google'}
          disabled={!!busy}
          onPress={() => signIn('google')}
        />
        <AuthButton
          label="Continue with email"
          icon={<Icon name="mail" size={18} color={c.text} />}
          disabled={!!busy}
          onPress={() =>
            go({ pathname: '/email', params: { intent: restore ? 'restore' : 'create' } })
          }
        />
      </Animated.View>
      {/* Why sign-in didn't work, under the buttons, until the next try. */}
      {error ? (
        <Animated.Text entering={FadeIn.duration(DURATION.fast)} style={styles.error}>
          {error}
        </Animated.Text>
      ) : null}
      <LabeledRule label="or" />
    </>
  );
}

function AuthButton({
  label,
  icon,
  tone = 'plain',
  busy,
  disabled,
  onPress,
}: {
  label: string;
  icon: ReactNode;
  tone?: 'plain' | 'inverse';
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const compact = useCompact();
  const c = useTheme();
  const inverse = tone === 'inverse';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.auth,
        compact && styles.authCompact,
        inverse && styles.authInverse,
        disabled && !busy && styles.dim,
      ]}
    >
      <View style={styles.authIcon}>
        {busy ? <ActivityIndicator color={inverse ? c.canvas : c.text} /> : icon}
      </View>
      <Text style={[styles.authLabel, inverse && styles.authLabelInverse]}>
        {busy ? 'Signing in…' : label}
      </Text>
    </PressableScale>
  );
}

/** The other ways in, as the same grey pills as Google and email. */
function MoreRow({
  icon,
  title,
  disabled,
  onPress,
}: {
  icon: IconName | 'phrase' | 'privateKey';
  title: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = useTheme();
  return (
    <AuthButton
      label={title}
      disabled={disabled}
      onPress={onPress}
      icon={
        icon === 'phrase' ? (
          <PhraseGlyph color={c.text} />
        ) : icon === 'privateKey' ? (
          <KeyGlyph color={c.text} />
        ) : (
          <Icon name={icon} size={18} color={c.text} />
        )
      }
    />
  );
}

/** Short windows (the extension's 600px popup): every way in still fits, no scrolling. */
const useCompact = () => useWindowDimensions().height < 700;

/** Google's four-colour G. */
function GoogleGlyph() {
  return (
    <Svg width={18} height={18} viewBox="0 0 48 48">
      <Path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <Path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <Path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <Path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </Svg>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  title: {
    marginTop: 8,
    marginBottom: 8,
    color: c.text,
    fontSize: 24,
    fontWeight: '600',
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  buttons: {
    marginTop: 20,
    gap: 10,
  },
  buttonsCompact: {
    marginTop: 12,
    gap: 8,
  },
  titleCompact: {
    marginTop: 0,
  },
  otherWays: {
    gap: 10,
  },
  link: {
    marginTop: 6,
    alignSelf: 'center',
    color: c.accentText,
    fontSize: 15,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.5,
  },
  error: {
    marginTop: 12,
    color: c.error,
    fontSize: 14,
    lineHeight: 19,
    textAlign: 'center',
  },
  auth: {
    height: 52,
    minHeight: 44,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: c.raised,
  },
  authCompact: {
    height: 44,
  },
  authInverse: {
    backgroundColor: c.text,
  },
  dim: {
    opacity: 0.5,
  },
  authIcon: {
    width: 20,
    alignItems: 'center',
  },
  authLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  authLabelInverse: {
    color: c.canvas,
  },
}));
