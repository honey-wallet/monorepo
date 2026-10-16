import type { ReactNode } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ReorderList } from '@/components/motion/ReorderList';
import { Toggle } from '@/components/motion/Toggle';
import { PillButton } from '@/components/onboarding/PillButton';
import {
  closeSheet,
  SheetRow,
  SheetScreen,
  SheetSection,
  SheetText,
} from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import {
  AVAILABLE_TRADE_MODES,
  TRADE_MODE_INFO,
  type TradeMode,
  updateSettings,
  useSettings,
} from '@/lib/settings';
import { makeStyles } from '@/theme';
import { DURATION, LAYOUT_MOVE } from '@/theme/motion';

const ROW_HEIGHT = 64;

/** Choose which products show on the Trade tab, and in what order. Changes apply live. */
export default function TradeTabsSheet() {
  const styles = useStyles();
  // Products switched off for now (Futures, Options) aren't offered here.
  const tradeTabs = useSettings().tradeTabs.filter((m) => AVAILABLE_TRADE_MODES.includes(m));
  const hidden = AVAILABLE_TRADE_MODES.filter((m) => !tradeTabs.includes(m));

  const set = (next: TradeMode[]) => {
    tap();
    updateSettings({ tradeTabs: next });
  };
  // Keep at least one tab, so Trade is never empty.
  const show = (mode: TradeMode, on: boolean) =>
    (on || tradeTabs.length > 1) &&
    set(on ? [...tradeTabs, mode] : tradeTabs.filter((m) => m !== mode));

  const row = (mode: TradeMode, handle?: ReactNode) => (
    <SheetRow
      icon={TRADE_MODE_INFO[mode].icon}
      title={mode}
      subtitle={TRADE_MODE_INFO[mode].hint}
      accessory={
        <View style={styles.controls}>
          <Toggle
            accessibilityLabel={`Show ${mode}`}
            value={tradeTabs.includes(mode)}
            onValueChange={(on) => show(mode, on)}
          />
          {handle}
        </View>
      }
    />
  );

  return (
    <SheetScreen title="Trade tabs" footer={<PillButton label="Done" onPress={closeSheet} />}>
      <SheetText>Choose what shows on Trade. Drag ⠿ to change the order.</SheetText>
      <ReorderList items={tradeTabs} rowHeight={ROW_HEIGHT} onReorder={set} renderRow={row} />
      {hidden.length > 0 && <SheetSection title="More" />}
      {hidden.map((mode) => (
        <Animated.View key={mode} entering={FadeIn.duration(DURATION.fast)} layout={LAYOUT_MOVE}>
          {row(mode)}
        </Animated.View>
      ))}
    </SheetScreen>
  );
}

const useStyles = makeStyles(() => ({
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
}));
