import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { Accordion } from '@/components/motion/Accordion';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { Swap } from '@/components/motion/IconSwap';
import { ModalDialog } from '@/components/motion/ModalDialog';
import { PressableScale } from '@/components/motion/PressableScale';
import { RESIZE } from '@/components/motion/resize';
import { LOAD_DELAY, SkeletonBar } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { FailurePage } from '@/components/sheets/FailurePage';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { LiveProposedPage } from '@/components/wallet/MultisigParts';
import { LabeledDivider, TokenIcon } from '@/components/wallet/parts';
import { success, tap } from '@/lib/haptics';
import type { Chain } from '@/lib/mock-wallet';
import { type ProposalAction, propose, useSigner } from '@/lib/multisig';
import { followFix, useFailure } from '@/lib/outcomes';
import { makeStyles, useTheme } from '@/theme';

export type SwapLeg = { amount: string; symbol: string; chain: Chain; usd: string };

type Step = 'review' | 'pending' | 'done' | 'proposed' | 'failed';
const STEPS: Step[] = ['review', 'pending', 'done', 'proposed', 'failed'];

/**
 * Review a swap, confirm it, watch it go through, see it land: one bottom sheet laid
 * out after Uniswap's review (You're swapping, Show more, Fee and Network cost, Back +
 * Swap). Swipe it down to back out. Its height changes and step crossfades share one
 * clock (250ms, the height ease-out) so the sheet reads as a single surface. Nothing
 * executes yet; the pending step plays a scripted status line and transcript.
 */
