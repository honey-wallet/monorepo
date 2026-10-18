import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { closeSheet } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';

/**
 * The top of an order sheet (Perps, Predict): Back on the left, the sheet's toggle
 * (Long or Short, Buy or Sell) on the right. In the browser the sheet is a page with
 * no grabber, so Back is the way out there.
 */
export function OrderBar({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.bar}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={12}
        scaleTo={0.97}
        onPress={() => {
          tap();
          closeSheet();
        }}
        style={styles.back}
      >
        <Icon name="chevronLeft" size={18} color={c.textSecondary} />
      </PressableScale>
      {children}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 38,
  },
  back: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -6,
  },
}));
