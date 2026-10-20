// Motion: the opposite of the success page, and deliberately quieter. Nothing
// celebrates: the disc fades and scales up from 0.9 (200ms, ease-out), then gives one
// short decaying shake (the same 300ms shake as an invalid field), and the error buzz
// plays once. The words then rise in on the success page's timing, the reassurance
// first. Under Reduce Motion the disc just fades in.
import { type ReactNode, useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { PillButton } from '@/components/onboarding/PillButton';
import { SHEET, StatRow } from '@/components/sheets/Sheet';
import { Appear, AT } from '@/components/sheets/SuccessPage';
import { failure as failureBuzz } from '@/lib/haptics';
import type { Failure } from '@/lib/outcomes';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

const DISC = 72;
const SHAKE = [6, -5, 4, -3, 2, 0];

/**
 * The last page of a money flow that didn't go through: what happened, that the money
 * is safe (said first, in its own line), and the way forward. `onRetry` is the main
 * button (the failure's own action label); `onClose` the grey one beside it.
 */
export function FailurePage({
  failure,
  rows,
  onRetry,
  onClose,
  compact = false,
  children,
}: {
  failure: Failure;
  rows?: { label: string; value: ReactNode }[];
  onRetry: () => void;
  onClose: () => void;
  compact?: boolean;
  children?: ReactNode;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const show = useSharedValue(0);
  const x = useSharedValue(0);

  useEffect(() => {
    failureBuzz();
    if (reduceMotion) {
      show.value = withTiming(1, {
        duration: DURATION.fast,
        easing: EASE.ease,
        reduceMotion: ReduceMotion.Never,
      });
      return;
    }
    show.value = withTiming(1, { duration: DURATION.fast, easing: EASE.smoothOut });
    x.value = withSequence(
      withTiming(0, { duration: DURATION.fast }),
      ...SHAKE.map((to) => withTiming(to, { duration: 50, easing: EASE.inOut })),
    );
  }, [reduceMotion, show, x]);

  const disc = useAnimatedStyle(() => ({
    opacity: show.value,
    transform: [{ translateX: x.value }, { scale: reduceMotion ? 1 : 0.9 + 0.1 * show.value }],
  }));

  const size = compact ? 56 : DISC;
  return (
    <View style={compact ? undefined : styles.page}>
      {compact ? null : <View style={styles.flex} />}
      <View style={styles.body}>
        <Animated.View
          style={[
            styles.disc,
            { width: size, height: size, borderRadius: size / 2, backgroundColor: `${c.error}1F` },
            disc,
          ]}
        >
          <Icon name="close" size={size * 0.38} color={c.error} />
        </Animated.View>
        <Appear at={AT.title}>
          <Text style={styles.title} accessibilityRole="header">
            {failure.title}
          </Text>
        </Appear>
        {/* Whether money moved, before anything else */}
        <Appear at={AT.amount} style={styles.safe}>
          <Icon name="checkCircle" size={15} color={c.success} />
          <Text style={styles.safeText}>{failure.safe}</Text>
        </Appear>
        <Appear at={AT.detail}>
          <Text style={styles.reason}>{failure.reason}</Text>
        </Appear>
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
      {compact ? null : <View style={styles.flex} />}
      <Appear at={AT.done} distance={0} style={styles.ctaRow}>
        {/* Close takes only its label's width; the fix gets the rest, so labels like
            "Pay another way" stay on one line. */}
        <PillButton label="Close" variant="secondary" onPress={onClose} />
        <PillButton label={failure.action.label} onPress={onRetry} style={styles.flex} />
      </Appear>
    </View>
  );
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
  disc: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    marginTop: 18,
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  safe: {
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 12,
    ...radius(16),
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: `${c.success}14`,
  },
  safeText: {
    color: c.success,
    fontSize: 15,
    fontWeight: '600',
  },
  reason: {
    marginTop: 12,
    paddingHorizontal: 12,
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
    ...radius(20),
    backgroundColor: c.card,
  },
  extra: {
    alignSelf: 'stretch',
    marginTop: 16,
  },
  ctaRow: {
    marginTop: SHEET.footerGap,
    flexDirection: 'row',
    gap: 10,
  },
}));
