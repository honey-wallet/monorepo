import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import {
  ApprovalMeter,
  MEMBER_KIND_LABEL,
  MemberAvatar,
  networkLabel,
  ProposedPage,
} from '@/components/wallet/MultisigParts';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { closeSheet, SheetScreen, SheetSection, StatRow } from '@/components/wallet/Sheet';
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
  type ProposalAction,
  reject,
  timeAgo,
  useMultisig,
  useProposal,
  YOU,
} from '@/lib/multisig';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

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
      <SheetScreen title="Proposal" size="fill">
        <EmptyState icon="search" title="Proposal not found" hint="It may have been removed." />
      </SheetScreen>
    );
  }

  const info = describe(proposal.action);
  const pending = proposal.status === 'pending';
  const mine = proposal.createdBy === YOU;
  const canVote = pending && !hasVoted(proposal, YOU);
  const left = approvalsLeft(multisig, proposal);
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
    <SheetScreen title={`Proposal #${proposal.nonce}`} size="fill" footer={footer}>
      <ContentSwap id={voted ? 'outcome' : 'proposal'} index={voted ? 1 : 0} fill>
        {voted ? (
          <ProposedPage multisig={multisig} proposal={proposal} />
        ) : (
          <ScrollView style={styles.flex} showsVerticalScrollIndicator={false}>
            <View style={styles.summary}>
              {info.symbol ? <TokenIcon symbol={info.symbol} size={48} /> : null}
              <Text style={styles.title}>{info.title}</Text>
              <Text style={styles.sub}>
                {status(proposal.status, left)} · proposed by{' '}
                {memberName(multisig, proposal.createdBy)} {timeAgo(proposal.createdAt)}
              </Text>
            </View>
            <ApprovalMeter multisig={multisig} proposal={proposal} />

            <View style={styles.rows}>
              <ActionRows action={proposal.action} multisig={multisig} />
              <StatRow label="Wallet" value={networkLabel(multisig)} />
            </View>

            <SheetSection title="Approvals" />
            {multisig.members.map((m) => {
              const yes = proposal.approvals.find((v) => v.memberId === m.id);
              const no = proposal.rejections.find((v) => v.memberId === m.id);
              return (
                <View key={m.id} style={styles.member}>
                  <MemberAvatar member={m} size={34} />
                  <View style={styles.flex}>
                    <Text style={styles.memberName}>{memberName(multisig, m.id)}</Text>
                    <Text style={styles.memberSub}>{m.handle ?? MEMBER_KIND_LABEL[m.kind]}</Text>
                  </View>
                  <Text
                    style={[styles.vote, yes && { color: c.success }, no && { color: c.error }]}
                  >
                    {yes
                      ? `Approved ${timeAgo(yes.at)}`
                      : no
                        ? `Rejected ${timeAgo(no.at)}`
                        : pending
                          ? 'Waiting'
                          : '—'}
                  </Text>
                </View>
              );
            })}
            {pending ? (
              <Text style={styles.note}>
                Needs {multisig.threshold} of {multisig.members.length}. Once enough approve, Honey
                submits it on {multisig.network.name}.
              </Text>
            ) : null}
          </ScrollView>
        )}
      </ContentSwap>
    </SheetScreen>
  );
}

function status(s: 'pending' | 'executed' | 'rejected' | 'cancelled', left: number) {
  if (s === 'pending') return `${left} more to go`;
  if (s === 'executed') return 'Done';
  return s === 'rejected' ? 'Rejected' : 'Cancelled';
}

/** The details of what a proposal does, the same rows its review page showed. */
function ActionRows({ action, multisig }: { action: ProposalAction; multisig: Multisig }) {
  switch (action.type) {
    case 'send':
      return (
        <>
          <StatRow label="Amount" value={`${action.amount} ${action.symbol}`} />
          <StatRow label="Value" value={formatUsd(action.usd)} />
          <StatRow label="To" value={shortAddress(action.to)} />
        </>
      );
    case 'swap':
      return (
        <>
          <StatRow label="You pay" value={`${action.from.amount} ${action.from.symbol}`} />
          <StatRow label="You get" value={`≈ ${action.to.amount} ${action.to.symbol}`} />
          <StatRow label="Value" value={formatUsd(action.usd)} />
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
          <StatRow label="Amount" value={`${action.amount} ${action.symbol}`} />
          <StatRow label="Value" value={formatUsd(action.usd)} />
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
    paddingTop: 4,
    paddingBottom: 18,
  },
  title: {
    marginTop: 6,
    color: c.text,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  sub: {
    color: c.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
  rows: {
    marginTop: 18,
  },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  memberName: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  memberSub: {
    marginTop: 1,
    color: c.textSecondary,
    fontSize: 13,
  },
  vote: {
    color: c.textSecondary,
    fontSize: 14,
  },
  note: {
    marginTop: 12,
    marginBottom: 8,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
}));
