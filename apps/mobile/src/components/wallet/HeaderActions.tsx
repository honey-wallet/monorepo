import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { HEADER_BUTTON, HeaderIconButton } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { HIDDEN_AMOUNT, useSettings } from '@/lib/settings';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles } from '@/theme';

/**
 * Top-right of the Trade, Savings and Search tabs: your balance in dollars (opens
 * the balance sheet, where you can deposit more) and a settings gear. The gear opens the app's Settings unless the tab
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
            hideBalance ? 'Balance hidden. Deposit more' : `Balance ${balance}. Deposit more`
          }
          scaleTo={0.97}
          onPress={() => {
            tap();
            router.push('/balance');
          }}
          style={styles.balance}
        >
          <Text style={styles.balanceText}>{balance}</Text>
        </PressableScale>
      ) : null}
      <HeaderIconButton icon="settings" label={settingsLabel} onPress={onSettings} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  balance: {
    height: HEADER_BUTTON,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: HEADER_BUTTON / 2,
    backgroundColor: c.raised,
  },
  balanceText: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
}));
