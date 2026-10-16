import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { MemberAvatar, networkLabel, ProposalRow } from '@/components/wallet/MultisigParts';
import { tap } from '@/lib/haptics';
import {
  hasVoted,
  type Member,
  type Multisig,
  useMultisigState,
  useNeedsMyApproval,
  useProposals,
  walletName,
  YOU,
} from '@/lib/multisig';
import { makeStyles, useTheme } from '@/theme';

const openProposal = (id: string) => {
  tap();
  router.push({ pathname: '/proposal/[id]', params: { id } });
};

/** How many waiting proposals Home lists before "See all". */
const MAX_ROWS = 3;

/**
 * Home's card for a shared wallet: its members and rule (tap for the wallet page),
 * then what's waiting for approval, yours to answer first.
 */
export function SharedWalletCard({ multisig }: { multisig: Multisig }) {
  const styles = useStyles();
  const c = useTheme();
  const { pending } = useProposals(multisig.walletId);
  const yours = pending.filter((p) => !hasVoted(p, YOU));
  const sorted = [...yours, ...pending.filter((p) => hasVoted(p, YOU))];
  const openWallet = () => {
    tap();
    router.push({ pathname: '/multisig/[id]', params: { id: multisig.walletId } });
  };
  return (
    <View style={styles.card}>
      <PressableScale onPress={openWallet} scaleTo={0.98} style={styles.head}>
        <View style={styles.faces}>
          {multisig.members.slice(0, 5).map((m, i) => (
            <View key={m.id} style={[styles.face, i > 0 && styles.overlap]}>
              <MemberAvatar member={m} size={26} />
            </View>
          ))}
        </View>
        <View style={styles.flex}>
          <Text style={styles.title}>
            {multisig.threshold} of {multisig.members.length} approvals
          </Text>
          <Text style={styles.sub}>{networkLabel(multisig)}</Text>
        </View>
        <Icon name="chevronRight" size={13} color={c.textSecondary} />
      </PressableScale>
      {sorted.length ? (
        <View style={styles.list}>
          <Text style={styles.section}>
            {yours.length ? `Needs your approval (${yours.length})` : 'Waiting for others'}
          </Text>
          {sorted.slice(0, MAX_ROWS).map((p) => (
            <ProposalRow
              key={p.id}
              multisig={multisig}
              proposal={p}
              onPress={() => openProposal(p.id)}
            />
          ))}
          {sorted.length > MAX_ROWS ? (
            <PressableScale onPress={openWallet} scaleTo={0.98}>
              <Text style={styles.more}>See all {sorted.length}</Text>
            </PressableScale>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * On any other wallet: a nudge when proposals in your shared wallets are waiting
 * for you. Tapping opens the first one.
 */
export function ApprovalsNudge() {
  const styles = useStyles();
  const c = useTheme();
  const waiting = useNeedsMyApproval();
  const { multisigs } = useMultisigState();
  if (!waiting.length) return null;
  const wallets = new Set(waiting.map((p) => p.walletId)).size;
  const first = waiting[0];
  const where = wallets > 1 ? `In ${wallets} shared wallets` : `In ${walletName(first.walletId)}`;
  // The faces of who's asking (up to two), rather than a generic people icon.
  const askers: Member[] = [];
  for (const p of waiting) {
    const m = multisigs[p.walletId]?.members.find((x) => x.id === p.createdBy);
    if (m && m.id !== YOU && !askers.some((a) => a.id === m.id)) askers.push(m);
    if (askers.length === 2) break;
  }
  return (
    <PressableScale onPress={() => openProposal(first.id)} scaleTo={0.98} style={styles.nudge}>
      {askers.length ? (
        <View style={styles.faces2}>
          {askers.map((m, i) => (
            <View key={m.id} style={[styles.face2, i === 1 && styles.face2Back]}>
              <MemberAvatar member={m} size={askers.length === 1 ? 38 : 30} />
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.nudgeIcon}>
          <Icon name="multisig" size={18} color={c.accentText} />
        </View>
      )}
      <View style={styles.flex}>
        <Text style={styles.title} numberOfLines={1}>
          {waiting.length} {waiting.length === 1 ? 'approval' : 'approvals'} waiting
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {where}
        </Text>
      </View>
      <View style={styles.pill}>
        <Text style={styles.pillLabel}>Review</Text>
      </View>
    </PressableScale>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: c.card,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  faces: {
    flexDirection: 'row',
  },
  face: {
    borderRadius: 999,
    borderWidth: 2,
    borderColor: c.card,
  },
  overlap: {
    marginLeft: -9,
  },
  title: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  sub: {
    marginTop: 1,
    color: c.textSecondary,
    fontSize: 13,
  },
  list: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: c.divider,
  },
  section: {
    color: c.textSecondary,
    fontSize: 14,
  },
  more: {
    paddingTop: 6,
    color: c.accentText,
    fontSize: 15,
    fontWeight: '500',
  },
  // Like the card above: a plain row with a small Review pill, as on Notifications.
  nudge: {
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: c.card,
  },
  faces2: {
    width: 44,
    height: 38,
  },
  face2: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 1,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: c.card,
  },
  face2Back: {
    left: 14,
    top: 8,
    zIndex: 0,
  },
  nudgeIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  pill: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  pillLabel: {
    color: c.accentText,
    fontSize: 14,
    fontWeight: '500',
  },
}));
