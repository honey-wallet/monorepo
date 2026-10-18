import { createURL } from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Share, Text, View } from 'react-native';
import Animated, {
  interpolateColor,
  Keyframe,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { Accordion } from '@/components/motion/Accordion';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, useFirstLoad } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { useHasMounted } from '@/components/motion/useHasMounted';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable } from '@/components/sheets/Details';
import { closeSheet, SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { MemberAvatar, NetworkBadge } from '@/components/wallet/MultisigParts';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { failure, success, tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { formatUsd, shortAddress } from '@/lib/mock-wallet';
import {
  approvalsLeft,
  approve,
  cancel,
  describe,
  hasVoted,
  hostOf,
  type Multisig,
  memberName,
  type Proposal,
  type ProposalAction,
  PURPOSES,
  protocolName,
  receipt,
  reject,
  useMultisig,
  useProposal,
  YOU,
} from '@/lib/multisig';
import { demoOutcome } from '@/lib/outcomes';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE, LAYOUT_MOVE, lazy } from '@/theme/motion';

/** A new signature's tick: grows from half size as it fades in (small icons need the
 * bigger change to read), 200ms on a strong ease-out. */
const badgeIn = lazy(() =>
  new Keyframe({
    0: { opacity: 0, transform: [{ scale: 0.5 }] },
    100: { opacity: 1, transform: [{ scale: 1 }], easing: EASE.smoothOut },
  }).duration(DURATION.fast),
);

/**
 * One proposal on a shared wallet: what it does, who has approved, and your vote.
 * The approval that completes the rule also executes it (Honey's relayer submits).
 */
export default function ProposalSheet() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const c = useTheme();
  const proposal = useProposal(id);
  const multisig = useMultisig(proposal?.walletId);
  // After you sign, the page stays and shows what changed (rather than swapping to a
  // separate success page): the pill, your tick, the bar and the transaction.
  const [justSigned, setJustSigned] = useState(false);
  // Ticks that are there when the sheet opens just show; new ones pop in.
  const mounted = useHasMounted();
  // Signatures and the cost estimate come from the chain with the wallet's proposals.
  // Opened from a list they're already in; a shared link opens it cold.
  const loading = useFirstLoad(LOADS.activity(proposal?.walletId ?? ''));

  if (!proposal || !multisig) {
    return (
      <SheetScreen title="Proposal">
        <EmptyState
          icon="search"
          title="Proposal not found"
          hint="It may have been removed."
          action={{ label: 'Close', onPress: () => router.back() }}
        />
      </SheetScreen>
    );
  }

  const info = describe(proposal.action);
  const pending = proposal.status === 'pending';
  const mine = proposal.createdBy === YOU;
  const canVote = pending && !hasVoted(proposal, YOU);
  const left = approvalsLeft(multisig, proposal);
  const ids = receipt(multisig, proposal);
  // Was the label's "Approve & execute" on the last approval; it wrapped beside Reject.
  // const completes = left === 1;

  const onApprove = () => {
    // A signature that doesn't get through changes nothing: say so and stay on the
    // buttons so it can be tried again.
    const failed = demoOutcome('proposal');
    if (failed) {
      failure();
      showToast(`${failed.title}. ${failed.safe}`);
      return;
    }
    success();
    approve(proposal.id);
    setJustSigned(true);
  };
  const onReject = () => {
    tap();
    const outcome = reject(proposal.id);
    setJustSigned(true);
    showToast(outcome === 'rejected' ? 'Proposal rejected' : 'You rejected it');
  };
  const onCancel = () => {
    tap();
    cancel(proposal.id);
    showToast('Proposal cancelled');
    closeSheet();
  };

  const executed = proposal.status === 'executed';
  // Proposals get passed around: the link opens this sheet for the next signer, and
  // once it has gone through, the explorer link shows it landed.
  const share = () => {
    const link = createURL(`/proposal/${proposal.id}`);
    const message = executed
      ? `${info.title}: done.\n${ids.explorer.url}`
      : pending
        ? `Can you approve proposal #${proposal.nonce}? ${info.title} (${proposal.approvals.length} of ${multisig.threshold} signed)\n${link}`
        : `Proposal #${proposal.nonce}: ${info.title}\n${link}`;
    Share.share({ message }).catch(() => {});
  };

  // Once you've signed, the usual next step is passing it on (or the receipt): Share
  // beside Done.
  // flex:1 only beside Share in a row; alone in the footer's column it squashed the
  // button's height in a short window (review).
  const done = (inRow: boolean) => (
    <PillButton
      label="Done"
      onPress={() => {
        tap();
        closeSheet();
      }}
      style={inRow ? styles.flex : undefined}
    />
  );
  // Nothing left for you to do (you've voted, or it's closed): Done, plus Share while
  // it still needs someone else's signature.
  const finished = pending ? (
    <View style={styles.buttons}>
      <PillButton
        label="Share"
        variant="secondary"
        onPress={() => {
          tap();
          share();
        }}
        style={styles.flex}
      />
      {done(true)}
    </View>
  ) : (
    done(false)
  );
  const actions = justSigned ? (
    finished
  ) : canVote ? (
    // The app's pattern: secondary on the left, primary on the right, equal widths.
    <View style={styles.buttons}>
      <PillButton label="Reject" variant="secondary" onPress={onReject} style={styles.flex} />
      <PillButton label="Approve" onPress={onApprove} style={styles.flex} />
    </View>
  ) : pending && mine ? (
    <PillButton label="Cancel proposal" variant="secondary" onPress={onCancel} />
  ) : (
    finished
  );
  // The buttons crossfade into Done once you've voted.
  const footer = (
    <ContentSwap
      id={canVote && !justSigned ? 'vote' : pending && mine && !justSigned ? 'cancel' : 'done'}
    >
      {actions}
    </ContentSwap>
  );

  return (
    <SheetScreen
      title={`Proposal #${proposal.nonce}`}
      right={<HeaderShortcut icon="share" label="Share proposal" onPress={share} />}
      footer={footer}
    >
      <View>
        <View style={styles.summary}>
          {info.symbol ? <TokenIcon symbol={info.symbol} size={40} /> : null}
          <Text style={styles.title}>{info.title}</Text>
          {'usd' in proposal.action && proposal.action.type !== 'swap' && proposal.action.usd ? (
            <Text style={styles.usd}>{formatUsd(proposal.action.usd)}</Text>
          ) : null}
          <StatusPill multisig={multisig} proposal={proposal} left={left} />
        </View>

        {/* What it does, and where */}
        <View style={styles.group}>
          <ActionRows action={proposal.action} multisig={multisig} />
          <StatRow
            label="Chain"
            value={
              <View style={styles.inline}>
                <NetworkBadge network={multisig.network} size={18} />
                <Text style={styles.statValue}>{multisig.network.name}</Text>
              </View>
            }
          />
          <StatRow label="Protocol" value={protocolName(multisig.protocol)} />
        </View>

        {/* Who signs, side by side: a tick on each who has */}
        <View style={styles.groupHead}>
          <Text style={styles.groupTitle}>{PURPOSES[multisig.purpose].signers}</Text>
          <Text style={styles.groupCount}>
            {proposal.approvals.length} of {multisig.members.length} signed
          </Text>
        </View>
        <View style={styles.group}>
          <SignatureBar signed={proposal.approvals.length} needed={multisig.members.length} />
          <View style={styles.signers}>
            {bySigning(multisig, proposal).map((m) => {
              const yes = proposal.approvals.find((v) => v.memberId === m.id);
              const no = proposal.rejections.find((v) => v.memberId === m.id);
              const idle = !yes && !no && !pending;
              const label = yes
                ? m.id === proposal.createdBy
                  ? 'Proposed'
                  : 'Signed'
                : no
                  ? 'Rejected'
                  : pending
                    ? 'Waiting'
                    : 'Not needed';
              return (
                // A new signature moves its signer into signing order (a layout
                // move, ease-in-out) and pops its tick in.
                <Animated.View
                  key={m.id}
                  layout={LAYOUT_MOVE}
                  accessible
                  accessibilityLabel={`${memberName(multisig, m.id)}: ${label}`}
                  style={[styles.signer, idle && styles.signerIdle]}
                >
                  <View>
                    <MemberAvatar member={m} size={40} />
                    {yes || no ? (
                      <Animated.View
                        entering={mounted ? badgeIn() : undefined}
                        style={[styles.badge, { backgroundColor: yes ? c.success : c.error }]}
                      >
                        <Icon name={yes ? 'check' : 'close'} size={9} color="#FFFFFF" />
                      </Animated.View>
                    ) : null}
                  </View>
                  <Text style={styles.signerName} numberOfLines={1}>
                    {memberName(multisig, m.id)}
                  </Text>
                  <TextSwap
                    text={label}
                    style={[
                      styles.signerState,
                      yes && { color: c.success },
                      no && { color: c.error },
                    ]}
                  />
                </Animated.View>
              );
            })}
          </View>
        </View>

        {/* Both ids together: the multisig's, then the chain's once it's sent */}
        <Text style={[styles.groupTitle, styles.groupGap]}>Transaction</Text>
        <View style={styles.group}>
          <StatRow
            label={multisig.protocol === 'safe' ? 'Safe tx hash' : 'Squads proposal'}
            value={<Copyable value={ids.proposalHash} toast="Proposal ID copied" />}
          />
          {/* Slides open when the last signature sends it. */}
          <Accordion open={executed}>
            <StatRow
              label="Transaction hash"
              value={
                <View style={styles.inline}>
                  <Copyable value={ids.hash} toast="Transaction ID copied" />
                  <PressableScale
                    accessibilityRole="link"
                    accessibilityLabel={`View on ${ids.explorer.name}`}
                    hitSlop={10}
                    onPress={() => {
                      tap();
                      Linking.openURL(ids.explorer.url).catch(() => {});
                    }}
                  >
                    <Icon name="link" size={14} color={c.textSecondary} />
                  </PressableScale>
                </View>
              }
            />
          </Accordion>
          <StatRow
            label={executed ? 'Executed' : 'Network cost'}
            value={
              loading ? (
                <SkeletonBar width={64} height={12} />
              ) : (
                <TextSwap
                  text={
                    executed && proposal.doneAt
                      ? `${when(proposal.doneAt)} · ${ids.fee}`
                      : pending
                        ? `About ${ids.fee}`
                        : 'Not sent'
                  }
                  style={styles.statValue}
                />
              )
            }
          />
        </View>
      </View>
    </SheetScreen>
  );
}

