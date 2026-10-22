import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { Toggle } from '@/components/motion/Toggle';
import { HeaderIconButton, PushedScreen, TokenIcon } from '@/components/wallet/parts';
import { BUNK_LIVE, type BunkAccount, bunkMode, loadBunkAccounts } from '@/lib/bunk-mode';
import { useCopy } from '@/lib/copy';
import { SHOW_DEMO_LABELS } from '@/lib/demo-money-copy';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import { bunkToggle, TEST_MODE } from '@/lib/test-mode';
import { showErrorToast, showToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';

/** Each chain's coin, shown beside its next key. */
const SYMBOL = { evm: 'ETH', solana: 'SOL' } as const;

/**
 * Bunk mode: every transaction signed by a fresh one-time owner key. Opt-in. The page is
 * the switch and, while it's on, the key that signs next on each chain.
 */
export default function BunkModeScreen() {
  const styles = useStyles();
  const c = useTheme();
  const { enabled: stored } = bunkMode.useValue();
  // Coming soon: off until Bunk is live, whatever an old saved value or test mode says.
  const enabled = BUNK_LIVE && stored && TEST_MODE;
  const [accounts, setAccounts] = useState<BunkAccount[] | null>(null);

  useEffect(() => {
    loadBunkAccounts()
      .then(setAccounts)
      .catch(() => setAccounts(null));
  }, []);

  const flip = (want: boolean) => {
    tap();
    const result = bunkToggle(want);
    bunkMode.set({ enabled: result.enabled });
    if (want && !result.enabled) showErrorToast(result.toast);
    else showToast(result.toast);
  };

  return (
    <PushedScreen
      title="Bunk mode"
      fallback="/smart-wallet"
      right={
        <HeaderIconButton
          bare
          icon="help"
          label="What is Bunk mode?"
          onPress={() => router.push('/bunk-mode-info')}
        />
      }
    >
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Icon name="shieldLock" size={24} color={c.accentText} />
        </View>
        <View style={styles.flex}>
          <Text style={styles.heroTitle}>Bunk mode</Text>
          <Text style={styles.sub}>
            {BUNK_LIVE ? 'A new key signs every transaction.' : 'Coming soon'}
          </Text>
        </View>
        <Toggle
          accessibilityLabel={BUNK_LIVE ? 'Bunk mode' : 'Bunk mode, coming soon'}
          value={enabled}
          onValueChange={flip}
          disabled={!BUNK_LIVE}
        />
      </View>
      {TEST_MODE && SHOW_DEMO_LABELS ? (
        <Text style={styles.note}>Test mode: sample data</Text>
      ) : null}

      {enabled && accounts ? (
        <>
          <Text style={styles.section}>Next key</Text>
          <View style={styles.group}>
            {accounts.map((a, i) => (
              <NextKeyRow key={a.chain} account={a} first={i === 0} />
            ))}
          </View>
          <Text style={styles.note}>Used once, then replaced by a new one.</Text>
        </>
      ) : null}
    </PushedScreen>
  );
}

function NextKeyRow({ account, first }: { account: BunkAccount; first: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  const { copied, copy } = useCopy(account.next, 'Key copied');
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${account.label} next key ${shortAddress(account.next)}. Copy`}
      scaleTo={0.98}
      onPress={copy}
      style={[styles.keyRow, !first && styles.keyRowDivider]}
    >
      <TokenIcon symbol={SYMBOL[account.chain]} size={36} ring={c.card} />
      <View style={styles.flex}>
        <Text style={styles.name}>{account.label}</Text>
        <Text style={styles.key} numberOfLines={1}>
          {shortAddress(account.next)}
        </Text>
      </View>
      <Icon name={copied ? 'check' : 'copy'} size={16} color={c.textSecondary} />
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  hero: {
    marginHorizontal: 20,
    marginTop: 8,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    ...radius(24),
    backgroundColor: c.card,
  },
  heroIcon: {
    width: 44,
    height: 44,
    ...radius(14),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  heroTitle: { color: c.text, fontSize: 17, fontWeight: '600' },
  name: { color: c.text, fontSize: 16, fontWeight: '500' },
  sub: { marginTop: 2, color: c.textSecondary, fontSize: 14 },
  key: { marginTop: 2, color: c.textSecondary, fontSize: 14, fontVariant: ['tabular-nums'] },
  section: {
    marginTop: 28,
    marginBottom: 8,
    paddingHorizontal: 20,
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  group: {
    marginHorizontal: 20,
    ...radius(24),
    backgroundColor: c.card,
    overflow: 'hidden',
  },
  keyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  keyRowDivider: {
    borderTopWidth: 1,
    borderTopColor: c.divider,
  },
  note: { marginTop: 10, paddingHorizontal: 20, color: c.textSecondary, fontSize: 13 },
}));
