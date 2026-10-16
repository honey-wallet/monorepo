import { Toggle } from '@/components/motion/Toggle';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { updateSettings, useSettings } from '@/lib/settings';

/** Opt in or out of anonymous usage analytics. */
export default function PermissionsSheet() {
  const { analytics } = useSettings();

  return (
    <SheetScreen title="Permissions">
      <SheetRow
        title="App analytics"
        subtitle="We use anonymous usage data to improve Honey. When off, we only track errors and essential usage."
        accessory={
          <Toggle
            accessibilityLabel="App analytics"
            value={analytics}
            onValueChange={(v) => {
              tap();
              updateSettings({ analytics: v });
            }}
          />
        }
      />
    </SheetScreen>
  );
}
