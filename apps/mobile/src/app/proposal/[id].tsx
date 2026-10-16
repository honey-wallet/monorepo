import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { PillButton } from '@/components/onboarding/PillButton';
import { MemberAvatar, NetworkBadge, ProposedPage } from '@/components/wallet/MultisigParts';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { closeSheet, SheetScreen, StatRow } from '@/components/wallet/Sheet';
import { useCopy } from '@/lib/copy';
import { success, tap } from '@/lib/haptics';
import { formatUsd, shortAddress } from '@/lib/mock-wallet';
import {
  approvalsLeft,
  approve,
  cancel,
  describe,
  hasVoted,
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
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

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
  // After you approve, the page turns into the outcome.
  const [voted, setVoted] = useState(false);

  if (!proposal || !multisig) {
    return (
      <SheetScreen title="Proposal">
        <EmptyState icon="search" title="Proposal not found" hint="It may have been removed." />
      </SheetScreen>
    );
  }

  const info = describe(proposal.action);
  const pending = proposal.status === 'pending';
  const mine = proposal.createdBy === YOU;
  const canVote = pending && !hasVoted(proposal, YOU);
  const left = approvalsLeft(multisig, proposal);
  const ids = receipt(multisig, proposal);
  const completes = left === 1;

  const onApprove = () => {
    success();
    approve(proposal.id);
    setVoted(true);
  };
  const onReject = () => {
    tap();
    const outcome = reject(proposal.id);
    showToast(outcome === 'rejected' ? 'Proposal rejected' : 'You rejected it');
  };
  const onCancel = () => {
    tap();
    cancel(proposal.id);
    showToast('Proposal cancelled');
    closeSheet();
  };

  const footer = voted ? (
    <PillButton
      label="Done"
      onPress={() => {
        tap();
        closeSheet();
      }}
    />
  ) : canVote ? (
    <View style={styles.buttons}>
      <PillButton label="Reject" variant="secondary" onPress={onReject} style={styles.flex} />
      <PillButton
        label={completes ? 'Approve & execute' : 'Approve'}
        onPress={onApprove}
        style={styles.grow}
      />
    </View>
  ) : pending && mine ? (
    <PillButton label="Cancel proposal" variant="secondary" onPress={onCancel} />
  ) : undefined;

  return (
    <SheetScreen title={`Proposal #${proposal.nonce}`} footer={footer}>
      <ContentSwap id={voted ? 'outcome' : 'proposal'} index={voted ? 1 : 0}>
        {voted ? (
          <ProposedPage multisig={multisig} proposal={proposal} />
        ) : (
          <View>
            <View style={styles.summary}>
              {info.symbol ? <TokenIcon symbol={info.symbol} size={40} /> : null}
              <Text style={styles.title}>{info.title}</Text>
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
                    <View
                      key={m.id}
                      accessible
                      accessibilityLabel={`${memberName(multisig, m.id)}: ${label}`}
                      style={[styles.signer, idle && styles.signerIdle]}
                    >
                      <View>
                        <MemberAvatar member={m} size={40} />
                        {yes || no ? (
                          <View
                            style={[styles.badge, { backgroundColor: yes ? c.success : c.error }]}
                          >
                            <Icon name={yes ? 'check' : 'close'} size={9} color="#FFFFFF" />
                          </View>
                        ) : null}
                      </View>
                      <Text style={styles.signerName} numberOfLines={1}>
                        {memberName(multisig, m.id)}
                      </Text>
                      <Text
                        style={[
                          styles.signerState,
                          yes && { color: c.success },
                          no && { color: c.error },
                        ]}
                        numberOfLines={1}
                      >
                        {label}
                      </Text>
                    </View>
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
              {proposal.status === 'executed' ? (
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
              ) : null}
              <StatRow
                label={proposal.status === 'executed' ? 'Executed' : 'Network cost'}
                value={
                  proposal.status === 'executed' && proposal.doneAt
                    ? `${when(proposal.doneAt)} · ${ids.fee}`
                    : pending
                      ? `About ${ids.fee}`
                      : 'Not sent'
                }
              />
            </View>
          </View>
        )}
      </ContentSwap>
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
  return (
    <View style={[styles.pill, !done && !closed && styles.pillWaiting]}>
      <Icon name={done ? 'checkCircle' : closed ? 'close' : 'clock'} size={13} color={color} />
      <Text style={[styles.pillText, { color }]}>{text}</Text>
    </View>
  );
}

/** A short hash that copies in full when tapped (its icon swaps to a check). */
function Copyable({ value, toast }: { value: string; toast: string }) {
  const styles = useStyles();
  const c = useTheme();
  const { copied, copy } = useCopy(value, toast);
  return (
    <PressableScale
      accessibilityLabel={toast.replace(' copied', '')}
      onPress={copy}
      hitSlop={8}
      style={styles.inline}
    >
      <Text style={styles.statValue}>{shortAddress(value)}</Text>
      <IconSwap name={copied ? 'check' : 'copy'} size={14} color={c.textSecondary} />
    </PressableScale>
  );
}

/** The details of what a proposal does, the same rows its review page showed. */
function ActionRows({ action, multisig }: { action: ProposalAction; multisig: Multisig }) {
  switch (action.type) {
    case 'send':
      return (
        <>
          <StatRow
            label="Amount"
            value={`${action.amount} ${action.symbol} · ${formatUsd(action.usd)}`}
          />
          <StatRow label="To" value={shortAddress(action.to)} />
        </>
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
      return (
        <>
          <StatRow
            label="Amount"
            value={`${action.amount} ${action.symbol} · ${formatUsd(action.usd)}`}
          />
          {'jar' in action ? <StatRow label="Jar" value={action.jar} /> : null}
        </>
      );
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
  pillWaiting: {
    backgroundColor: c.accentSurface,
  },
  pillText: {
    fontSize: 14,
    fontWeight: '500',
  },
  // Grouped rows, as Aave groups its settings: each block is one rounded card.
  group: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
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
    fontSize: 14,
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
