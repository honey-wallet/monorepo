import { Toggle } from '@/components/motion/Toggle';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { updateSettings, useSettings } from '@/lib/settings';

/** When Honey asks for Face ID: opening the app and/or approving transactions. */
export default function FaceIdSheet() {
  const { faceIdAppAccess, faceIdTransactions } = useSettings();

  return (
    <SheetScreen title="Face ID">
      <SheetRow
        title="App access"
        subtitle="Require Face ID to open app."
        accessory={
          <Toggle
            accessibilityLabel="Require Face ID to open app"
            value={faceIdAppAccess}
            onValueChange={(v) => {
              tap();
              updateSettings({ faceIdAppAccess: v });
            }}
          />
        }
      />
      <SheetRow
        title="Transactions"
        subtitle="Require Face ID to transact."
        accessory={
          <Toggle
            accessibilityLabel="Require Face ID to transact"
            value={faceIdTransactions}
            onValueChange={(v) => {
              tap();
              updateSettings({ faceIdTransactions: v });
            }}
          />
        }
      />
    </SheetScreen>
  );
}
