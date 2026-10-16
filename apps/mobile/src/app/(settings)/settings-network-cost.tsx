import { useRef } from 'react';
import { closeSheet, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { type Settings, updateSettings, useSettings } from '@/lib/settings';

type Mode = Settings['networkCost'];

const OPTIONS: { value: Mode; label: string; hint: string; recommended?: boolean }[] = [
  {
    value: 'auto',
    label: 'Auto',
    hint: 'Network costs automatically calculated and optimized for fast, reliable transactions.',
    recommended: true,
  },
  {
    value: 'custom',
    label: 'Custom',
    hint: 'Fine-tune exact network costs for transactions.',
  },
];

/** Auto (recommended) or custom network cost for every transaction. */
export default function NetworkCostSheet() {
  const { networkCost } = useSettings();
  // Closes once, even if a second option is tapped before the sheet goes.
  const closing = useRef(false);

  const choose = (value: Mode) => {
    if (closing.current) return;
    closing.current = true;
    tap();
    updateSettings({ networkCost: value });
    setTimeout(closeSheet, 250);
  };

  return (
    <SheetScreen title="Network cost">
      {OPTIONS.map((o) => (
        <SheetRow
          key={o.value}
          title={o.label}
          subtitle={o.hint}
          value={o.recommended ? 'Recommended' : undefined}
          accessory="check"
          selected={o.value === networkCost}
          onPress={() => choose(o.value)}
        />
      ))}
    </SheetScreen>
  );
}
