import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Linking, Text } from 'react-native';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { makeStyles } from '@/theme';

const PRIVACY_URL = 'https://honeywallet.app/privacy';
const TERMS_URL = 'https://honeywallet.app/terms';

/** Legal links, plus the app version. */
export default function AboutSheet() {
  const styles = useStyles();
  const version = Constants.expoConfig?.version ?? '—';

  const open = (url: string) => {
    tap();
    Linking.openURL(url);
  };

  return (
    <SheetScreen title="About">
      <SheetRow
        icon="lock"
        title="Privacy Policy"
        accessory="chevron"
        onPress={() => open(PRIVACY_URL)}
      />
      <SheetRow
        icon="book"
        title="Terms of Service"
        accessory="chevron"
        onPress={() => open(TERMS_URL)}
      />
      <SheetRow
        icon="recovery"
        title="Disclosures"
        accessory="chevron"
        onPress={() => {
          tap();
          router.dismiss();
          router.push('/disclosures');
        }}
      />
      <Text style={styles.version}>Honey {version}</Text>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  version: {
    marginTop: 18,
    color: c.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
}));
