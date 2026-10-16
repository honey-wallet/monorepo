import { MIN_PASSWORD_LENGTH } from '@honey-wallet/keyring';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { IconSwap } from '@/components/motion/IconSwap';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { PushedScreen } from '@/components/wallet/parts';
import { CLOUD, saveBackupFile } from '@/lib/cloud-backup';
import { tap } from '@/lib/haptics';
import { completeStep } from '@/lib/onboarding';
import { updateSettings, useSettings } from '@/lib/settings';
import { showToast } from '@/lib/toast';
import { readPrimaryMnemonic } from '@/lib/vault';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/**
 * Cloud backup of the recovery phrase: encrypted on this device with a password the
 * user picks, then saved to iCloud Drive / Google Drive from the share sheet. Restoring
 * needs the file and the password; Honey never sees either.
 */
export default function CloudBackupScreen() {
  const styles = useStyles();
  const c = useTheme();
  const { backedUp } = useSettings();
  const [hasPhrase, setHasPhrase] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(!backedUp);
  const showForm = editing || hasPhrase === false;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    readPrimaryMnemonic()
      .then((phrase) => setHasPhrase(!!phrase))
      .catch(() => setHasPhrase(false));
  }, []);

  // Demo wallets have no phrase on the device, so there's nothing to back up yet.
  const status = hasPhrase === false ? 'No phrase yet' : backedUp ? 'Backed up' : 'Not backed up';
  const ok = hasPhrase !== false && backedUp;
  const tooShort = password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = hasPhrase && !tooShort && confirm === password && !busy;

  const backUp = async () => {
    tap();
    setBusy(true);
    try {
      await saveBackupFile(password);
      updateSettings({ backedUp: true });
      completeStep('backup');
      setEditing(false);
      setPassword('');
      setConfirm('');
      showToast('Backup saved');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Couldn’t make the backup');
    } finally {
      setBusy(false);
    }
  };

  const hint =
    hasPhrase === false
      ? 'Create or import a wallet first.'
      : mismatch
        ? 'The passwords don’t match.'
        : `At least ${MIN_PASSWORD_LENGTH} characters. You’ll need it to restore, and Honey can’t reset it.`;

  return (
    <PushedScreen
      title={`${CLOUD} backup`}
      fallback="/settings"
      contentStyle={styles.content}
      footer={
        showForm ? (
          <PillButton
            label={busy ? 'Encrypting…' : 'Back up now'}
            disabled={!ready}
            onPress={backUp}
            style={styles.flex}
          />
        ) : (
          <PillButton
            label="Back up again"
            variant="secondary"
            onPress={() => {
              tap();
              setEditing(true);
            }}
            style={styles.flex}
          />
        )
      }
    >
      <Text style={styles.body}>
        Your recovery phrase is locked with a password on this device, then saved to {CLOUD}. To
        restore on a new phone, pick the backup file and enter the password.
      </Text>
      <View style={styles.row}>
        <Text style={styles.label}>Recovery phrase</Text>
        <TextSwap text={status} style={styles.status} />
        <IconSwap name={ok ? 'check' : 'warning'} size={18} color={ok ? c.success : c.error} />
      </View>

      {showForm ? (
        <Animated.View entering={FadeIn.duration(DURATION.fast)} style={styles.form}>
          <Text style={styles.section}>Backup password</Text>
          <View style={styles.card}>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor={c.placeholder}
              secureTextEntry
              textContentType="newPassword"
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              style={styles.input}
            />
            <View style={styles.divider} />
            <TextInput
              value={confirm}
              onChangeText={setConfirm}
              placeholder="Confirm password"
              placeholderTextColor={c.placeholder}
              secureTextEntry
              textContentType="newPassword"
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              returnKeyType="done"
              onSubmitEditing={() => ready && backUp()}
              style={styles.input}
            />
          </View>
          <TextSwap
            text={hint}
            style={[styles.hint, (mismatch || hasPhrase === false) && { color: c.error }]}
          />
        </Animated.View>
      ) : null}
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  flex: {
    flex: 1,
  },
  body: {
    color: c.textSecondary,
    fontSize: 16,
    lineHeight: 23,
  },
  row: {
    marginTop: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  label: {
    flex: 1,
    color: c.text,
    fontSize: 17,
    fontWeight: '500',
  },
  status: {
    color: c.textSecondary,
    fontSize: 16,
  },
  form: {
    marginTop: 28,
  },
  section: {
    marginBottom: 10,
    color: c.textSecondary,
    fontSize: 15,
  },
  card: {
    borderRadius: 20,
    backgroundColor: c.card,
    paddingHorizontal: 16,
  },
  input: {
    height: 52,
    color: c.text,
    fontSize: 17,
  },
  divider: {
    height: 1,
    backgroundColor: c.canvas,
  },
  hint: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
}));
