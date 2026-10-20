import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { makeStyles, radius, useTheme } from '@/theme';

/** Explains Bunk mode in plain words. */
export default function BunkModeInfoSheet() {
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
        <Icon name="shield" size={24} color={c.accentText} />
      </View>
      <TextsReveal
        id="bunk-mode"
        align="center"
        first={<Text style={styles.title}>Bunk mode</Text>}
        second={
          <View>
            <Text style={styles.body}>
              Each transaction is signed by a key used once. The next key is set up ahead of time,
              and Honey pays the network fee.
            </Text>
            <Text style={styles.body}>Not live yet: it doesn't protect funds today.</Text>
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
    ...radius(26),
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
