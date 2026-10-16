import { type Href, Redirect, router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Icon, type IconName } from '@/components/Icon';
import { AppleGlyph } from '@/components/logo/AppleGlyph';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { LabeledRule } from '@/components/wallet/parts';
import { SheetScreen, SheetText } from '@/components/wallet/Sheet';
import { CLOUD } from '@/lib/cloud-backup';
import { tap } from '@/lib/haptics';
import { finishOnboarding } from '@/lib/onboarding';
import { makeStyles, useTheme } from '@/theme';

/** How long the placeholder Apple / Google sign-in takes. */
const SIGN_IN_MS = 1100;

/**
 * The two ways in, after Phantom: Apple, Google or email first (no recovery phrase to
 * write down and no password, so nothing to lose people on before the wallet exists),
 * with a recovery phrase or an import tucked under them for people who want it.
 *
 *   create  → Continue with Apple / Google / email, or create with a recovery phrase
 *   restore → Continue with Apple / Google / email, or import a phrase or private key
 */
export default function GetStartedSheet() {
  const { mode = 'create' } = useLocalSearchParams<{ mode?: 'create' | 'restore' }>();
  const restore = mode === 'restore';
  const styles = useStyles();
  const c = useTheme();
  const [signingIn, setSigningIn] = useState<'apple' | 'google' | null>(null);

  // A sheet over Welcome only. Opened on its own (a reload that reopens a deep link),
  // it would be a bare page with nothing under it, so start from Welcome instead.
  if (!router.canGoBack()) return <Redirect href="/welcome" />;

  // TODO: real Sign in with Apple / Google (an embedded-wallet provider) once the
  // server has accounts; for now it pauses as if signing in and opens the wallet.
  const social = (provider: 'apple' | 'google') => {
    tap();
    setSigningIn(provider);
    setTimeout(() => finishOnboarding(provider, { restored: restore }), SIGN_IN_MS);
  };
  // Leave the sheet, then open the next step full screen.
  const go = (href: Href) => {
    tap();
    router.back();
    router.push(href);
  };

  return (
    <SheetScreen>
      <Text style={styles.title}>{restore ? 'Use an existing wallet' : 'Create a new wallet'}</Text>
      <SheetText>
        {restore ? 'Sign in the way you created it.' : 'No password or phrase to remember.'}
      </SheetText>

      <View style={styles.buttons}>
        <AuthButton
          label="Continue with Apple"
          icon={<AppleGlyph color={c.canvas} />}
          tone="inverse"
          busy={signingIn === 'apple'}
          disabled={!!signingIn}
          onPress={() => social('apple')}
        />
        <AuthButton
          label="Continue with Google"
          icon={<GoogleGlyph />}
          busy={signingIn === 'google'}
          disabled={!!signingIn}
          onPress={() => social('google')}
        />
        <AuthButton
          label="Continue with email"
          icon={<Icon name="mail" size={18} color={c.text} />}
          disabled={!!signingIn}
          onPress={() => go({ pathname: '/email', params: { intent: mode } })}
        />
      </View>

      <LabeledRule label="or" />

      {restore ? (
        <View style={styles.more}>
          <MoreRow
            icon="recovery"
            title="Import a recovery phrase"
            hint="12 or 24 words from another wallet"
            onPress={() => go({ pathname: '/import-wallet', params: { onboarding: '1' } })}
          />
          <MoreRow
            icon="cloud"
            title={`Restore from ${CLOUD}`}
            hint="A Honey backup file and its password"
            onPress={() => go({ pathname: '/restore-backup', params: { onboarding: '1' } })}
          />
          <MoreRow
            icon="key"
            title="Import a private key"
            hint="For a single account"
            onPress={() =>
              go({ pathname: '/import-wallet', params: { onboarding: '1', kind: 'key' } })
            }
          />
        </View>
      ) : (
        <View style={styles.more}>
          <MoreRow
            icon="recovery"
            title="Create with a recovery phrase"
            hint="You keep 12 words safe"
            onPress={() => go({ pathname: '/recovery-phrase', params: { onboarding: '1' } })}
          />
        </View>
      )}
    </SheetScreen>
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
  const c = useTheme();
  const inverse = tone === 'inverse';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.auth, inverse && styles.authInverse, disabled && !busy && styles.dim]}
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

function MoreRow({
  icon,
  title,
  hint,
  onPress,
}: {
  icon: IconName;
  title: string;
  hint: string;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableRow accessibilityRole="button" onPress={onPress} style={styles.row}>
      <View style={styles.well}>
        <Icon name={icon} size={17} color={c.text} />
      </View>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowHint}>{hint}</Text>
      </View>
      <Icon name="chevronRight" size={12} color={c.textSecondary} />
    </PressableRow>
  );
}

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
  auth: {
    height: 52,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: c.raised,
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
  more: {
    marginHorizontal: -8,
  },
  row: {
    minHeight: 60,
    paddingHorizontal: 8,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  well: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  rowTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  rowHint: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
}));
