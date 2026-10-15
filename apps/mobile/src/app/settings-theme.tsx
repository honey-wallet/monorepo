import type { IconName } from '@/components/Icon';
import { closeSheet, SheetRow, SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { setTheme, type ThemePreference, useSettings } from '@/lib/settings';

const OPTIONS: { value: ThemePreference; label: string; hint: string; icon: IconName }[] = [
  { value: 'auto', label: 'Auto', hint: "Adapts to your device's settings.", icon: 'theme' },
  { value: 'light', label: 'Light', hint: 'Always use light theme.', icon: 'sun' },
  { value: 'dark', label: 'Dark', hint: 'Always use dark theme.', icon: 'moon' },
];

/** Theme picker: Auto follows the device, Light and Dark override it. */
export default function ThemeSheet() {
  const { theme } = useSettings();

  const choose = (value: ThemePreference) => {
    tap();
    setTheme(value);
    closeSheet();
  };

  return (
    <SheetScreen title="Theme">
      {OPTIONS.map((o) => (
        <SheetRow
          key={o.value}
          icon={o.icon}
          title={o.label}
          subtitle={o.hint}
          accessory="check"
          selected={o.value === theme}
          onPress={() => choose(o.value)}
        />
      ))}
    </SheetScreen>
  );
}
