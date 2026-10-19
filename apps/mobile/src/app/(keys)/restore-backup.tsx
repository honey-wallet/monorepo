import { type Backup, WrongPasswordError } from '@honey-wallet/keyring';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/sheets/Sheet';
import { CLOUD_NAMES, decryptBackup, pickBackupFile } from '@/lib/cloud-backup';
import { tap } from '@/lib/haptics';
import { finishOnboarding } from '@/lib/onboarding';
import { getProfile } from '@/lib/profile';
import { updateSettings } from '@/lib/settings';
import { showErrorToast, showToast } from '@/lib/toast';
import { importMnemonic, startWithMnemonic } from '@/lib/vault';
import { addVaultWallet } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/**
 * Restore from a backup file saved to iCloud Drive / Google Drive, in two steps on
 * one card: pick the file, then type its password. From onboarding the restored
 * phrase becomes this device's own.
 */
export default function RestoreBackupSheet() {
  const styles = useStyles();
  const c = useTheme();
  const { onboarding } = useLocalSearchParams<{ onboarding?: string }>();
  const [backup, setBackup] = useState<Backup | null>(null);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    tap();
    try {
      const picked = await pickBackupFile();
      if (picked) {
        setBackup(picked);
        setWrong(false);
      }
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : 'Couldn’t open file');
    }
  };

  const restore = async () => {
    if (!backup || !password) return;
    tap();
    setBusy(true);
    setWrong(false);
    try {
      const phrase = await decryptBackup(backup, password);
      const account = onboarding
        ? await startWithMnemonic(phrase, getProfile().name)
        : await importMnemonic(phrase, 'Restored wallet');
      addVaultWallet(account);
      // The phrase came from a backup, so it's backed up already.
      if (onboarding) {
        updateSettings({ backedUp: true });
        finishOnboarding('import');
        return;
      }
      showToast('Wallet restored');
      router.dismissAll();
    } catch (error) {
      setBusy(false);
      if (error instanceof WrongPasswordError) setWrong(true);
      else showErrorToast(error instanceof Error ? error.message : 'Couldn’t restore backup');
    }
  };

  const saved = backup
    ? new Date(backup.createdAt).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

  return (
    <SheetScreen
      contentStyle={styles.content}
      footer={
        backup ? (
          <PillButton
            label={busy ? 'Unlocking…' : 'Restore wallet'}
            disabled={!password || busy}
            onPress={restore}
            style={styles.flex}
          />
        ) : (
          <PillButton label="Choose backup file" onPress={choose} style={styles.flex} />
        )
      }
    >
      <View style={styles.hero}>
        <View style={styles.heroWell}>
          <Icon name="cloud" size={24} color={c.accentText} />
        </View>
        <TextsReveal
          id="restore-backup"
          align="center"
          first={<Text style={styles.title}>Restore from a backup</Text>}
          second={
            <Text style={styles.subtitle}>
              Use the backup you saved from Honey and the password you locked it with.
            </Text>
          }
        />
      </View>

      <View style={styles.card}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={backup ? 'Choose a different backup file' : 'Choose backup file'}
          onPress={choose}
          scaleTo={0.98}
          style={styles.step}
        >
          <StepMark n={1} done={!!backup} />
          <View style={styles.flex}>
            <Text style={styles.stepTitle}>{backup ? 'Honey wallet backup' : 'Backup file'}</Text>
            <TextSwap
              text={backup ? `Saved ${saved}` : `From ${CLOUD_NAMES}`}
              style={styles.stepHint}
            />
          </View>
          <Text style={styles.link}>{backup ? 'Change' : 'Choose'}</Text>
        </PressableScale>

        <View style={styles.divider} />

        <View style={[styles.step, !backup && styles.dim]}>
          <StepMark n={2} done={false} />
          <View style={styles.flex}>
            {backup ? (
              <Animated.View entering={FadeIn.duration(DURATION.fast)}>
                <TextInput
                  autoFocus
                  value={password}
                  onChangeText={(v) => {
                    setPassword(v);
                    setWrong(false);
                  }}
                  placeholder="Backup password"
                  placeholderTextColor={c.placeholder}
                  secureTextEntry
                  textContentType="password"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  returnKeyType="done"
                  onSubmitEditing={restore}
                  style={styles.input}
                />
              </Animated.View>
            ) : (
              <>
                <Text style={styles.stepTitle}>Password</Text>
                <Text style={styles.stepHint}>The one you chose when backing up</Text>
              </>
            )}
          </View>
        </View>
      </View>

      <TextSwap
        text={wrong ? 'That password doesn’t open this backup. Try again.' : ' '}
        style={styles.error}
      />
    </SheetScreen>
  );
}

/** A step's number, or a tick once it's done. */
function StepMark({ n, done }: { n: number; done: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={[styles.mark, done && { backgroundColor: c.success }]}>
      {done ? (
        <IconSwap name="check" size={13} color={c.onPrimary} />
      ) : (
        <Text style={styles.markText}>{n}</Text>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  content: {
    paddingTop: 8,
  },
  hero: {
    alignItems: 'center',
  },
  heroWell: {
    width: 56,
    height: 56,
    borderRadius: 28,
    marginBottom: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  title: {
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    paddingHorizontal: 12,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  card: {
    marginTop: 24,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  step: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  dim: {
    opacity: 0.5,
  },
  divider: {
    height: 1,
    marginLeft: 58,
    backgroundColor: c.raised,
  },
  mark: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  markText: {
    color: c.text,
    fontSize: 14,
    fontWeight: '600',
  },
  stepTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  stepHint: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  link: {
    color: c.accentText,
    fontSize: 15,
    fontWeight: '600',
  },
  input: {
    height: 44,
    color: c.text,
    fontSize: 17,
  },
  error: {
    marginTop: 10,
    color: c.error,
    fontSize: 14,
    textAlign: 'center',
  },
}));