const when = (at: number) =>
  new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Signers in the order they signed (the proposer first), then anyone who rejected,
 * then the rest in the wallet's own order.
 */
function bySigning(multisig: Multisig, proposal: Proposal) {
  const rank = (id: string) => {
    if (id === proposal.createdBy) return -1;
    const yes = proposal.approvals.findIndex((v) => v.memberId === id);
    if (yes >= 0) return yes;
    return proposal.rejections.some((v) => v.memberId === id) ? 1000 : 2000;
  };
  return [...multisig.members].sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Signatures so far against the number of signers, one segment each. The signed segments
 * fill left to right when the sheet opens (250ms each on a strong ease-out, 40ms
 * apart), so the count reads as progress. Under Reduce Motion they're filled at once.
 */
function SignatureBar({ signed, needed }: { signed: number; needed: number }) {
  // `needed` is every signer, so the bar shows how many of the whole group signed.
  const styles = useStyles();
  return (
    <View style={styles.bar}>
      {Array.from({ length: needed }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positions.
        <Segment key={i} index={i} on={i < signed} />
      ))}
    </View>
  );
}

function Segment({ index, on }: { index: number; on: boolean }) {
  const styles = useStyles();
  const reduceMotion = useReducedMotion();
  const fill = useSharedValue(reduceMotion && on ? 1 : 0);
  useEffect(() => {
    if (!on) {
      fill.value = withTiming(0, { duration: DURATION.fast, easing: EASE.ease });
      return;
    }
    fill.value = reduceMotion
      ? 1
      : withDelay(
          120 + index * DURATION.stagger,
          withTiming(1, { duration: DURATION.medium, easing: EASE.smoothOut }),
        );
  }, [on, index, reduceMotion, fill]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
  return (
    <View style={styles.segment}>
      <Animated.View style={[styles.segmentFill, { transformOrigin: 'left' }, style]} />
    </View>
  );
}

/** Where the proposal stands, as a small pill under its title. */
function StatusPill({
  multisig,
  proposal,
  left,
}: {
  multisig: Multisig;
  proposal: Proposal;
  left: number;
}) {
  const styles = useStyles();
  const c = useTheme();
  const done = proposal.status === 'executed';
  const closed = proposal.status === 'rejected' || proposal.status === 'cancelled';
  const text = done
    ? 'Approved & executed'
    : proposal.status === 'rejected'
      ? 'Rejected'
      : proposal.status === 'cancelled'
        ? `Cancelled by ${memberName(multisig, proposal.createdBy)}`
        : `Waiting for ${left} more`;
  const color = done ? c.success : closed ? c.error : c.accentText;
  // The status changes in place: its icon swaps, the words crossfade with a small
  // rise, and the background eases from honey (waiting) to plain (200ms).
  const waiting = !done && !closed;
  const tone = useSharedValue(waiting ? 1 : 0);
  useEffect(() => {
    tone.value = withTiming(waiting ? 1 : 0, { duration: DURATION.fast, easing: EASE.ease });
  }, [waiting, tone]);
  const plain = c.card;
  const honey = c.accentSurface;
  const bg = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(tone.value, [0, 1], [plain, honey]),
  }));
  return (
    <Animated.View style={[styles.pill, bg]}>
      <IconSwap name={done ? 'checkCircle' : closed ? 'close' : 'clock'} size={13} color={color} />
      <TextSwap text={text} style={[styles.pillText, { color }]} />
    </Animated.View>
  );
}

