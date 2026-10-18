import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Checkbox } from '@/components/motion/Checkbox';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { confirmOwner } from '@/lib/auth';
import { failure, tap } from '@/lib/haptics';
import { leaveSheetTo } from '@/lib/navigation';
import { signOut } from '@/lib/onboarding';
import { HERE } from '@/lib/platform';
import { showToast } from '@/lib/toast';
import { loadAccounts, type VaultAccount } from '@/lib/vault';
import { makeStyles, useTheme } from '@/theme';

/**
 * Two steps in one tray: what signing out does, then a tick for each wallet's phrase or
 * key. Every stored wallet needs its own tick before its secrets are deleted.
 */
/** Whether Show my phrase was used this session (it then gives way to Sign out alone). */
let phraseShown = false;

export default function SignOutSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [accounts, setAccounts] = useState<VaultAccount[] | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [step, setStep] = useState<'about' | 'check'>('about');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadAccounts()
      .then(setAccounts)
      .catch(() => showToast('Couldn’t load wallets. Reopen this screen'));
  }, []);
  const ready = accounts?.every((a) => confirmed.includes(a.id));
  // Nothing stored on this phone (signed in with Apple, Google or email): no ticks needed.
  const hasSecrets = (accounts?.length ?? 0) > 0;

  const confirm = async () => {
    if (!ready || busy) return;
    tap();
    setBusy(true);
    try {
      if (!(await confirmOwner('Sign out of Honey'))) {
        setBusy(false);
        return;
      }
      await signOut(confirmed);
    } catch {
      failure();
      setBusy(false);
      showToast('Couldn’t sign out. Try again.');
    }
  };

  const signOutButton = (
    <PillButton
      label={busy ? 'Signing out…' : 'Sign out'}
      variant="danger"
      disabled={!ready || busy}
      onPress={confirm}
      // Beside Cancel in a row, or full width under Show my phrase.
      style={step === 'about' ? styles.flex : undefined}
    />
  );

  return (
    <ContentSwap id={step} index={step === 'about' ? 0 : 1}>
      {step === 'about' ? (
        <SheetScreen>
          <View style={styles.tile}>
            <Icon name="warning" size={22} color={c.error} />
          </View>
          <Text style={styles.title}>Sign out?</Text>
          <Text style={styles.body}>
            Your wallets leave {HERE}. You’ll need your recovery phrase to get back in.
          </Text>
          <View style={styles.buttons}>
            <PillButton
              label="Cancel"
              variant="secondary"
              onPress={closeSheet}
              style={styles.flex}
            />
            {hasSecrets ? (
              <PillButton
                label="Continue"
                onPress={() => {
                  tap();
                  setStep('check');
                }}
                style={styles.flex}
              />
            ) : (
              signOutButton
            )}
          </View>
        </SheetScreen>
      ) : (
        <SheetScreen title="Saved your phrase?" onBack={() => setStep('about')}>
          <View style={styles.check}>
            {accounts?.map((wallet) => (
              <Checkbox
                key={wallet.id}
                // Said plainly: what you're confirming by ticking it.
                label={`I’ve saved the ${wallet.source.kind === 'key' ? 'private key' : 'recovery phrase'} for ${wallet.label}`}
                checked={confirmed.includes(wallet.id)}
                onChange={(checked) =>
                  setConfirmed((prev) =>
                    checked ? [...prev, wallet.id] : prev.filter((id) => id !== wallet.id),
                  )
                }
              />
            ))}
          </View>
          {/* A button like Sign out, until the phrase has been shown once. */}
          <View style={styles.stack}>
            {phraseShown ? null : (
              <PillButton
                label="Show my phrase"
                variant="secondary"
                onPress={() => {
                  tap();
                  phraseShown = true;
                  leaveSheetTo('/recovery-phrase');
                }}
              />
            )}
            {signOutButton}
          </View>
        </SheetScreen>
      )}
    </ContentSwap>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  tile: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${c.error}1F`,
  },
  title: {
    marginTop: 14,
    color: c.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  body: {
    marginTop: 4,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
  },
  check: {
    marginTop: 8,
    gap: 16,
  },
  link: {
    marginTop: 14,
    color: c.accentText,
    fontSize: 15,
    fontWeight: '600',
  },
  buttons: {
    marginTop: 24,
    flexDirection: 'row',
    gap: 10,
  },
  stack: {
    marginTop: 24,
    gap: 10,
  },
}));
