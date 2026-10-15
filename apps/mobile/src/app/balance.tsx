import { type Href, router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { LearnMore } from '@/components/motion/LearnMore';
import { PressableScale } from '@/components/motion/PressableScale';
import { BalanceAmount } from '@/components/wallet/parts';
import { SheetScreen } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import { BALANCE, BALANCE_CHANGE, formatUsd } from '@/lib/mock-wallet';
import { leaveSheetTo } from '@/lib/navigation';
import { HIDDEN_AMOUNT, useSettings } from '@/lib/settings';
import { makeStyles, useTheme } from '@/theme';

const CHANGE_PCT = (BALANCE_CHANGE / (BALANCE - BALANCE_CHANGE)) * 100;

/** Ways to add money, drawn as home's honey action tiles. */
const DEPOSITS: { icon: IconName; label: string; hint: string; href: Href }[] = [
  { icon: 'bank', label: 'Buy with cash', hint: 'Card or bank', href: '/buy-cash' },
  { icon: 'qr', label: 'Receive crypto', hint: 'Wallet or exchange', href: '/receive' },
];

/**
 * Opened from the balance pill on Trade, Savings and Search: your balance as on
 * home (dimmed cents, today's change, tap it to hide), the ways to deposit more, and Portfolio.
 */
export default function BalanceSheet() {
  const styles = useStyles();
  const c = useTheme();
  const down = BALANCE_CHANGE < 0;
  const { hideBalance } = useSettings();
  const [linkPressed, setLinkPressed] = useState(false);

  const go = (href: Href) => {
    tap();
    router.replace(href);
  };

  return (
    <SheetScreen>
      <Text style={styles.label}>Total balance</Text>
      <BalanceAmount style={styles.balance} fractionStyle={styles.cents} />
      <View style={styles.change}>
        <Icon name={down ? 'down' : 'up'} size={9} color={down ? c.error : c.success} />
        <Text style={styles.changeText}>
          {hideBalance ? HIDDEN_AMOUNT : formatUsd(Math.abs(BALANCE_CHANGE))} (
          {Math.abs(CHANGE_PCT).toFixed(2)}%) today
        </Text>
      </View>

      <View style={styles.tiles}>
        {DEPOSITS.map((d) => (
          <PressableScale
            key={d.label}
            accessibilityRole="button"
            accessibilityLabel={`${d.label}, ${d.hint}`}
            scaleTo={0.98}
            onPress={() => go(d.href)}
            style={styles.tile}
          >
            <Icon name={d.icon} size={22} color={c.accentText} />
            <View>
              <Text style={styles.tileLabel}>{d.label}</Text>
              <Text style={styles.tileHint}>{d.hint}</Text>
            </View>
          </PressableScale>
        ))}
      </View>

      <PressableScale
        accessibilityRole="link"
        hitSlop={8}
        scaleTo={0.97}
        onPress={() => {
          tap();
          // Portfolio is a full screen: close this sheet rather than replace it.
          leaveSheetTo('/portfolio');
        }}
        onPressIn={() => setLinkPressed(true)}
        onPressOut={() => setLinkPressed(false)}
        style={styles.portfolio}
      >
        <LearnMore
          label="View portfolio"
          active={linkPressed}
          color={c.accentText}
          style={styles.portfolioText}
        />
      </PressableScale>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  label: {
    color: c.textSecondary,
    fontSize: 15,
  },
  balance: {
    marginTop: 4,
    color: c.text,
    fontSize: 38,
    fontWeight: '500',
    letterSpacing: -0.8,
  },
  cents: {
    color: c.textSecondary,
  },
  change: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  changeText: {
    color: c.textSecondary,
    fontSize: 15,
  },
  tiles: {
    marginTop: 22,
    flexDirection: 'row',
    gap: 8,
  },
  tile: {
    flex: 1,
    height: 104,
    padding: 14,
    borderRadius: 18,
    justifyContent: 'space-between',
    backgroundColor: c.accentSurface,
  },
  tileLabel: {
    color: c.accentText,
    fontSize: 16,
    fontWeight: '600',
  },
  tileHint: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 13,
  },
  portfolio: {
    marginTop: 18,
    alignSelf: 'center',
  },
  portfolioText: {
    fontSize: 15,
    fontWeight: '500',
  },
}));
