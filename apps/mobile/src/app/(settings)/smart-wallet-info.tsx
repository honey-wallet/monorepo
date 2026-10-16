import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';

/** Explains what turning a wallet into a smart wallet does. */
export default function SmartWalletInfoSheet() {
  const styles = useStyles();
  const c = useTheme();
  return (
    <SheetScreen
      contentStyle={styles.hero}
      footer={
        <PillButton
          label="Close"
          variant="secondary"
          onPress={() => {
            tap();
            closeSheet();
          }}
        />
      }
    >
      <View style={styles.iconTile}>
        <Icon name="wallet" size={24} color={c.accentText} />
      </View>
      <TextsReveal
        id="smart-wallets"
        align="center"
        first={<Text style={styles.title}>Smart wallets</Text>}
        second={
          <View>
            <Text style={styles.body}>
              Smart wallets give you faster, low-cost transactions using smart contracts. Your keys
              still never leave this device.
            </Text>
            <Text style={styles.body}>
              Wallets already using smart wallet features in another app won't be affected.
            </Text>
          </View>
        }
      />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  hero: {
    alignItems: 'center',
  },
  iconTile: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
    marginBottom: 16,
  },
  title: {
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  body: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
}));
