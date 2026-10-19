import { router } from 'expo-router';
import { type ReactNode, useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { fadeIn, fadeOut } from '@/components/motion/reducedFade';
import {
  SkeletonBar,
  SkeletonList,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { Sticky } from '@/components/motion/Sticky';
import { useHasMounted } from '@/components/motion/useHasMounted';
import { MemberAvatar, NetworkBadge } from '@/components/wallet/MultisigParts';
import { EmptyState, PushedScreen, TokenIcon } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import {
  describe,
  type Multisig,
  type MultisigEvent,
  memberOf,
  type Proposal,
  reject,
  timeAgo,
  useMultisigEvents,
  useMultisigState,
  useNeedsMyApproval,
  walletName,
} from '@/lib/multisig';
import { markNotificationsRead } from '@/lib/notifications';
import { showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';
import { LAYOUT_MOVE } from '@/theme/motion';

const openProposal = (id: string) => {
  tap();
  router.push({ pathname: '/proposal/[id]', params: { id } });
};

const DAY = 24 * 60 * 60 * 1000;
/** "25 min ago" → "25 min", to sit on the right like Activity's dates. */
const when = (at: number) => timeAgo(at).replace(/ ago$/, '');
/** "Send 25 USDC" → "Wants to send 25 USDC". */
const wantsTo = (title: string) => `Wants to ${title.charAt(0).toLowerCase()}${title.slice(1)}`;

/**
 * Notifications, laid out like Activity: what's waiting for your approval (answer it
 * here, or open it to review), then what happened on your shared wallets, by day.
 * Rows slide out of the way as they're answered.
 */
export default function NotificationsScreen() {
  const styles = useStyles();
  // Opening the screen clears Home's unread badge.
  useEffect(markNotificationsRead, []);
  const mounted = useHasMounted();
  const waiting = useNeedsMyApproval();
  const events = useMultisigEvents();
  const { multisigs, proposals } = useMultisigState();
  const loading = useFirstLoad(LOADS.notifications);

  const today = events.filter((e) => Date.now() - e.at < DAY);
  const earlier = events.filter((e) => Date.now() - e.at >= DAY);
  // Rows ease out when answered and in when new; the rest close up behind them.
  const motion = {
    layout: LAYOUT_MOVE,
    entering: mounted ? fadeIn() : undefined,
    exiting: fadeOut(),
  };
  const feed = (list: MultisigEvent[]) =>
    list.map((e) => {
      const p = proposals.find((x) => x.id === e.proposalId);
      const m = p && multisigs[p.walletId];
      return p && m ? (
        <Animated.View key={e.id} {...motion}>
          <EventRow event={e} proposal={p} multisig={m} />
        </Animated.View>
      ) : null;
    });

  return (
    <PushedScreen title="Notifications" contentStyle={styles.content}>
      <SkeletonReveal
        loading={loading}
        skeleton={
          <View style={styles.group}>
            <View style={styles.sectionSkeleton}>
              <SkeletonBar width={90} height={12} />
            </View>
            <SkeletonList count={5} icon={42} trailing={false} style={styles.rowSkeleton} />
          </View>
        }
      >
        {waiting.length > 0 && (
          <Animated.View layout={LAYOUT_MOVE} exiting={fadeOut()} style={styles.group}>
            <Sticky id="waiting">
              <Text style={styles.section}>Needs your approval</Text>
            </Sticky>
            {waiting.map((p) => {
              const m = multisigs[p.walletId];
              return m ? (
                <Animated.View key={p.id} {...motion}>
                  <RequestRow proposal={p} multisig={m} />
                </Animated.View>
              ) : null;
            })}
          </Animated.View>
        )}
        {today.length > 0 && (
          <Animated.View layout={LAYOUT_MOVE} style={styles.group}>
            <Sticky id="today">
              <Text style={styles.section}>Today</Text>
            </Sticky>
            {feed(today)}
          </Animated.View>
        )}
        {earlier.length > 0 && (
          <Animated.View layout={LAYOUT_MOVE} style={styles.group}>
            <Sticky id="earlier">
              <Text style={styles.section}>Earlier</Text>
            </Sticky>
            {feed(earlier)}
          </Animated.View>
        )}
        {waiting.length === 0 && events.length === 0 && (
          <EmptyState
            icon="bell"
            title="You're all caught up"
            hint="Approvals for shared wallets, incoming payments and security alerts show up here."
            action={{
              label: 'Notification settings',
              onPress: () => router.push('/settings-notifications'),
            }}
          />
        )}
      </SkeletonReveal>
    </PushedScreen>
  );
}

/** The face that leads a row, with a small badge in the corner (like Activity's). */
function Lead({
  face,
  badge,
}: {
  face: ReactNode;
  badge: { icon?: IconName; color?: string; node?: ReactNode };
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View>
      {face}
      <View style={[styles.badge, badge.color ? { backgroundColor: badge.color } : null]}>
        {badge.node ?? (badge.icon ? <Icon name={badge.icon} size={9} color={c.canvas} /> : null)}
      </View>
    </View>
  );
}

/** A request for your approval: who asks, from which wallet, how far along, your answer. */
function RequestRow({ proposal, multisig }: { proposal: Proposal; multisig: Multisig }) {
  const styles = useStyles();
  const c = useTheme();
  const info = describe(proposal.action);
  const by = memberOf(multisig, proposal.createdBy);
  return (
    <PressableRow onPress={() => openProposal(proposal.id)} style={styles.row}>
      <Lead
        face={by ? <MemberAvatar member={by} size={42} /> : null}
        badge={{ node: <NetworkBadge network={multisig.network} size={15} /> }}
      />
      <View style={styles.flex}>
        <View style={styles.head}>
          <Text style={styles.title} numberOfLines={1}>
            {by?.name ?? 'Someone'} · {walletName(multisig.walletId)}
          </Text>
          <Text style={styles.date}>{when(proposal.createdAt)}</Text>
        </View>
        <Text style={styles.detail}>{wantsTo(info.title)}</Text>
        <View style={styles.actions}>
          <Text style={styles.progress} numberOfLines={1}>
            {proposal.approvals.length} of {multisig.threshold} approved
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Reject: ${info.title}`}
            onPress={() => {
              tap();
              reject(proposal.id);
              showToast('Transaction rejected');
            }}
            style={styles.chip}
          >
            <Icon name="close" size={11} color={c.text} />
            <Text style={styles.chipLabel}>Reject</Text>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Review: ${info.title}`}
            onPress={() => openProposal(proposal.id)}
            style={[styles.chip, styles.chipPrimary]}
          >
            <Icon name="check" size={11} color={c.accentText} />
            <Text style={[styles.chipLabel, styles.chipPrimaryLabel]}>Review</Text>
          </PressableScale>
        </View>
      </View>
    </PressableRow>
  );
}

/** Something that happened: someone approved or rejected, or a proposal went through. */
function EventRow({
  event,
  proposal,
  multisig,
}: {
  event: MultisigEvent;
  proposal: Proposal;
  multisig: Multisig;
}) {
  const styles = useStyles();
  const c = useTheme();
  const info = describe(proposal.action);
  const member = event.memberId ? memberOf(multisig, event.memberId) : undefined;
  const rejected = event.kind === 'rejected';
  const title =
    event.kind === 'executed'
      ? `${info.done} · ${walletName(multisig.walletId)}`
      : `${event.memberName} ${event.kind} · ${walletName(multisig.walletId)}`;
  return (
    <PressableRow onPress={() => openProposal(proposal.id)} style={styles.row}>
      <Lead
        face={
          member ? (
            <MemberAvatar member={member} size={42} />
          ) : (
            <TokenIcon symbol={info.symbol ?? 'GENERIC'} size={42} />
          )
        }
        badge={{ icon: rejected ? 'close' : 'check', color: rejected ? c.error : c.success }}
      />
      <View style={styles.flex}>
        <View style={styles.head}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.date}>{when(event.at)}</Text>
        </View>
        <Text style={styles.detail} numberOfLines={1}>
          {info.title}
        </Text>
      </View>
    </PressableRow>
  );
}

const useStyles = makeStyles((c) => ({
  content: {
    paddingHorizontal: 18,
  },
  flex: {
    flex: 1,
  },
  // Sections sit close: a row's own padding already spaces it from the next label.
  group: {
    marginTop: 4,
    marginBottom: 4,
  },
  // Matches Activity's month labels.
  section: {
    paddingVertical: 6,
    color: c.textSecondary,
    fontSize: 15,
  },
  // The label's line box (15pt + padding), so rows don't shift when it arrives.
  sectionSkeleton: {
    height: 30,
    justifyContent: 'center',
  },
  rowSkeleton: {
    gap: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    paddingVertical: 10,
    marginHorizontal: -18,
    paddingHorizontal: 18,
  },
  badge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.canvas,
    borderWidth: 2,
    borderColor: c.canvas,
  },
  // Title and time share a line, so every row's body (and its buttons) spans the same width.
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  title: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 16,
  },
  detail: {
    marginTop: 2,
    color: c.text,
    fontSize: 17,
  },
  actions: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  progress: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 14,
  },
  // Small pills, like the amount chips on Send.
  chip: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: c.raised,
  },
  chipPrimary: {
    backgroundColor: c.accentSurface,
  },
  chipLabel: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
  chipPrimaryLabel: {
    color: c.accentText,
  },
  date: {
    color: c.textSecondary,
    fontSize: 15,
  },
}));
