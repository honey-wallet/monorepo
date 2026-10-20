import { useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PressableScale } from '@/components/motion/PressableScale';
import { Toggle } from '@/components/motion/Toggle';
import { PillButton } from '@/components/onboarding/PillButton';
import {
  closeSheet,
  SheetHeader,
  SheetRow,
  SheetScreen,
  SheetText,
  WalletSettingsRow,
} from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { showToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';

type Page = 'settings' | 'slippage' | 'options';
const ORDER: Page[] = ['settings', 'slippage', 'options'];
const DEADLINES = [10, 20, 30, 60];
/** How long "Saved" shows before the sheet closes. */
const SAVED_HOLD = 600;

/** Swap settings, after Uniswap's: nested pages slide side by side inside one sheet. */
export default function SwapSettingsSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [page, setPage] = useState<Page>('settings');
  const [autoSlippage, setAutoSlippage] = useState(true);
  const [slippage, setSlippage] = useState(5.5);
  const [smartRouting, setSmartRouting] = useState(true);
  const [deadline, setDeadline] = useState(30);

  const go = (next: Page) => {
    tap();
    setPage(next);
  };
  const [saved, setSaved] = useState(false);
  const save = () => {
    if (saved) return;
    tap();
    // "Save" morphs to "Saved", then the sheet closes.
    setSaved(true);
    setTimeout(() => {
      closeSheet();
      showToast('Swap settings saved');
    }, SAVED_HOLD);
  };
  const step = (delta: number) => {
    tap();
    setAutoSlippage(false);
    setSlippage((s) => Math.min(Math.max(Math.round((s + delta) * 10) / 10, 0.1), 50));
  };

  return (
    <SheetScreen
      inlineHeader
      footer={<PillButton label={saved ? 'Saved' : 'Save'} morph onPress={save} />}
    >
      <ContentSwap id={page} index={ORDER.indexOf(page)}>
        {page === 'settings' && (
          <View>
            <SheetHeader title="Swap settings" />
            <SheetRow
              title="Max slippage"
              value={`${autoSlippage ? 'Auto · ' : ''}${slippage.toFixed(2)}%`}
              accessory="chevron"
              onPress={() => go('slippage')}
            />
            <SheetRow
              title="Swap protection"
              subtitle="Private submission isn't available yet"
              accessory={
                <Toggle
                  accessibilityLabel="Swap protection"
                  value={false}
                  onValueChange={() => {}}
                />
              }
            />
            <SheetRow
              title="Trade options"
              value={smartRouting ? 'Default' : 'Custom'}
              accessory="chevron"
              onPress={() => go('options')}
            />
            <SheetRow
              title="Swap deadline"
              value={`${deadline} minutes`}
              accessory="chevron"
              onPress={() => {
                tap();
                setDeadline((d) => DEADLINES[(DEADLINES.indexOf(d) + 1) % DEADLINES.length]);
              }}
            />
            <WalletSettingsRow tradeTabs />
          </View>
        )}

        {page === 'slippage' && (
          <View>
            <SheetHeader title="Max slippage" onBack={() => go('settings')} />
            <SheetText>
              Your swap is cancelled if the price moves more than this before it goes through. For
              swaps with several steps, it applies to each step.
            </SheetText>
            <View style={styles.stepper}>
              <PressableScale
                accessibilityLabel="Decrease"
                scaleTo={0.97}
                onPress={() => step(-0.5)}
                style={styles.stepButton}
              >
                <Icon name="sell" size={22} color={c.textSecondary} />
              </PressableScale>
              <View style={styles.stepValue}>
                <PressableScale
                  onPress={() => {
                    tap();
                    setAutoSlippage(true);
                    setSlippage(5.5);
                  }}
                  scaleTo={0.97}
                >
                  <Text style={[styles.auto, !autoSlippage && styles.autoOff]}>Auto</Text>
                </PressableScale>
                <NumberPopIn value={slippage.toFixed(1)} style={styles.stepNumber} />
                <Text style={styles.stepNumber}>%</Text>
              </View>
              <PressableScale
                accessibilityLabel="Increase"
                scaleTo={0.97}
                onPress={() => step(0.5)}
                style={styles.stepButton}
              >
                <Icon name="buy" size={22} color={c.textSecondary} />
              </PressableScale>
            </View>
          </View>
        )}

        {page === 'options' && (
          <View>
            <SheetHeader title="Trade options" onBack={() => go('settings')} />
            <SheetRow
              title="Default"
              subtitle="Honey picks the best route for each trade, counting the tokens you get and the network costs."
              accessory={
                <Toggle
                  accessibilityLabel="Default routing"
                  value={smartRouting}
                  onValueChange={(v) => {
                    tap();
                    setSmartRouting(v);
                  }}
                />
              }
            />
          </View>
        )}
      </ContentSwap>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  auto: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    ...radius(8),
    overflow: 'hidden',
    color: c.accentText,
    backgroundColor: c.accentSurface,
    fontSize: 15,
    fontWeight: '500',
  },
  autoOff: {
    color: c.textSecondary,
    backgroundColor: 'transparent',
  },
  stepper: {
    marginTop: 26,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  stepButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 56,
    paddingHorizontal: 18,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: c.divider,
  },
  stepNumber: {
    color: c.text,
    fontSize: 20,
    fontWeight: '500',
  },
}));
