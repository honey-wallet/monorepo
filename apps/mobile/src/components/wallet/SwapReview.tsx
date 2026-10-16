import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { Accordion } from '@/components/motion/Accordion';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { ModalDialog } from '@/components/motion/ModalDialog';
import { PressableScale } from '@/components/motion/PressableScale';
import { ReasoningStream } from '@/components/motion/ReasoningStream';
import { RESIZE } from '@/components/motion/resize';
import { StreamingText } from '@/components/motion/StreamingText';
import { SuccessCheck } from '@/components/motion/SuccessCheck';
import { ThinkingStates } from '@/components/motion/ThinkingStates';
import { PillButton } from '@/components/onboarding/PillButton';
import { LiveProposedPage } from '@/components/wallet/MultisigParts';
import { LabeledDivider, TokenIcon } from '@/components/wallet/parts';
import { success, tap } from '@/lib/haptics';
import type { Chain } from '@/lib/mock-wallet';
import { type ProposalAction, propose, useSigner } from '@/lib/multisig';
import { makeStyles, useTheme } from '@/theme';

export type SwapLeg = { amount: string; symbol: string; chain: Chain; usd: string };

type Step = 'review' | 'pending' | 'done' | 'proposed';
const STEPS: Step[] = ['review', 'pending', 'done', 'proposed'];

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
  // From a shared wallet the swap (and any token approval, batched in) is proposed.
  const signer = useSigner();
  const [proposalId, setProposalId] = useState<string | null>(null);
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
    if (visible) {
      setStep('review');
      setMore(false);
    }
  }, [visible]);

  const states = [
    'Preparing swap',
    'Signing',
    ...(bridging ? [`Bridging to ${get.chain}`] : []),
    `Confirming on ${pay.chain}`,
  ];
  const transcript = [
    'Quoting 6 routes',
    `Best price via ${route}`,
    bridging ? 'Bridging with Across' : 'Single hop, no bridge needed',
    'Simulating transaction',
    'Checking token approvals',
    'No issues found',
    `Network cost ${networkCost}`,
  ];
  const summary = `Swapped ${pay.amount} ${pay.symbol} for ${get.amount} ${get.symbol}. ${
    bridging ? 'It lands in about a minute.' : "It's in your wallet now."
  }`;

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
              <Row label="Network cost" value={networkCost} />
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
            <View style={styles.pending}>
              <ThinkingStates
                states={states}
                style={styles.status}
                onDone={() => {
                  success();
                  setStep('done');
                }}
              />
              <View style={styles.transcript}>
                <ReasoningStream
                  lines={transcript}
                  background={c.card}
                  visibleLines={4}
                  textStyle={styles.transcriptText}
                />
              </View>
            </View>
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
            <View style={styles.done}>
              <SuccessCheck />
              <Text style={styles.doneTitle} accessibilityRole="header">
                Swap complete
              </Text>
              <StreamingText text={summary} style={styles.summary} />
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
        </ContentSwap>
      </Animated.View>
    </ModalDialog>
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

function Row({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
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
  pending: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  status: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  transcript: {
    marginTop: 16,
    alignSelf: 'stretch',
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 16,
    backgroundColor: c.card,
  },
  transcriptText: {
    color: c.textSecondary,
    fontSize: 13,
  },
  done: {
    paddingTop: 8,
    alignItems: 'center',
  },
  doneTitle: {
    marginTop: 16,
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
  },
  summary: {
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
  },
}));
