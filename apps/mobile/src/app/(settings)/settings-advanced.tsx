import { type Href, router } from 'expo-router';
import { View } from 'react-native';
import { Icon } from '@/components/Icon';
import { TextSwap } from '@/components/motion/TextSwap';
import { Toggle } from '@/components/motion/Toggle';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { updateSettings, useSettings } from '@/lib/settings';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

/** Advanced settings: testnets, network cost, app data and smart wallets. */
export default function AdvancedSheet() {
  const styles = useStyles();
  const c = useTheme();
  const { testnet, networkCost, simulateFailures } = useSettings();

  /** Full pages open over Settings, so the sheet gets out of the way first. */
  const openPage = (href: Href) => {
    tap();
    router.dismiss();
    router.push(href);
  };

  return (
    <SheetScreen title="Advanced settings">
      <SheetRow
        icon="wrench"
        title="Testnet mode"
        accessory={
          <Toggle
            accessibilityLabel="Testnet mode"
            value={testnet}
            onValueChange={(v) => {
              tap();
              updateSettings({ testnet: v });
              showToast(v ? 'Testnet mode on' : 'Testnet mode off');
            }}
          />
        }
      />
      <SheetRow
        icon="gas"
        title="Network cost"
        // The value crossfades with a small lift when it changes.
        accessory={
          <View style={styles.trailing}>
            <TextSwap text={networkCost === 'auto' ? 'Auto' : 'Custom'} style={styles.value} />
            <Icon name="chevronRight" size={14} color={c.textSecondary} />
          </View>
        }
        onPress={() => {
          tap();
          router.push('/settings-network-cost');
        }}
      />
      {/* DEMO: until real transactions exist, the only way to see the failure pages. */}
      <SheetRow
        icon="warning"
        title="Simulate failures"
        accessory={
          <Toggle
            accessibilityLabel="Simulate failures"
            value={simulateFailures}
            onValueChange={(v) => {
              tap();
              updateSettings({ simulateFailures: v });
              showToast(v ? 'Payments and orders will fail' : 'Payments and orders will succeed');
            }}
          />
        }
      />
      <SheetRow
        icon="box"
        title="App data"
        accessory="chevron"
        onPress={() => openPage('/app-data')}
      />
      <SheetRow
        icon="wallet"
        title="Smart wallet"
        accessory="chevron"
        onPress={() => openPage('/smart-wallet')}
      />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  value: {
    color: c.textSecondary,
    fontSize: 16,
  },
}));
