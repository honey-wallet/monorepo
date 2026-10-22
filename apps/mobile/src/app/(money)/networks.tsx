import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { Chip } from '@/components/wallet/Chip';
import { NetworkGrid, TokenIcon } from '@/components/wallet/parts';
// import { CHAINS } from '@/lib/mock-wallet';
import { makeStyles, radius, useTheme } from '@/theme';

/** Every EVM chain shares the Ethereum address (lib/receive.ts), so these all work. NEAR is phrase wallets only. */
const NETWORKS = [
  { name: 'Solana', symbol: 'SOL' },
  { name: 'NEAR', symbol: 'NEAR' },
  { name: 'Ethereum', symbol: 'ETH' },
  { name: 'Base', symbol: 'BASE' },
  { name: 'Arbitrum', symbol: 'ARB' },
  { name: 'Optimism', symbol: 'OP' },
  { name: 'Polygon', symbol: 'POL' },
  { name: 'BNB Chain', symbol: 'BNB' },
  { name: 'Avalanche', symbol: 'AVAX' },
];

export default function NetworksSheet() {
  const styles = useStyles();
  const c = useTheme();
  return (
    <SheetScreen
      contentStyle={styles.hero}
      footer={<PillButton label="Close" variant="secondary" onPress={closeSheet} />}
    >
      <View style={styles.icon}>
        <Icon name="globe" size={22} color={c.text} />
      </View>
      <TextsReveal
        id="networks"
        align="center"
        first={<Text style={styles.title}>Supported networks</Text>}
        second={
          // <Text style={styles.subtitle}>One Honey wallet holds addresses on each of these.</Text>
          <Text style={styles.subtitle}>
            Solana, NEAR and 200+ EVM chains, all in one Honey wallet.
          </Text>
        }
      />
      <View style={styles.chips}>
        {/* review: the chains people know by name, then the rest of the EVM ones.
        {CHAINS.map((ch) => (
          <Chip key={ch.name} label={ch.name} variant="filled" leading={<TokenIcon symbol={ch.symbol} size={22} />} />
        ))} */}
        {NETWORKS.map((ch) => (
          <Chip
            key={ch.name}
            label={ch.name}
            variant="filled"
            leading={<TokenIcon symbol={ch.symbol} size={22} />}
          />
        ))}
        <Chip label="200+ more EVM chains" variant="filled" leading={<NetworkGrid size={22} />} />
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  hero: {
    alignItems: 'center',
  },
  icon: {
    width: 48,
    height: 48,
    ...radius(14),
    marginBottom: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  title: {
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    textAlign: 'center',
  },
  chips: {
    marginTop: 20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
}));
