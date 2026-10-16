import { MIN_PASSWORD_LENGTH } from '@honey-wallet/keyring';
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { CloudLogo } from '@/components/logo/CloudLogo';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { PushedScreen } from '@/components/wallet/parts';
import {
  AVAILABLE,
  type CloudProvider,
  PROVIDERS,
  saveBackupFile,
  setBackupProvider,
  useBackupPrefs,
} from '@/lib/cloud-backup';
import { tap } from '@/lib/haptics';
import { completeStep } from '@/lib/onboarding';
import { updateSettings, useSettings } from '@/lib/settings';
import { showToast } from '@/lib/toast';
import { readPrimaryMnemonic } from '@/lib/vault';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/**
 * Cloud backup of the recovery phrase: encrypted on this device with a password the
 * user picks, then saved to iCloud Drive or Google Drive (their choice; Android has
 * Google Drive only) from the share sheet. Restoring needs the file and the password;
 * Honey never sees either.
 */
export default function CloudBackupScreen() {
  const styles = useStyles();
  const c = useTheme();
  const { backedUp } = useSettings();
  const { provider, savedTo } = useBackupPrefs();
  const where = PROVIDERS[provider].name;
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
  const status =
    hasPhrase === false
      ? 'No phrase yet'
      : backedUp
        ? savedTo
          ? `Saved to ${PROVIDERS[savedTo].name}`
          : 'Backed up'
        : 'Not backed up';
  const ok = hasPhrase !== false && backedUp;
  const tooShort = password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = hasPhrase && !tooShort && confirm === password && !busy;

  const backUp = async () => {
    tap();
    setBusy(true);
    try {
      await saveBackupFile(password, provider);
      updateSettings({ backedUp: true });
      completeStep('backup');
      setEditing(false);
      setPassword('');
      setConfirm('');
      showToast(`Backup saved to ${where}`);
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
      title="Cloud backup"
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
        Your recovery phrase is locked with a password on this device, then saved to {where}. To
        restore on a new phone, pick the backup file and enter the password.
      </Text>
      <View style={styles.row}>
        <Text style={styles.label}>Recovery phrase</Text>
        <TextSwap text={status} style={styles.status} />
        <IconSwap name={ok ? 'check' : 'warning'} size={18} color={ok ? c.success : c.error} />
      </View>

      {showForm ? (
        <Animated.View entering={FadeIn.duration(DURATION.fast)} style={styles.form}>
          {AVAILABLE.length > 1 ? (
            <>
              <Text style={styles.section}>Save to</Text>
              <View style={styles.providers} accessibilityRole="radiogroup">
                {AVAILABLE.map((p) => (
                  <ProviderOption
                    key={p}
                    provider={p}
                    selected={p === provider}
                    disabled={busy}
                    onPress={() => {
                      tap();
                      setBackupProvider(p);
                    }}
                  />
                ))}
              </View>
            </>
          ) : null}

          <Text style={[styles.section, AVAILABLE.length > 1 && styles.sectionGap]}>
            Backup password
          </Text>
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
          {hasPhrase ? (
            <View style={styles.tip}>
              <CloudLogo provider={provider} size={16} />
              <TextSwap text={PROVIDERS[provider].tip} style={styles.tipText} />
            </View>
          ) : null}
        </Animated.View>
      ) : null}
    </PushedScreen>
  );
}

/** One provider to back up to: its logo and name in a card, outlined when picked. */
function ProviderOption({
  provider,
  selected,
  disabled,
  onPress,
}: {
  provider: CloudProvider;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={PROVIDERS[provider].name}
      disabled={disabled}
      onPress={onPress}
      scaleTo={0.97}
      style={[styles.provider, selected && styles.providerSelected]}
    >
      <View style={styles.providerLogo}>
        <CloudLogo provider={provider} />
      </View>
      <Text style={styles.providerName}>{PROVIDERS[provider].name}</Text>
    </PressableScale>
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
  sectionGap: {
    marginTop: 24,
  },
  providers: {
    flexDirection: 'row',
    gap: 10,
  },
  provider: {
    flex: 1,
    alignItems: 'center',
    gap: 10,
    paddingVertical: 16,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: c.card,
  },
  // Picked: outlined on the card, never a honey tint (that reads as disabled).
  providerSelected: {
    borderColor: c.text,
  },
  providerLogo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.sheet,
  },
  providerName: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  tip: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 16,
    backgroundColor: c.card,
  },
  tipText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
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
