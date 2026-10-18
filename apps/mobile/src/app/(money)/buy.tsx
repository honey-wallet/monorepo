import { router, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { leaveSheetTo } from '@/lib/navigation';
import { isWeb } from '@/lib/platform';
import { makeStyles, useTheme } from '@/theme';

/** Buy (or sell) sheet: with cash, or by swapping what you already hold. */
export default function BuySheet() {
  const { mode, symbol } = useLocalSearchParams<{ mode?: string; symbol?: string }>();
  const styles = useStyles();
  const c = useTheme();
  const selling = mode === 'sell';
  const what = symbol ?? 'crypto';

  const allOptions: { icon: IconName; title: string; hint: string; onPress: () => void }[] = [
    {
      icon: 'bank',
      title: selling ? 'Sell for cash' : 'Buy with cash',
      hint: selling ? `Send ${what} to your bank account` : 'Use a debit card or bank account',
      onPress: () =>
        router.replace({
          pathname: '/buy-cash',
          params: { ...(symbol ? { symbol } : {}), ...(selling ? { mode: 'sell' } : {}) },
        }),
    },
    {
      icon: 'trade',
      title: 'Swap tokens',
      hint: 'Trade using your existing balance',
      onPress: () => {
        leaveSheetTo('/trade', { navigate: true });
      },
    },
  ];
  // review: no trading in the extension, so Swap (a link into /trade) is phone-only.
  const options = isWeb ? allOptions.filter((o) => o.icon !== 'trade') : allOptions;

  return (
    <SheetScreen title={selling ? `Sell ${what}` : `Buy ${what}`}>
      <View style={styles.options}>
        {options.map((o) => (
          <PressableScale
            key={o.title}
            accessibilityRole="button"
            accessibilityLabel={`${o.title}. ${o.hint}`}
            scaleTo={0.98}
            onPress={() => {
              tap();
              o.onPress();
            }}
            style={styles.option}
          >
            <View style={styles.icon}>
              <Icon name={o.icon} size={22} color={c.accentText} />
            </View>
            <View style={styles.text}>
              <Text style={styles.title}>{o.title}</Text>
              <Text style={styles.hint}>{o.hint}</Text>
            </View>
            <Icon name="chevronRight" size={13} color={c.textSecondary} />
          </PressableScale>
        ))}
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  options: {
    gap: 10,
  },
  // Each way to buy or sell is its own card, so the sheet reads as a clear choice.
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  text: {
    flex: 1,
  },
  title: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  hint: {
    marginTop: 3,
    color: c.textSecondary,
    fontSize: 14,
  },
  // Round icon wells, like Add wallet's rows.
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
}));
