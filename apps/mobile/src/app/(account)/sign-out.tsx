import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { Checkbox } from '@/components/motion/Checkbox';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { confirmOwner } from '@/lib/auth';
import { failure, tap } from '@/lib/haptics';
import { leaveSheetTo } from '@/lib/navigation';
import { signOut } from '@/lib/onboarding';
import { showToast } from '@/lib/toast';
import { loadAccounts, type VaultAccount } from '@/lib/vault';
import { makeStyles, useTheme } from '@/theme';

const RULES: { icon: IconName; text: string }[] = [
  { icon: 'key', text: 'Keep the recovery phrase or private key for every wallet' },
  { icon: 'cloud', text: 'Cloud backup covers only your main phrase' },
  { icon: 'lock', text: 'Your money stays safe on the network' },
];

/** Every stored wallet needs its own recovery acknowledgement before deleting secrets. */
export default function SignOutSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [accounts, setAccounts] = useState<VaultAccount[] | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadAccounts()
      .then(setAccounts)
      .catch(() => showToast('Couldn’t load wallets. Reopen this screen'));
  }, []);
  const ready = accounts?.every((a) => confirmed.includes(a.id));

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

  return (
    // Family's safety tray: what happens, the rules that matter, then one tick per wallet.
    <SheetScreen>
      <View style={styles.tile}>
        <Icon name="warning" size={22} color={c.error} />
      </View>
      <Text style={styles.title}>Sign out of Honey?</Text>
      <Text style={styles.body}>
        This removes every wallet and its keys from this phone. Apple, Google and email can’t bring
        them back.
      </Text>
      <View style={styles.rules}>
        {RULES.map((r) => (
          <View key={r.text} style={styles.rule}>
            <Icon name={r.icon} size={15} color={c.textSecondary} />
            <Text style={styles.ruleText}>{r.text}</Text>
          </View>
        ))}
      </View>
      <View style={styles.check}>
        {accounts?.map((wallet) => (
          <Checkbox
            key={wallet.id}
            label={`I have the ${wallet.source.kind === 'key' ? 'private key' : 'recovery phrase'} for ${wallet.label}`}
            checked={confirmed.includes(wallet.id)}
            onChange={(checked) =>
              setConfirmed((prev) =>
                checked ? [...prev, wallet.id] : prev.filter((id) => id !== wallet.id),
              )
            }
          />
        ))}
        <Text
          accessibilityRole="button"
          style={styles.link}
          onPress={() => {
            tap();
            leaveSheetTo('/recovery-phrase');
          }}
        >
          Show my recovery phrase
        </Text>
      </View>

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
  rules: {
    marginTop: 16,
    paddingTop: 14,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.divider,
  },
  rule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  ruleText: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 14,
  },
  check: {
    marginTop: 16,
    padding: 14,
    gap: 14,
    borderRadius: 18,
    // Raised: a card-coloured block disappears on the tray in dark mode.
    backgroundColor: c.raised,
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