export function SwapReview({
  visible,
  pay,
  get,
  route,
  networkCost,
  bridging,
  onClose,
  onDone,
}: {
  visible: boolean;
  pay: SwapLeg;
  get: SwapLeg;
  route: string;
  networkCost: string;
  bridging: boolean;
  onClose: () => void;
  /** After the swap lands and Done is tapped. */
  onDone: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('review');
  const [more, setMore] = useState(false);
  // The network cost is re-estimated each time the review opens.
  const [estimating, setEstimating] = useState(true);
  // From a shared wallet the swap (and any token approval, batched in) is proposed.
  const signer = useSigner();
  const [proposalId, setProposalId] = useState<string | null>(null);
  const outcome = useFailure('swap');
  const action: ProposalAction = {
    type: 'swap',
    from: { symbol: pay.symbol, amount: Number(pay.amount) || 0 },
    to: { symbol: get.symbol, amount: Number(get.amount) || 0 },
    usd: Number(pay.usd.replace(/[^0-9.]/g, '')) || 0,
    withApproval: pay.symbol !== 'ETH',
  };
  const confirm = () => {
    tap();
    if (signer.proposes(action)) {
      success();
      setProposalId(propose(signer.walletId, action).proposal.id);
      setStep('proposed');
    } else {
      if (signer.multisig) propose(signer.walletId, action);
      setStep('pending');
    }
  };

  // Every opening starts from the review, details folded.
  useEffect(() => {
    if (!visible) return;
    setStep('review');
    setMore(false);
    setEstimating(true);
    const timer = setTimeout(() => setEstimating(false), LOAD_DELAY);
    return () => clearTimeout(timer);
  }, [visible]);

  const states = [
    `Finding the best price via ${route}`,
    'Signing with Face ID',
    ...(bridging ? [`Bridging to ${get.chain}`] : []),
    `Confirming on ${pay.chain}`,
  ];
  return (
    <ModalDialog
      visible={visible}
      onRequestClose={onClose}
      dismissable={step !== 'pending'}
      placement="bottom"
    >
      <Animated.View layout={RESIZE} style={[styles.card, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.grabber} />
        <ContentSwap id={step} index={STEPS.indexOf(step)}>
          {step === 'review' && (
            <View>
              <Text style={styles.kicker} accessibilityRole="header">
                You're swapping
              </Text>
              <Leg leg={pay} />
              <View style={styles.arrow}>
                <Icon name="arrowDown" size={14} color={c.textSecondary} />
              </View>
              <Leg leg={get} />
              <LabeledDivider
                label={more ? 'Show less' : 'Show more'}
                open={more}
                onPress={() => setMore((m) => !m)}
              />
              <Accordion open={more}>
                <Row label="Route" value={route} />
                <Row label="Max slippage" value="Auto · 5.5%" />
                <Row label="Price impact" value="<0.01%" />
              </Accordion>
              <Row label="Fee" value="Free" />
              <Row label="Network cost" value={networkCost} loading={estimating} />
              {signer.rule(action) ? (
                <Row label="Shared wallet" value={signer.rule(action) ?? ''} />
              ) : null}
              {/* After Uniswap: a square Back beside one big Swap, confirmed with Face ID. */}
              <View style={styles.actions}>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel="Back"
                  onPress={() => {
                    tap();
                    onClose();
                  }}
                  style={styles.back}
                >
                  <Icon name="chevronLeft" size={18} color={c.text} />
                </PressableScale>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={signer.cta('Swap', action)}
                  onPress={confirm}
                  style={styles.swap}
                >
                  <Icon name="faceId" size={20} color={c.onPrimary} />
                  <Text style={styles.swapLabel}>{signer.cta('Swap', action)}</Text>
                </PressableScale>
              </View>
            </View>
          )}

          {step === 'pending' && (
            <SwapProgress
              pay={pay}
              get={get}
              steps={states}
              onDone={() => {
                // Whether it landed is only known once the network answers.
                if (outcome.attempt()) {
                  setStep('failed');
                  return;
                }
                success();
                setStep('done');
              }}
            />
          )}

          {step === 'failed' && outcome.failure && (
            <FailurePage
              compact
              failure={outcome.failure}
              rows={[
                { label: 'Paying', value: `${pay.amount} ${pay.symbol}` },
                { label: 'For', value: `${get.amount} ${get.symbol}` },
              ]}
              onRetry={() => {
                tap();
                if (outcome.failure && followFix(outcome.failure, onClose)) return;
                // Back to the review, with a fresh quote and network cost.
                setEstimating(true);
                setTimeout(() => setEstimating(false), LOAD_DELAY);
                setStep('review');
              }}
              onClose={() => {
                tap();
                onClose();
              }}
            />
          )}

          {step === 'proposed' && proposalId && (
            <View style={styles.proposed}>
              <LiveProposedPage proposalId={proposalId} />
              <PillButton
                label="Done"
                onPress={() => {
                  tap();
                  onDone();
                }}
                style={styles.cta}
              />
            </View>
          )}

          {step === 'done' && (
            <SuccessPage
              compact
              title="Swapped"
              amount={{
                symbol: get.symbol,
                chain: get.chain,
                text: `${get.amount} ${get.symbol}`,
                usd: get.usd,
              }}
              detail={bridging ? `Lands on ${get.chain} in about a minute` : undefined}
              rows={[
                { label: 'Paid', value: `${pay.amount} ${pay.symbol}` },
                { label: 'Route', value: route },
                { label: 'Network cost', value: networkCost },
              ]}
              onDone={() => {
                tap();
                onDone();
              }}
            />
          )}
        </ContentSwap>
      </Animated.View>
    </ModalDialog>
  );
}

/** How long each step shows before the next (scripted until swaps really execute). */
const STEP_MS = 1300;

/**
 * The swap going through: the two tokens with honey dots flowing from one to the
 * other, what's being swapped, then the steps as a checklist. The running step spins
 * (constant motion, so linear), a finished one pops a green tick in its place, and
 * ones still to come wait as grey rings. Under Reduce Motion the dots and the spinner
 * hold still.
 */
function SwapProgress({
  pay,
  get,
  steps,
  onDone,
}: {
  pay: SwapLeg;
  get: SwapLeg;
  steps: string[];
  onDone: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const [current, setCurrent] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (current >= steps.length) {
      done.current();
      return;
    }
    const next = setTimeout(() => setCurrent((i) => i + 1), STEP_MS);
    return () => clearTimeout(next);
  }, [current, steps.length]);

  return (
    <View style={styles.progress}>
      <View style={styles.pair}>
        <TokenIcon symbol={pay.symbol} chain={pay.chain} size={44} ring={c.sheet} />
        <FlowDots />
        <TokenIcon symbol={get.symbol} chain={get.chain} size={44} ring={c.sheet} />
      </View>
      <Text style={styles.progressTitle} accessibilityRole="header">
        Swapping
      </Text>
      <Text style={styles.progressDetail}>
        {pay.amount} {pay.symbol} for {get.amount} {get.symbol}
      </Text>
      <View style={styles.steps}>
        {steps.map((label, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : 'waiting';
          return (
            <View key={label} style={styles.stepRow}>
              <Swap id={state} size={20}>
                {state === 'done' ? (
                  <View style={styles.stepDone}>
                    <Icon name="check" size={11} color="#FFFFFF" />
                  </View>
                ) : state === 'active' ? (
                  <Spinner />
                ) : (
                  <View style={styles.stepWaiting} />
                )}
              </Swap>
              <Text
                style={[
                  styles.stepLabel,
                  state === 'active' && styles.stepActive,
                  state === 'waiting' && styles.stepLater,
                ]}
              >
                {label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** Three honey dots lighting up in turn, left to right: value moving across. */
function FlowDots() {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    t.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1);
    return () => cancelAnimation(t);
  }, [reduceMotion, t]);
  return (
    <View style={styles.dots}>
      {[0, 1, 2].map((i) => (
        <FlowDot key={i} index={i} t={t} still={reduceMotion} />
      ))}
    </View>
  );
}

function FlowDot({ index, t, still }: { index: number; t: SharedValue<number>; still: boolean }) {
  const styles = useStyles();
  const style = useAnimatedStyle(() => {
    if (still) return { opacity: 0.6 };
    // Each dot peaks a third of the cycle after the one before it.
    const phase = (t.value - index / 3 + 1) % 1;
    const glow = Math.max(0, 1 - Math.abs(phase - 0.5) * 3);
    return { opacity: 0.25 + 0.75 * glow, transform: [{ scale: 0.8 + 0.3 * glow }] };
  });
  return <Animated.View style={[styles.dot, style]} />;
}

/** A honey arc turning in a faint ring: the step that's running. */
function Spinner() {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    turn.value = withRepeat(withTiming(1, { duration: 800, easing: Easing.linear }), -1);
    return () => cancelAnimation(turn);
  }, [reduceMotion, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return (
    <Animated.View style={style}>
      <Svg width={20} height={20} viewBox="0 0 20 20">
        <Circle cx={10} cy={10} r={8} stroke={c.divider} strokeWidth={2.2} fill="none" />
        <Path
          d="M10 2a8 8 0 0 1 8 8"
          stroke={c.primary}
          strokeWidth={2.2}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}

/** One side of the swap: amount with its token, dollar value, token logo. */
function Leg({ leg }: { leg: SwapLeg }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.leg}>
      <View style={styles.flex}>
        <Text style={styles.legAmount} numberOfLines={1} adjustsFontSizeToFit>
          {leg.amount} {leg.symbol}
        </Text>
        <Text style={styles.legUsd}>{leg.usd}</Text>
      </View>
      <TokenIcon symbol={leg.symbol} chain={leg.chain} size={42} ring={c.sheet} />
    </View>
  );
}

function Row({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {loading ? (
        <View accessible accessibilityLabel="Estimating">
          <SkeletonBar width={72} height={14} />
        </View>
      ) : (
        <Text style={styles.rowValue}>{value}</Text>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  progress: {
    paddingTop: 8,
    alignItems: 'center',
  },
  pair: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  dots: {
    flexDirection: 'row',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.primary,
  },
  progressTitle: {
    marginTop: 16,
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
  },
  progressDetail: {
    marginTop: 4,
    color: c.textSecondary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  steps: {
    alignSelf: 'stretch',
    marginTop: 22,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  stepRow: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepDone: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.success,
  },
  stepWaiting: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: c.divider,
  },
  stepLabel: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 15,
  },
  stepActive: {
    color: c.text,
    fontWeight: '500',
  },
  stepLater: {
    color: c.placeholder,
  },
  flex: {
    flex: 1,
  },
  proposed: {
    paddingTop: 8,
  },
  card: {
    paddingTop: 8,
    paddingHorizontal: 20,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
    backgroundColor: c.sheet,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    marginBottom: 18,
    borderRadius: 3,
    backgroundColor: c.divider,
  },
  kicker: {
    marginBottom: 12,
    color: c.textSecondary,
    fontSize: 15,
  },
  actions: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 10,
  },
  back: {
    width: 64,
    height: 56,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  swap: {
    flex: 1,
    height: 56,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: c.primary,
  },
  swapLabel: {
    color: c.onPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
  leg: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  legAmount: {
    marginTop: 2,
    color: c.text,
    fontSize: 26,
    fontWeight: '500',
    letterSpacing: -0.4,
  },
  legUsd: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  arrow: {
    marginVertical: 12,
  },
  row: {
    paddingVertical: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rowLabel: {
    color: c.textSecondary,
    fontSize: 14,
  },
  rowValue: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
  cta: {
    marginTop: 20,
  },
}));
