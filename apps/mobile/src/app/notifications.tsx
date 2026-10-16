import { router } from 'expo-router';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { ProposalRow } from '@/components/wallet/MultisigParts';
import { EmptyState, PushedScreen } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import {
  describe,
  timeAgo,
  useMultisigEvents,
  useMultisigState,
  useNeedsMyApproval,
} from '@/lib/multisig';
import { markNotificationsRead } from '@/lib/notifications';
import { makeStyles, useTheme } from '@/theme';

const openProposal = (id: string) => {
  tap();
  router.push({ pathname: '/proposal/[id]', params: { id } });
};

/**
 * What needs you (approvals in your shared wallets) and what just happened on them:
 * approvals, rejections and payments that went through.
 */
export default function NotificationsScreen() {
  const styles = useStyles();
  const c = useTheme();
  // Opening the screen clears Home's unread badge.
  useEffect(markNotificationsRead, []);
  const waiting = useNeedsMyApproval();
  const events = useMultisigEvents();
  const { multisigs, proposals } = useMultisigState();

  return (
    <PushedScreen title="Notifications" contentStyle={styles.content}>
      {waiting.length > 0 && (
        <>
          <Text style={styles.section}>Needs your approval</Text>
          {waiting.map((p) => {
            const m = multisigs[p.walletId];
            return m ? (
              <ProposalRow
                key={p.id}
                multisig={m}
                proposal={p}
                onPress={() => openProposal(p.id)}
              />
            ) : null;
          })}
        </>
      )}
      {events.length > 0 && (
        <>
          <Text style={styles.section}>Recent</Text>
          {events.map((e) => {
            const p = proposals.find((x) => x.id === e.proposalId);
            if (!p) return null;
            const info = describe(p.action);
            const text =
              e.kind === 'executed'
                ? `${info.done}: ${info.title}`
                : `${e.memberName} ${e.kind} “${info.title}”`;
            return (
              <PressableRow key={e.id} onPress={() => openProposal(p.id)} style={styles.event}>
                <View style={styles.eventIcon}>
                  <Icon
                    name={e.kind === 'rejected' ? 'close' : 'check'}
                    size={14}
                    color={e.kind === 'rejected' ? c.error : c.success}
                  />
                </View>
                <View style={styles.flex}>
                  <Text style={styles.eventText}>{text}</Text>
                  <Text style={styles.eventTime}>{timeAgo(e.at)}</Text>
                </View>
              </PressableRow>
            );
          })}
        </>
      )}
      {waiting.length === 0 && events.length === 0 && (
        <EmptyState
          icon="bell"
          title="You're all caught up"
          hint="Approvals for shared wallets, incoming payments and security alerts show up here."
        />
      )}
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
  section: {
    marginTop: 18,
    marginBottom: 4,
    color: c.textSecondary,
    fontSize: 15,
  },
  event: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  eventIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.card,
  },
  eventText: {
    color: c.text,
    fontSize: 15,
    lineHeight: 20,
  },
  eventTime: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 13,
  },
}));
