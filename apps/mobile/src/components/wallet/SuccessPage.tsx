import { router } from 'expo-router';
import { type ReactNode, useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { SuccessBurst } from '@/components/motion/SuccessBurst';
import { PillButton } from '@/components/onboarding/PillButton';
import { TokenIcon } from '@/components/wallet/parts';
import { closeSheet, SHEET, StatRow } from '@/components/wallet/Sheet';
import { tap } from '@/lib/haptics';
import type { Chain } from '@/lib/mock-wallet';
import { showDemoToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { DISTANCE, DURATION, EASE } from '@/theme/motion';

/**
 * When each block arrives after the check (ms): the title as the disc lands, then the
 * amount, the line under it, the receipt and the button, so the eye reads top-down.
 * Stagger is decorative, so the button is tappable from the start.
 */
const AT = { title: 180, amount: 240, detail: 300, receipt: 380, done: 460 } as const;
const RISE = { duration: DURATION.verySlow, easing: EASE.smoothOut } as const;

/**
 * The last page of a money flow (send, buy, deposit, an order): the check pops in with
 * a little burst, then what happened rises in under it, centred in the space it's
 * given. With `amount` the token and figure lead; `rows` add a small receipt. With
 * `onDone`, a Done button sits at the bottom; sheets with a pinned footer put their
 * own there instead.
 */
export function SuccessPage({
  title,
  detail,
  amount,
  rows,
  onDone,
  children,
}: {
  title: string;
  detail?: string;
  /** The headline figure, e.g. `{ symbol: 'USDC', text: '2 USDC', usd: '$2.00' }`. */
  amount?: { symbol: string; chain?: Chain; text: string; usd?: string };
  /** A short receipt under the headline: To, Network, Fee… */
  rows?: { label: string; value: ReactNode }[];
  onDone?: () => void;
  /** Extra content under the detail, e.g. who still has to approve. */
  children?: ReactNode;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.page}>
      <View style={styles.flex} />
      <View style={styles.body}>
        <SuccessBurst />
        <Appear at={AT.title}>
          <Text style={[styles.title, !amount && styles.titleLarge]} accessibilityRole="header">
            {title}
          </Text>
        </Appear>
        {amount ? (
          <Appear at={AT.amount} style={styles.amountBlock}>
            <View style={styles.amountRow}>
              <TokenIcon symbol={amount.symbol} chain={amount.chain} size={30} ring={c.sheet} />
              <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit>
                {amount.text}
              </Text>
            </View>
            {amount.usd ? <Text style={styles.usd}>{amount.usd}</Text> : null}
          </Appear>
        ) : null}
        {detail ? (
          <Appear at={AT.detail}>
            <Text style={styles.detail}>{detail}</Text>
          </Appear>
        ) : null}
        {rows?.length ? (
          <Appear at={AT.receipt} style={styles.receipt}>
            {rows.map((row) => (
              <StatRow key={row.label} label={row.label} value={row.value} />
            ))}
          </Appear>
        ) : null}
        {children ? (
          <Appear at={AT.receipt} style={styles.extra}>
            {children}
          </Appear>
        ) : null}
      </View>
      <View style={styles.flex} />
      {onDone ? (
        <Appear at={AT.done} distance={0}>
          <PillButton label="Done" onPress={onDone} style={styles.cta} />
        </Appear>
      ) : null}
    </View>
  );
}

/** Fades in and rises into place `at` ms after the page shows (only fades under Reduce Motion). */
function Appear({
  at,
  distance = DISTANCE.base,
  style,
  children,
}: {
  at: number;
  distance?: number;
  style?: object;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withDelay(reduceMotion ? 0 : at, withTiming(1, RISE));
  }, [at, reduceMotion, progress]);
  const animated = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: reduceMotion ? 0 : (1 - progress.value) * distance }],
  }));
  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}

/**
 * Leaves a finished demo flow: says nothing really happened, then closes the sheet
 * (or, with `all`, every sheet back to the screen underneath).
 */
export function finishDemo(what: string, { all = false }: { all?: boolean } = {}) {
  tap();
  showDemoToast(what);
  if (all) router.dismissAll();
  else closeSheet();
}

const useStyles = makeStyles((c) => ({
  page: {
    flex: 1,
    minHeight: 320,
  },
  flex: {
    flex: 1,
  },
  body: {
    alignItems: 'center',
  },
  title: {
    marginTop: 18,
    color: c.textSecondary,
    fontSize: 17,
    fontWeight: '500',
  },
  titleLarge: {
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
  },
  amountBlock: {
    marginTop: 6,
    alignItems: 'center',
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: '100%',
  },
  amount: {
    flexShrink: 1,
    color: c.text,
    fontSize: 34,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  usd: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  detail: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  receipt: {
    alignSelf: 'stretch',
    marginTop: 24,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: c.card,
  },
  extra: {
    marginTop: 18,
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
}));
