import { MIN_PASSWORD_LENGTH } from '@honey-wallet/keyring';
import { type ReactNode, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import { PasswordField } from '@/components/onboarding/PasswordField';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/sheets/Sheet';
import { InlineTray } from '@/components/sheets/Tray';
import { checkPassword, passwordRequest } from '@/lib/auth.web';
import { forgetSites } from '@/lib/dapp';
import { tap } from '@/lib/haptics';
import { persistence } from '@/lib/persistence';
import { vaultStatus, webVault } from '@/lib/secure-store.web';
import { hydrateWallets, walletLoad } from '@/lib/wallets';
import { makeStyles } from '@/theme';

/**
 * Honey in a browser: nothing opens until the password vault is set up and unlocked,
 * then the same app as on the phone. Also answers password checks for sensitive
 * actions (the browser's Face ID).
 */
export function AppGate({ children }: { children: ReactNode }) {
  const status = vaultStatus.useValue();
  const accounts = walletLoad.useValue();
  // Saved app state (jars, proposals, settings) is back in the stores before anything shows.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    void webVault.load();
    void persistence.ready.then(() => setRestored(true));
  }, []);
  useEffect(() => {
    if (status === 'unlocked' && !accounts.ready) void hydrateWallets();
  }, [status, accounts.ready]);

  if (status === 'new') return <CreatePassword />;
  if (status === 'locked') return <Unlock />;
  if (status !== 'unlocked' || !accounts.ready || !restored) return <Blank />;
  return (
    <>
      {children}
      <PasswordPrompt />
    </>
  );
}

function Blank() {
  const styles = useStyles();
  return <View style={styles.screen} />;
}

function Lockup({ title, body }: { title: string; body: string }) {
  const styles = useStyles();
  return (
    <>
      <HoneyLogo variant="mark" height={40} />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
    </>
  );
}

function CreatePassword() {
  const styles = useStyles();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const short = password.length < MIN_PASSWORD_LENGTH;
  const create = async () => {
    if (short) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== again) {
      setError('The passwords don’t match.');
      return;
    }
    tap();
    setBusy(true);
    try {
      await webVault.create(password);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : 'Couldn’t set up Honey. Try again.');
    }
  };
  return (
    <View style={styles.screen}>
      <View style={styles.center}>
        <Lockup title="Create a password" body="It unlocks Honey on this computer." />
        <View style={styles.fields}>
          <PasswordField
            autoFocus
            isNew
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setError(null);
            }}
          />
          <PasswordField
            isNew
            placeholder="Type it again"
            value={again}
            onChangeText={(t) => {
              setAgain(t);
              setError(null);
            }}
            onSubmit={create}
            error={!!error}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </View>
      <PillButton
        label={busy ? 'Setting up…' : 'Continue'}
        disabled={!password || !again || busy}
        onPress={create}
      />
    </View>
  );
}

function Unlock() {
  const styles = useStyles();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const [resetting, setResetting] = useState(false);
  const unlock = async () => {
    if (!password || busy) return;
    tap();
    setBusy(true);
    const ok = await webVault.unlock(password);
    setBusy(false);
    if (!ok) setWrong(true);
  };
  return (
    <View style={styles.screen}>
      <View style={styles.center}>
        <Lockup title="Welcome back" body="Enter your password to unlock." />
        <View style={styles.fields}>
          <PasswordField
            autoFocus
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setWrong(false);
            }}
            onSubmit={unlock}
            error={wrong}
          />
          {wrong ? <Text style={styles.error}>Wrong password.</Text> : null}
        </View>
        <Text
          accessibilityRole="button"
          style={styles.link}
          onPress={() => {
            tap();
            setResetting(true);
          }}
        >
          Forgot password?
        </Text>
      </View>
      <PillButton
        label={busy ? 'Unlocking…' : 'Unlock'}
        disabled={!password || busy}
        onPress={unlock}
      />
      <InlineTray onClose={() => setResetting(false)}>
        {resetting ? (
          <SheetScreen title="Reset Honey here?">
            <Text style={styles.trayBody}>
              Your wallets leave this browser. Pair your phone or use your phrase to get them back.
            </Text>
            <View style={styles.buttons}>
              <PillButton
                label="Cancel"
                variant="secondary"
                onPress={() => setResetting(false)}
                style={styles.flex}
              />
              <PillButton
                label="Reset"
                variant="danger"
                onPress={() => {
                  setResetting(false);
                  // Start clean: nothing from the old wallets stays in memory.
                  void Promise.all([webVault.reset(), persistence.clear(), forgetSites()]).then(
                    () => globalThis.location?.reload(),
                  );
                }}
                style={styles.flex}
              />
            </View>
          </SheetScreen>
        ) : null}
      </InlineTray>
    </View>
  );
}

/** Asks for the password before a sensitive action (see auth.web.ts). */
function PasswordPrompt() {
  const styles = useStyles();
  const request = passwordRequest.useValue();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const close = (ok: boolean) => {
    setPassword('');
    setWrong(false);
    request?.resolve(ok);
  };
  const confirm = async () => {
    if (!password || busy) return;
    setBusy(true);
    const ok = await checkPassword(password);
    setBusy(false);
    if (ok) close(true);
    else setWrong(true);
  };
  return (
    <InlineTray onClose={() => close(false)}>
      {request ? (
        <SheetScreen title={request.reason}>
          <PasswordField
            autoFocus
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setWrong(false);
            }}
            onSubmit={confirm}
            error={wrong}
          />
          {wrong ? <Text style={styles.error}>Wrong password.</Text> : null}
          <View style={styles.buttons}>
            <PillButton
              label={busy ? 'Checking…' : 'Confirm'}
              disabled={!password || busy}
              onPress={confirm}
              style={styles.flex}
            />
          </View>
        </SheetScreen>
      ) : null}
    </InlineTray>
  );
}

const useStyles = makeStyles((c) => ({
  screen: {
    flex: 1,
    padding: 24,
    backgroundColor: c.canvas,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    marginTop: 20,
    color: c.text,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  body: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 16,
    lineHeight: 22,
  },
  fields: {
    marginTop: 24,
    gap: 10,
  },
  error: {
    color: c.error,
    fontSize: 14,
  },
  link: {
    marginTop: 18,
    color: c.accentText,
    fontSize: 15,
    fontWeight: '600',
  },
  trayBody: {
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
  },
  buttons: {
    marginTop: 22,
    flexDirection: 'row',
    gap: 10,
  },
  flex: {
    flex: 1,
  },
}));
