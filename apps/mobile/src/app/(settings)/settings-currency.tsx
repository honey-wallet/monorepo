import { Text } from 'react-native';
import { closeSheet, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { CURRENCIES, updateSettings, useSettings } from '@/lib/settings';
import { makeStyles } from '@/theme';

/** Each currency's flag: its code's first two letters are the country (EUR's are the EU). */
const flagOf = (code: string) =>
  String.fromCodePoint(...[...code.slice(0, 2)].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));

/**
 * Local currency picker: each currency's flag and full name, with the ISO code in grey
 * and a check on the current one, like the language picker.
 */
export default function CurrencySheet() {
  const styles = useStyles();
  const { currency } = useSettings();

  const choose = (code: string) => {
    tap();
    updateSettings({ currency: code });
    closeSheet();
  };

  return (
    <SheetScreen title="Local currency" scroll>
      {CURRENCIES.map(([code, name]) => (
        <SheetRow
          key={code}
          leading={
            <Text style={styles.flag} accessible={false}>
              {flagOf(code)}
            </Text>
          }
          title={name}
          value={code}
          accessory="check"
          selected={code === currency}
          onPress={() => choose(code)}
        />
      ))}
    </SheetScreen>
  );
}

const useStyles = makeStyles(() => ({
  flag: {
    fontSize: 24,
  },
}));
