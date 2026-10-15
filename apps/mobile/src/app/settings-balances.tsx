import { Toggle } from '@/components/motion/Toggle';
import { SheetRow, SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { type Settings, updateSettings, useSettings } from '@/lib/settings';

type Key = 'hideSmallBalances' | 'hideUnknownTokens' | 'hideReportedActivity';

const ROWS: { key: Key; title: string; hint: string }[] = [
  {
    key: 'hideSmallBalances',
    title: 'Hide small balances',
    hint: 'Balances under 1 USD will be hidden from your portfolio.',
  },
  {
    key: 'hideUnknownTokens',
    title: 'Hide unknown tokens',
    hint: 'Potential scam tokens will be hidden from your portfolio.',
  },
  {
    key: 'hideReportedActivity',
    title: 'Hide reported activity',
    hint: "Transactions you've reported as spam will be hidden from your activity feed.",
  },
];

/** What shows up in the portfolio and the activity feed. */
export default function BalancesSheet() {
  const settings = useSettings();

  const set = (key: Key, value: boolean) => {
    tap();
    updateSettings({ [key]: value } as Partial<Settings>);
  };

  return (
    <SheetScreen title="Balances and activity">
      {ROWS.map((r) => (
        <SheetRow
          key={r.key}
          title={r.title}
          subtitle={r.hint}
          accessory={
            <Toggle
              accessibilityLabel={r.title}
              value={settings[r.key]}
              onValueChange={(v) => set(r.key, v)}
            />
          }
        />
      ))}
    </SheetScreen>
  );
}
