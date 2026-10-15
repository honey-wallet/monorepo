import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { SheetRow, SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { makeStyles, useTheme } from '@/theme';

/** Buy (or sell) sheet: with cash, or by swapping what you already hold. */
export default function BuySheet() {
  const { mode, symbol } = useLocalSearchParams<{ mode?: string; symbol?: string }>();
  const styles = useStyles();
  const c = useTheme();
  const selling = mode === 'sell';
  const what = symbol ?? 'crypto';

  const options: { icon: IconName; title: string; hint: string; onPress: () => void }[] = [
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
        router.dismiss();
        router.navigate('/trade');
      },
    },
  ];

  return (
    <SheetScreen>
      {options.map((o) => (
        <SheetRow
          key={o.title}
          title={o.title}
          subtitle={o.hint}
          leading={
            <View style={styles.icon}>
              <Icon name={o.icon} size={19} color={c.accentText} />
            </View>
          }
          onPress={() => {
            tap();
            o.onPress();
          }}
        />
      ))}
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  icon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
}));
