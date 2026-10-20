import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { HEADER_BUTTON } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { HIDDEN_AMOUNT, useSettings } from '@/lib/settings';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, radius } from '@/theme';

/**
 * Top-right of the Trade, Savings and Search tabs: your balance in dollars (opens
 * the balance sheet, where you can deposit more) and a bare settings gear, matching
 * Home's header icons. The gear opens the app's Settings unless the tab
 * passes its own (Trade opens the current product's settings).
 */
export function HeaderActions({
  settingsLabel = 'Settings',
  onSettings = () => router.push('/settings'),
  balance: showBalance = true,
}: {
  settingsLabel?: string;
  onSettings?: () => void;
  /** Off where the page's own number is the hero (Savings), so two totals don't compete. */
  balance?: boolean;
}) {
  const styles = useStyles();
  const { hideBalance } = useSettings();
  const { usd } = useWalletView();
  const balance = hideBalance ? HIDDEN_AMOUNT : formatUsd(usd);
  return (
    <View style={styles.row}>
      {showBalance ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={
            hideBalance ? 'Balance hidden. Deposit' : `Balance ${balance}. Deposit`
          }
          scaleTo={0.97}
          onPress={() => {
            tap();
            router.push('/balance');
          }}
          style={styles.balance}
        >
          <Text style={styles.balanceText} numberOfLines={1}>
            {balance}
          </Text>
          <Text style={styles.deposit}>Deposit</Text>
        </PressableScale>
      ) : null}
      <HeaderShortcut icon="settings" label={settingsLabel} onPress={onSettings} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  // Two lines like a wallet card: what you hold, and the way to add more.
  balance: {
    minHeight: HEADER_BUTTON,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    ...radius(14),
    backgroundColor: c.raised,
  },
  balanceText: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
  deposit: {
    color: c.primary,
    fontSize: 13,
    fontWeight: '700',
  },
}));
