import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { PillButton } from '@/components/onboarding/PillButton';
import { tap } from '@/lib/haptics';
import { SETUP_REWARD_USD, SETUP_STEPS, useOnboarding } from '@/lib/onboarding';
import { makeStyles, useTheme } from '@/theme';

/** Quick amounts for a first purchase; each goes straight to the review. */
const AMOUNTS = [25, 50, 100];

/**
 * On Home while the wallet has never had money in it (the rest of Home stays as it
 * is, so it's familiar from day one). The only job is the first deposit: pick an
 * amount and pay with Apple Pay; preset amounts and Apple Pay lift on-ramp conversion.
 * Crypto from elsewhere comes in through the Receive tile above.
 */
export function FundWalletCard() {
  const styles = useStyles();
  const [pick, setPick] = useState<number | null>(AMOUNTS[1]);
  const buy = () => {
    tap();
    router.push(
      pick
        ? { pathname: '/buy-cash', params: { symbol: 'USDC', amount: String(pick) } }
        : { pathname: '/buy-cash', params: { symbol: 'USDC' } },
    );
  };
  const deposit = () => {
    tap();
    router.push('/receive');
  };
  const chips: (number | null)[] = [...AMOUNTS, null];
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Add money to get started</Text>
      <Text style={styles.body}>Buy with Apple Pay or card, or deposit crypto.</Text>
      {/* Amounts for buying; Other types your own on the next screen. */}
      <View style={styles.amounts}>
        {chips.map((a) => {
          const on = a === pick;
          return (
            <PressableScale
              key={a ?? 'other'}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              scaleTo={0.96}
              onPress={() => {
                tap();
                setPick(a);
              }}
              style={[styles.amount, on && styles.amountOn]}
            >
              <Text style={[styles.amountText, on && styles.amountTextOn]}>
                {a ? `$${a}` : 'Other'}
              </Text>
            </PressableScale>
          );
        })}
      </View>
      {/* Secondary on the left, primary on the right, as every footer in the app. */}
      <View style={styles.buttons}>
        <PillButton label="Deposit" variant="secondary" onPress={deposit} style={styles.flex} />
        <PillButton label={pick ? `Buy $${pick}` : 'Buy'} onPress={buy} style={styles.flex} />
      </View>
    </View>
  );
}

/**
 * Once there's money in the wallet but setup isn't finished: one card with the
 * progress so far and the reward for finishing. Gone once every step is done.
 */
export function FinishSetupCard() {
  const styles = useStyles();
  const c = useTheme();
  const { done } = useOnboarding();
  const total = SETUP_STEPS.length;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Finish setting up, ${done.length} of ${total} done. Get $${SETUP_REWARD_USD} off network fees`}
      scaleTo={0.98}
      onPress={() => {
        tap();
        router.push('/setup');
      }}
      style={[styles.card, styles.setup]}
    >
      <Progress done={done.length} total={total} />
      <View style={styles.flex}>
        <Text style={styles.setupTitle}>Finish setting up</Text>
        <Text style={styles.reward}>Get ${SETUP_REWARD_USD} off network fees</Text>
      </View>
      <Text style={styles.count}>
        {done.length}/{total}
      </Text>
      <Icon name="chevronRight" size={12} color={c.textSecondary} />
    </PressableScale>
  );
}

/** A ring that fills a step at a time. */
export function Progress({
  done,
  total,
  size = 40,
}: {
  done: number;
  total: number;
  size?: number;
}) {
  const c = useTheme();
  const stroke = 4;
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  return (
    <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={c.raised}
        strokeWidth={stroke}
        fill="none"
      />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={c.honey}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${length} ${length}`}
        strokeDashoffset={length * (1 - done / total)}
        fill="none"
      />
    </Svg>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  card: {
    padding: 20,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  title: {
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  body: {
    marginTop: 4,
    color: c.textSecondary,
    fontSize: 15,
  },
  buttons: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 10,
  },
  amounts: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 8,
  },
  amount: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  // Picked: an outline on the page colour (a honey tint would read as disabled).
  amountOn: {
    borderWidth: 2,
    borderColor: c.text,
    backgroundColor: c.canvas,
  },
  amountText: {
    color: c.text,
    fontSize: 18,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  amountTextOn: {
    color: c.text,
  },
  label: {
    marginTop: 28,
    marginBottom: 4,
    color: c.textSecondary,
    fontSize: 15,
  },
  way: {
    minHeight: 64,
    marginHorizontal: -8,
    paddingHorizontal: 8,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  well: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  wayTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  wayHint: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  setup: {
    paddingVertical: 16,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  setupTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  reward: {
    marginTop: 2,
    color: c.accentText,
    fontSize: 14,
    fontWeight: '500',
  },
  count: {
    color: c.textSecondary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
}));
