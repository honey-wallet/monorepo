import { Redirect, useLocalSearchParams } from 'expo-router';
import { Toggle } from '@/components/motion/Toggle';
import { PillButton } from '@/components/onboarding/PillButton';
import {
  closeSheet,
  SheetField,
  SheetRow,
  SheetScreen,
  WalletSettingsRow,
} from '@/components/sheets/Sheet';
import { OptionChips } from '@/components/trade/TradeForm';
import { tap } from '@/lib/haptics';
import type { TradeMode } from '@/lib/settings';
import { useTradeModeAllowed } from '@/lib/trade-modes';
import {
  EXPIRIES,
  type MarginMode,
  PERP_LEVERAGE_STEPS,
  type PriceFormat,
  SLIPPAGES,
  updateTradePrefs,
  useTradePrefs,
} from '@/lib/trade-prefs';

const LEVERAGE = PERP_LEVERAGE_STEPS.map((n) => `${n}x` as const);
const MARGIN_HINT: Record<MarginMode, string> = {
  Cross: 'All your margin backs every position. Fewer liquidations, more at stake.',
  Isolated: 'Each position has its own margin. Only that margin can be lost.',
};

/**
 * Settings for the current Trade product (Swap has its own sheet). Changes apply
 * at once and set what each order form starts with.
 */
function TradeSettingsSheet() {
  const { mode = 'Perps' } = useLocalSearchParams<{ mode?: Exclude<TradeMode, 'Swap'> }>();
  const prefs = useTradePrefs();

  return (
    <SheetScreen
      title={`${mode} settings`}
      footer={<PillButton label="Done" onPress={closeSheet} />}
    >
      {mode === 'Perps' && (
        <>
          <SheetField
            label="Default leverage"
            hint="Where the order sheet starts. Markets with a lower maximum use their maximum."
          >
            <OptionChips
              options={LEVERAGE}
              value={`${prefs.perpLeverage}x`}
              onChange={(v) =>
                updateTradePrefs({
                  perpLeverage: Number.parseInt(v, 10) as (typeof PERP_LEVERAGE_STEPS)[number],
                })
              }
            />
          </SheetField>
          <SheetField label="Margin mode" hint={MARGIN_HINT[prefs.marginMode]}>
            <OptionChips<MarginMode>
              options={['Cross', 'Isolated']}
              value={prefs.marginMode}
              onChange={(marginMode) => updateTradePrefs({ marginMode })}
            />
          </SheetField>
          <SheetField
            label="Max slippage"
            hint="Market orders are cancelled if the price moves more than this."
          >
            <OptionChips
              options={SLIPPAGES}
              value={prefs.perpSlippage}
              onChange={(perpSlippage) => updateTradePrefs({ perpSlippage })}
            />
          </SheetField>
        </>
      )}

      {mode === 'Predict' && (
        <>
          <SheetField
            label="Show prices as"
            hint="A 51¢ share pays $1 if right, so it's also a 51% chance."
          >
            <OptionChips<PriceFormat>
              options={['Cents', 'Percent']}
              value={prefs.predictPrice}
              onChange={(predictPrice) => updateTradePrefs({ predictPrice })}
            />
          </SheetField>
          <SheetRow
            title="Alerts for saved markets"
            subtitle="When a saved market moves a lot or resolves"
            accessory={
              <Toggle
                accessibilityLabel="Alerts for saved markets"
                value={prefs.predictAlerts}
                onValueChange={(predictAlerts) => {
                  tap();
                  updateTradePrefs({ predictAlerts });
                }}
              />
            }
          />
        </>
      )}

      {mode === 'Futures' && (
        <>
          <SheetField label="Default expiry" hint="The contract date the form starts on.">
            <OptionChips
              options={EXPIRIES}
              value={prefs.futuresExpiry}
              onChange={(futuresExpiry) => updateTradePrefs({ futuresExpiry })}
            />
          </SheetField>
          <SheetField
            label="Max slippage"
            hint="Orders are cancelled if the price moves more than this."
          >
            <OptionChips
              options={SLIPPAGES}
              value={prefs.futuresSlippage}
              onChange={(futuresSlippage) => updateTradePrefs({ futuresSlippage })}
            />
          </SheetField>
        </>
      )}

      {mode === 'Options' && (
        <SheetField label="Default expiry" hint="The contract date the form starts on.">
          <OptionChips
            options={EXPIRIES}
            value={prefs.optionsExpiry}
            onChange={(optionsExpiry) => updateTradePrefs({ optionsExpiry })}
          />
        </SheetField>
      )}

      <WalletSettingsRow tradeTabs />
    </SheetScreen>
  );
}

/** Shared wallets can't use this product (see `lib/trade-modes.ts`); links land on Trade. */
export default function TradeSettingsSheetRoute() {
  return useTradeModeAllowed('Perps') ? <TradeSettingsSheet /> : <Redirect href="/trade" />;
}
