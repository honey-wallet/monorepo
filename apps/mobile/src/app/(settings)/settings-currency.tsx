import { Text } from 'react-native';
import { closeSheet, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { CURRENCIES, updateSettings, useSettings } from '@/lib/settings';
import { makeStyles } from '@/theme';

/**
 * Each currency's flag, written out as literal emoji like the language list. Building
 * them at runtime from regional-indicator code points rendered as missing-glyph boxes
 * in the iOS Release build, while the same literal flags render fine.
 */
const FLAGS: Record<string, string> = {
  USD: '🇺🇸',
  ARS: '🇦🇷',
  AUD: '🇦🇺',
  BRL: '🇧🇷',
  CAD: '🇨🇦',
  CNY: '🇨🇳',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  HKD: '🇭🇰',
  IDR: '🇮🇩',
  INR: '🇮🇳',
  JPY: '🇯🇵',
  KRW: '🇰🇷',
  MXN: '🇲🇽',
  NZD: '🇳🇿',
  SGD: '🇸🇬',
  CHF: '🇨🇭',
};

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
              {FLAGS[code] ?? '🏳️'}
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
