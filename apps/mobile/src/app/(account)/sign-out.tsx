import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Checkbox } from '@/components/motion/Checkbox';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { confirmOwner } from '@/lib/auth';
import { failure, tap } from '@/lib/haptics';
import { signOut, useOnboarding } from '@/lib/onboarding';
import { showToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

/**
 * Sign out: the wallet comes off this phone. What it says depends on how you'd get
 * back in. With Apple, Google or email the account brings it back; with a recovery
 * phrase, only the phrase does, so it asks you to confirm you have it (and offers to
 * show it) before Sign out turns on. Face ID confirms it's you.
 */
export default function SignOutSheet() {
  const styles = useStyles();
  const { method } = useOnboarding();
  const [hasPhrase, setHasPhrase] = useState(false);
  const [busy, setBusy] = useState(false);
  const account =
    method === 'apple'
      ? 'Apple'
      : method === 'google'
        ? 'Google'
        : method === 'email'
          ? 'email'
          : null;
  const ready = !!account || hasPhrase;

  const confirm = async () => {
    tap();
    setBusy(true);
    if (!(await confirmOwner('Sign out of Honey'))) {
      setBusy(false);
      return;
    }
    try {
      await signOut();
    } catch {
      failure();
      setBusy(false);
      showToast('Couldn’t sign out. Try again.');
    }
  };

  return (
    <SheetScreen>
      <Text style={styles.title}>Sign out of Honey?</Text>
      <SheetText>
        {account
          ? `This removes the wallet from this phone. Your money stays safe, and you can sign back in with ${account === 'email' ? 'your email' : `your ${account} account`} any time.`
          : 'This removes the wallet from this phone. Your money stays safe, but the only way back in is your 12-word recovery phrase.'}
      </SheetText>

      {account ? null : (
        <View style={styles.check}>
          <Checkbox
            label="I have my recovery phrase written down"
            checked={hasPhrase}
            onChange={setHasPhrase}
          />
          <Text
            style={styles.link}
            onPress={() => {
              tap();
              router.back();
              router.push('/recovery-phrase');
            }}
          >
            Show my recovery phrase
          </Text>
        </View>
      )}

      <View style={styles.buttons}>
        <PillButton label="Cancel" variant="secondary" onPress={closeSheet} style={styles.flex} />
        <PillButton
          label={busy ? 'Signing out…' : 'Sign out'}
          variant="danger"
          disabled={!ready || busy}
          onPress={confirm}
          style={styles.flex}
        />
      </View>
    </SheetScreen>
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
  check: {
    marginTop: 16,
    gap: 14,
  },
  link: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '600',
  },
  buttons: {
    marginTop: 24,
    flexDirection: 'row',
    gap: 10,
  },
}));
