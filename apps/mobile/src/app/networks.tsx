import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { Chip } from '@/components/wallet/Chip';
import { TokenIcon } from '@/components/wallet/parts';
import { closeSheet, SheetScreen } from '@/components/wallet/Sheet';
import { CHAINS } from '@/lib/mock-wallet';
import { makeStyles, useTheme } from '@/theme';

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
          <Text style={styles.subtitle}>One Honey wallet holds addresses on each of these.</Text>
        }
      />
      <View style={styles.chips}>
        {CHAINS.map((ch) => (
          <Chip
            key={ch.name}
            label={ch.name}
            variant="filled"
            leading={<TokenIcon symbol={ch.symbol} size={22} />}
          />
        ))}
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
    borderRadius: 14,
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
