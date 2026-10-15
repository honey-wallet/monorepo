import { type Href, router } from 'expo-router';
import { View } from 'react-native';
import { Icon } from '@/components/Icon';
import { TextSwap } from '@/components/motion/TextSwap';
import { Toggle } from '@/components/motion/Toggle';
import { SheetRow, SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { updateSettings, useSettings } from '@/lib/settings';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

/** Advanced settings: testnets, network cost, app data and smart wallets. */
export default function AdvancedSheet() {
  const styles = useStyles();
  const c = useTheme();
  const { testnet, networkCost } = useSettings();

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
        // The value swaps (transitions.dev "Text states swap") when it changes.
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