/** The details of what a proposal does, the same rows its review page showed. */
function ActionRows({ action, multisig }: { action: ProposalAction; multisig: Multisig }) {
  switch (action.type) {
    case 'send':
      return (
        // The amount is the sheet's title; the dollars sit under it.
        <StatRow label="To" value={shortAddress(action.to)} />
      );
    case 'swap':
      return (
        <>
          <StatRow
            label="You pay"
            value={`${action.from.amount} ${action.from.symbol} · ${formatUsd(action.usd)}`}
          />
          <StatRow label="You get" value={`≈ ${action.to.amount} ${action.to.symbol}`} />
          {action.withApproval ? (
            <StatRow label="Includes" value={`${action.from.symbol} approval, in one go`} />
          ) : null}
        </>
      );
    case 'earnDeposit':
    case 'earnWithdraw':
    case 'jarAdd':
    case 'jarWithdraw':
    case 'sell':
      return 'jar' in action ? <StatRow label="Jar" value={action.jar} /> : null;
    case 'addMember':
      return (
        <>
          <StatRow
            label="New member"
            value={action.member.handle ?? shortAddress(action.member.address)}
          />
          <StatRow
            label="Approvals after"
            value={`${multisig.threshold} of ${multisig.members.length + 1}`}
          />
        </>
      );
    case 'removeMember':
      return (
        <StatRow
          label="Approvals after"
          value={`${Math.min(multisig.threshold, multisig.members.length - 1)} of ${multisig.members.length - 1}`}
        />
      );
    case 'changeThreshold':
      return (
        <StatRow
          label="Rule"
          value={`${multisig.threshold} → ${action.threshold} of ${multisig.members.length}`}
        />
      );
    case 'appCall':
      return (
        <>
          <StatRow label="Site" value={hostOf(action.site)} />
          <StatRow label="Network" value={action.network} />
          {action.to ? <StatRow label="Contract" value={shortAddress(action.to)} /> : null}
          <StatRow
            label="Call"
            value={action.data.length > 2 ? `Data · ${action.data.slice(0, 10)}` : 'None'}
          />
        </>
      );
    case 'setDailyLimit':
      return (
        <StatRow
          label="Daily limit"
          value={`${multisig.dailyLimit ? formatUsd(multisig.dailyLimit) : 'None'} → ${
            action.usd ? formatUsd(action.usd) : 'None'
          }`}
        />
      );
  }
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  grow: {
    flex: 1.6,
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
  },
  stacked: {
    gap: 10,
  },
  summary: {
    alignItems: 'center',
    gap: 6,
    paddingTop: 0,
    paddingBottom: 16,
  },
  title: {
    marginTop: 4,
    color: c.text,
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  usd: {
    marginTop: -4,
    color: c.textSecondary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  pill: {
    marginTop: 2,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: c.card,
  },
  pillText: {
    fontSize: 14,
    fontWeight: '500',
  },
  // Grouped rows, as Aave groups its settings: each block is one rounded card.
  group: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  groupHead: {
    marginTop: 16,
    marginBottom: 8,
    marginHorizontal: 2,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  groupTitle: {
    marginLeft: 2,
    marginBottom: 8,
    color: c.textSecondary,
    fontSize: 15,
  },
  groupGap: {
    marginTop: 16,
  },
  groupCount: {
    color: c.textSecondary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  bar: {
    marginTop: 8,
    marginBottom: 6,
    flexDirection: 'row',
    gap: 4,
  },
  segment: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: c.raised,
  },
  segmentFill: {
    flex: 1,
    backgroundColor: c.success,
  },
  signers: {
    flexDirection: 'row',
    paddingTop: 6,
    paddingBottom: 8,
  },
  signer: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  signerIdle: {
    opacity: 0.5,
  },
  signerName: {
    marginTop: 3,
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
  signerState: {
    color: c.textSecondary,
    fontSize: 12,
  },
  badge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: c.card,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statValue: {
    color: c.text,
    fontSize: 16,
  },
}));
