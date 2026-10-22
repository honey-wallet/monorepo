import { Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon, type IconName } from '@/components/Icon';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, SkeletonGroup } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { TokenIcon } from '@/components/wallet/parts';
import type { EvmChain } from '@/lib/evm-chains';
import { tap } from '@/lib/haptics';
import { shortAddress } from '@/lib/mock-wallet';
import {
  describe,
  hasVoted,
  keyNoun,
  type Member,
  type MemberKind,
  type Multisig,
  type MultisigNetwork,
  memberName,
  type Proposal,
  protocolName,
  recommendedThreshold,
  useMultisig,
  useProposal,
} from '@/lib/multisig';
import { makeStyles, useTheme } from '@/theme';

/** Networks with a coin logo of their own; the rest get a lettered badge. */
const NETWORK_LOGO: Record<string, string> = { 1: 'ETH', 8453: 'BASE', solana: 'SOL' };

/** A network's logo, or a coloured circle with its first letter. */
export function NetworkBadge({
  network,
  size = 28,
}: {
  network: Pick<EvmChain, 'name' | 'color'> & { chainId: number | null };
  size?: number;
}) {
  const logo = NETWORK_LOGO[network.chainId === null ? 'solana' : String(network.chainId)];
  if (logo) return <TokenIcon symbol={logo} size={size} />;
  const bg = network.color ?? '#8A8A8E';
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bg,
      }}
    >
      <Text style={{ color: '#FFFFFF', fontSize: size * 0.45, fontWeight: '700' }}>
        {network.name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

/** "Safe · Base", "Squads · Solana". */
export const networkLabel = (m: { protocol: Multisig['protocol']; network: MultisigNetwork }) =>
  `${protocolName(m.protocol)} · ${m.network.name}`;

const KEY_ICONS: Record<Exclude<MemberKind, 'person' | 'you'>, IconName> = {
  device: 'key',
  hardware: 'hardware',
  recovery: 'recovery',
};

export const MEMBER_KIND_LABEL: Record<MemberKind, string> = {
  you: 'This device',
  device: 'Another device',
  hardware: 'Hardware wallet',
  recovery: 'Recovery key',
  person: 'Member',
};

/**
 * The line under a member's name: an address for people, and for you the key this wallet
 * gave you (its own, separate from your Honey wallet's).
 */
export function memberSubtitle(m: Member) {
  if (m.kind === 'you') return `Own key · ${shortAddress(m.address)}`;
  if (m.kind === 'person') return shortAddress(m.address);
  return MEMBER_KIND_LABEL[m.kind];
}

/** A member's picture: a face for people (and you), a symbol for your other keys. */
export function MemberAvatar({ member, size = 36 }: { member: Member; size?: number }) {
  const c = useTheme();
  if (member.kind === 'person' || member.kind === 'you') {
    return <Avatar name={member.name} size={size} seed={member.address} />;
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.accentSurface,
      }}
    >
      <Icon name={KEY_ICONS[member.kind]} size={size * 0.5} color={c.accentText} />
    </View>
  );
}

/**
 * Who has approved: every member's picture in a row, ticked once they've approved
 * (crossed if they refused, dimmed while waiting), with "2 of 3 approved".
 */
