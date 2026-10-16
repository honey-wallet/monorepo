import { closeSheet, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { CURRENCIES, updateSettings, useSettings } from '@/lib/settings';

/** Local currency picker: full name with the ISO code in grey, a check on the current one. */
export default function CurrencySheet() {
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
