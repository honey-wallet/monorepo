import { router, useLocalSearchParams } from 'expo-router';
import { Linking, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { Sticky } from '@/components/motion/Sticky';
import { SheetRow } from '@/components/sheets/Sheet';
import {
  MemberAvatar,
  memberSubtitle,
  NetworkBadge,
  networkLabel,
  ProposalRow,
  ProposalRowSkeleton,
} from '@/components/wallet/MultisigParts';
import { EmptyState, PushedScreen, TokenIcon } from '@/components/wallet/parts';
import { useCopy } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { formatAmount, formatUsd, shortAddress } from '@/lib/mock-wallet';
import { memberName, PURPOSES, propose, useMultisig, useProposals, YOU } from '@/lib/multisig';
import { useProfile } from '@/lib/profile';
import { receiveAddresses } from '@/lib/receive';
import { showToast } from '@/lib/toast';
import { allWallets, useWallets } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';

/** Safe's app knows networks by short name; elsewhere its home page. */
const SAFE_PREFIX: Record<number, string> = { 1: 'eth', 8453: 'base', 10: 'oeth', 42161: 'arb1' };

/**
 * A shared wallet: its rule and network, what's waiting for approval, its members,
 * the rules you can change (each change is itself a proposal) and its history.
 */
export default function MultisigScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const c = useTheme();
  const { name } = useProfile();
  const { added } = useWallets();
  const wallet = allWallets(name, added).find((w) => w.id === id);
  const multisig = useMultisig(id);
  const { pending, history } = useProposals(id);
  const address = wallet ? receiveAddresses(wallet)[0]?.address : undefined;
  const { copied, copy } = useCopy(address ?? '', 'Address copied');
  // Balances are read from the chain.
  const loading = useFirstLoad(LOADS.balances(id));
  // So are its proposals, the same fetch as Activity's.
  const proposalsLoading = useFirstLoad(LOADS.activity(id));

  if (!wallet || !multisig) {
    return (
      <PushedScreen title="Shared wallet">
        <EmptyState
          icon="multisig"
          title="Not found"
          hint="This shared wallet isn't on this device."
          action={{ label: 'See wallets', onPress: () => router.replace('/wallets') }}
        />
      </PushedScreen>
    );
  }

  const openProposal = (pid: string) => {
    tap();
    router.push({ pathname: '/proposal/[id]', params: { id: pid } });
  };
  const edit = (kind: 'rule' | 'limit' | 'member') => {
    tap();
    router.push({ pathname: '/multisig-edit', params: { id, kind } });
  };
  const removeMember = (memberId: string) => {
    const member = multisig.members.find((m) => m.id === memberId);
    if (!member) return;
    tap();
    const { proposal } = propose(id, { type: 'removeMember', memberId, name: member.name });
    showToast('Removal proposed');
    router.push({ pathname: '/proposal/[id]', params: { id: proposal.id } });
  };
  const viewOnline = () => {
    tap();
    const chainId = multisig.network.chainId;
    const url =
      multisig.protocol === 'squads'
        ? 'https://app.squads.so'
        : address && chainId !== null && SAFE_PREFIX[chainId]
          ? `https://app.safe.global/home?safe=${SAFE_PREFIX[chainId]}:${address}`
          : 'https://app.safe.global';
    Linking.openURL(url).catch(() => {});
  };

  const total = multisig.holdings.reduce((s, h) => s + h.usd, 0) || wallet.usd;

  return (
    <PushedScreen title={wallet.label} contentStyle={styles.content}>
      {/* What it is: rule, network and address */}
      <View style={styles.card}>
        <View style={styles.cardTop}>
          <NetworkBadge network={multisig.network} size={40} />
          <View style={styles.flex}>
            <Text style={styles.cardTitle}>
              {multisig.threshold} of {multisig.members.length} approvals
            </Text>
            <Text style={styles.cardSub}>
              {PURPOSES[multisig.purpose].title} · {networkLabel(multisig)}
            </Text>
          </View>
        </View>
        <PressableScale onPress={copy} scaleTo={0.98} style={styles.address}>
          <Text style={styles.addressText}>
            {address
              ? `${shortAddress(address, 8, 6)} · only on ${multisig.network.name}`
              : 'Demo wallet · receiving unavailable'}
          </Text>
          <IconSwap name={copied ? 'check' : 'copy'} size={14} color={c.textSecondary} />
        </PressableScale>
      </View>

      {/* Balance */}
      <SkeletonReveal
        loading={loading}
        skeleton={
          <View>
            <View style={styles.totalSkeleton}>
              <SkeletonBar width={150} height={30} radius={8} />
            </View>
            {[0, 1].map((i) => (
              <View key={i} style={styles.holding}>
                <SkeletonBar width={30} height={30} radius={15} />
                <View style={styles.flex}>
                  <SkeletonBar width={52} height={14} />
                </View>
                <SkeletonBar width={48} height={13} />
                <SkeletonBar width={64} height={14} />
              </View>
            ))}
          </View>
        }
      >
        <Text style={styles.total}>{formatUsd(total)}</Text>
        {multisig.holdings.map((h) => (
          <View key={`${h.symbol}-${h.chain}`} style={styles.holding}>
            <TokenIcon symbol={h.symbol} size={30} />
            <Text style={[styles.flex, styles.holdingName]}>{h.symbol}</Text>
            <Text style={styles.holdingAmount}>{formatAmount(h.amount)}</Text>
            <Text style={styles.holdingUsd}>{formatUsd(h.usd)}</Text>
          </View>
        ))}
        {multisig.holdings.length === 0 ? (
          <EmptyState
            compact
            icon="receive"
            title="Nothing here yet"
            hint="Shared wallets are a preview. Do not send funds to them."
          />
        ) : null}
      </SkeletonReveal>

      {/* Waiting for approval */}
      <Sticky id="waiting" style={styles.sectionGap}>
        <Text style={styles.section}>Waiting for approval</Text>
      </Sticky>
      {proposalsLoading ? (
        <ProposalRowSkeleton count={1} />
      ) : pending.length ? (
        pending.map((p) => (
          <ProposalRow
            key={p.id}
            multisig={multisig}
            proposal={p}
            onPress={() => openProposal(p.id)}
          />
        ))
      ) : (
        <Text style={styles.hint}>
          Nothing waiting. Anything sent from here starts as a proposal.
        </Text>
      )}

      {/* Members */}
      <Sticky id="members" style={styles.sectionGap}>
        <Text style={styles.section}>{PURPOSES[multisig.purpose].members}</Text>
      </Sticky>
      {multisig.members.map((m) => (
        <View key={m.id} style={styles.member}>
          <MemberAvatar member={m} size={36} />
          <View style={styles.flex}>
            <Text style={styles.memberName}>{memberName(multisig, m.id)}</Text>
            <Text style={styles.memberSub}>{memberSubtitle(m)}</Text>
          </View>
          {m.id === YOU || multisig.members.length <= 2 ? null : (
            <PressableScale
              accessibilityLabel={`Propose removing ${m.name}`}
              hitSlop={8}
              onPress={() => removeMember(m.id)}
            >
              <Text style={styles.remove}>Remove</Text>
            </PressableScale>
          )}
        </View>
      ))}
      <SheetRow icon="plus" title="Add member" onPress={() => edit('member')} accessory="chevron" />

      {/* Rules: changing either needs approvals */}
      <Sticky id="rules" style={styles.sectionGap}>
        <Text style={styles.section}>Rules</Text>
      </Sticky>
      <SheetRow
        icon="checkCircle"
        title="Approvals needed"
        value={`${multisig.threshold} of ${multisig.members.length}`}
        onPress={() => edit('rule')}
        accessory="chevron"
      />
      <SheetRow
        icon="clock"
        title="Daily spending limit"
        subtitle="Any member can spend up to this alone each day"
        value={multisig.dailyLimit ? formatUsd(multisig.dailyLimit) : 'None'}
        onPress={() => edit('limit')}
        accessory="chevron"
      />

      {/* History */}
      <Sticky id="history" style={styles.sectionGap}>
        <Text style={styles.section}>History</Text>
      </Sticky>
      {proposalsLoading ? (
        <ProposalRowSkeleton count={2} />
      ) : history.length ? (
        history.map((p) => (
          <ProposalRow
            key={p.id}
            multisig={multisig}
            proposal={p}
            onPress={() => openProposal(p.id)}
          />
        ))
      ) : (
        <Text style={styles.hint}>
          No transactions yet. Approved and rejected proposals land here.
        </Text>
      )}

      <PressableScale onPress={viewOnline} scaleTo={0.98} style={styles.external}>
        <Text style={styles.externalText}>
          View on {multisig.protocol === 'safe' ? 'Safe' : 'Squads'}
        </Text>
        <Icon name="link" size={13} color={c.textSecondary} />
      </PressableScale>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  content: {
    paddingHorizontal: 20,
  },
  flex: {
    flex: 1,
  },
  card: {
    marginTop: 4,
    padding: 16,
    ...radius(20),
    backgroundColor: c.card,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardTitle: {
    color: c.text,
    fontSize: 18,
    fontWeight: '600',
  },
  cardSub: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  address: {
    marginTop: 14,
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: c.divider,
  },
  addressText: {
    color: c.textSecondary,
    fontSize: 15,
  },
  total: {
    marginTop: 22,
    marginBottom: 6,
    color: c.text,
    fontSize: 34,
    fontWeight: '500',
    letterSpacing: -0.6,
  },
  // The total's line box (34pt), with the same margins.
  totalSkeleton: {
    marginTop: 22,
    marginBottom: 6,
    height: 41,
    justifyContent: 'center',
  },
  holding: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  holdingName: {
    color: c.text,
    fontSize: 16,
  },
  holdingAmount: {
    color: c.textSecondary,
    fontSize: 15,
  },
  holdingUsd: {
    minWidth: 76,
    color: c.text,
    fontSize: 16,
    textAlign: 'right',
  },
  sectionGap: {
    marginTop: 18,
  },
  section: {
    paddingTop: 8,
    paddingBottom: 4,
    color: c.textSecondary,
    fontSize: 15,
  },
  hint: {
    paddingVertical: 8,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 19,
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
  remove: {
    color: c.error,
    fontSize: 14,
    fontWeight: '500',
  },
  external: {
    marginTop: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  externalText: {
    color: c.textSecondary,
    fontSize: 15,
  },
}));