export function ApprovalMeter({
  multisig,
  proposal,
  size = 28,
  align = 'center',
}: {
  multisig: Multisig;
  proposal: Proposal;
  size?: number;
  align?: 'center' | 'start';
}) {
  const styles = useStyles();
  const c = useTheme();
  const approved = proposal.approvals.length;
  return (
    <View style={[styles.meter, align === 'start' && styles.meterStart]}>
      <View style={styles.faces}>
        {multisig.members.map((m, i) => {
          const yes = proposal.approvals.some((v) => v.memberId === m.id);
          const no = proposal.rejections.some((v) => v.memberId === m.id);
          return (
            <View
              key={m.id}
              style={[
                styles.face,
                i > 0 && { marginLeft: -size / 4 },
                !yes && !no && styles.waiting,
              ]}
            >
              <MemberAvatar member={m} size={size} />
              {yes || no ? (
                <View style={[styles.mark, { backgroundColor: yes ? c.success : c.error }]}>
                  <Icon name={yes ? 'check' : 'close'} size={8} color="#FFFFFF" />
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
      <Text style={styles.meterLabel}>
        {approved} of {multisig.threshold} approved
      </Text>
    </View>
  );
}

/** One proposal in a list: what it does, who proposed it, and its approvals so far. */
export function ProposalRow({
  multisig,
  proposal,
  onPress,
}: {
  multisig: Multisig;
  proposal: Proposal;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const info = describe(proposal.action);
  const waitingOnYou = proposal.status === 'pending' && !hasVoted(proposal, 'you');
  const status =
    proposal.status === 'pending'
      ? waitingOnYou
        ? 'Needs your approval'
        : `${proposal.approvals.length} of ${multisig.threshold} approved`
      : proposal.status === 'executed'
        ? info.done
        : proposal.status === 'rejected'
          ? 'Rejected'
          : 'Cancelled';
  return (
    <PressableRow onPress={onPress} style={styles.row}>
      <View style={styles.rowIcon}>
        {info.symbol ? (
          <TokenIcon symbol={info.symbol} size={36} />
        ) : (
          <Icon name={info.icon} size={18} color={c.accentText} />
        )}
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {info.title}
        </Text>
        <Text style={[styles.rowSubtitle, waitingOnYou && styles.rowAction]} numberOfLines={1}>
          {status} · by {memberName(multisig, proposal.createdBy)}
        </Text>
      </View>
      <Text style={styles.nonce}>#{proposal.nonce}</Text>
      <Icon name="chevronRight" size={14} color={c.textSecondary} />
    </PressableRow>
  );
}

/** `count` rows the shape of `ProposalRow`, while proposals load from the chain. */
export function ProposalRowSkeleton({ count = 2 }: { count?: number }) {
  const styles = useStyles();
  return (
    <SkeletonGroup>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <View key={i} style={styles.row}>
          <SkeletonBar width={36} height={36} radius={18} />
          <View style={[styles.rowText, styles.rowSkeletonText]}>
            <SkeletonBar width="50%" height={14} />
            <SkeletonBar width="70%" height={12} />
          </View>
          <SkeletonBar width={24} height={12} />
        </View>
      ))}
    </SkeletonGroup>
  );
}

/**
 * "2 of 3": how many approvals a shared wallet needs, with − and +, plus a line on
 * what the choice means. A majority is marked as recommended.
 */
export function ThresholdStepper({
  value,
  members,
  onChange,
}: {
  value: number;
  members: number;
  onChange: (next: number) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const recommended = recommendedThreshold(members);
  const step = (d: number) => {
    const next = Math.min(Math.max(value + d, 1), members);
    if (next === value) return;
    tap();
    onChange(next);
  };
  const advice =
    members < 2
      ? 'Add at least one more member first.'
      : value === 1
        ? 'Anyone can act alone. Fast, but one lost or stolen key is enough to move funds.'
        : value === members
          ? 'Everyone has to approve. If one key is lost, the funds are stuck.'
          : `Any ${value} of the ${members} can act, so losing ${members - value === 1 ? 'one key' : `${members - value} keys`} never locks you out.`;
  return (
    <View style={styles.stepperWrap}>
      <View style={styles.stepper}>
        <PressableScale
          accessibilityLabel="Fewer approvals"
          disabled={value <= 1}
          onPress={() => step(-1)}
          style={[styles.stepButton, value <= 1 && styles.stepDisabled]}
        >
          <Icon name="minusCircle" size={24} color={c.textSecondary} />
        </PressableScale>
        <View style={styles.stepValue}>
          <NumberPopIn value={String(value)} style={styles.stepNumber} />
          <Text style={styles.stepOf}>of {members}</Text>
        </View>
        <PressableScale
          accessibilityLabel="More approvals"
          disabled={value >= members}
          onPress={() => step(1)}
          style={[styles.stepButton, value >= members && styles.stepDisabled]}
        >
          <Icon name="plus" size={22} color={c.textSecondary} />
        </PressableScale>
      </View>
      <TextSwap
        text={value === recommended && members > 1 ? 'Recommended' : ' '}
        style={styles.recommended}
      />
      <Text style={styles.advice}>{advice}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  stepperWrap: {
    alignItems: 'center',
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 28,
  },
  stepButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  stepDisabled: {
    opacity: 0.4,
  },
  stepValue: {
    minWidth: 110,
    alignItems: 'center',
  },
  stepNumber: {
    color: c.text,
    fontSize: 56,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  stepOf: {
    color: c.textSecondary,
    fontSize: 17,
  },
  recommended: {
    marginTop: 14,
    color: c.accentText,
    fontSize: 14,
    fontWeight: '600',
  },
  advice: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  meter: {
    alignItems: 'center',
    gap: 8,
  },
  meterStart: {
    alignItems: 'flex-start',
  },
  faces: {
    flexDirection: 'row',
  },
  face: {
    borderRadius: 999,
    borderWidth: 2,
    borderColor: c.sheet,
  },
  waiting: {
    opacity: 0.45,
  },
  mark: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: c.sheet,
  },
  meterLabel: {
    color: c.textSecondary,
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  rowText: {
    flex: 1,
  },
  // Title and subtitle's line boxes (16pt + 14pt), so rows don't jump on reveal.
  rowSkeletonText: {
    height: 39,
    justifyContent: 'center',
    gap: 9,
  },
  rowTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  rowSubtitle: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  rowAction: {
    color: c.accentText,
    fontWeight: '500',
  },
  nonce: {
    color: c.textSecondary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
}));

/**
 * The closing page after proposing from a shared wallet: what was proposed and who
 * still has to approve. It updates live as approvals come in.
 */
export function ProposedPage({
  multisig,
  proposal,
  onDone,
  compact,
}: {
  multisig: Multisig;
  proposal: Proposal;
  onDone?: () => void;
  /** Inside a tray or pop-up. */
  compact?: boolean;
}) {
  const left = Math.max(0, multisig.threshold - proposal.approvals.length);
  const info = describe(proposal.action);
  const done = proposal.status === 'executed';
  // In a vault the other approvers are your own keys, so say where to approve.
  const key = multisig.members.find((m) => m.kind !== 'you' && m.kind !== 'person');
  const vault = multisig.members.every((m) => m.kind !== 'person');
  return (
    <SuccessPage
      compact={compact}
      title={done ? info.done : 'Proposed'}
      detail={
        done
          ? `${info.title}. Everyone needed has approved.`
          : vault && key
            ? `${info.title}. Approve it on your ${keyNoun(key)} to finish.`
            : `${info.title}. Needs ${left} more ${left === 1 ? 'approval' : 'approvals'}.`
      }
      onDone={onDone}
    >
      <ApprovalMeter multisig={multisig} proposal={proposal} />
    </SuccessPage>
  );
}

/** `ProposedPage` for a proposal by id, following it as approvals come in. */
export function LiveProposedPage({
  proposalId,
  onDone,
  compact,
}: {
  proposalId: string;
  onDone?: () => void;
  compact?: boolean;
}) {
  const proposal = useProposal(proposalId);
  const multisig = useMultisig(proposal?.walletId);
  if (!proposal || !multisig) return null;
  return <ProposedPage multisig={multisig} proposal={proposal} onDone={onDone} compact={compact} />;
}
