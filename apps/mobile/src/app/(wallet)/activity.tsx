import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { OperationHistory } from '@/components/activity/OperationHistory';
import { Icon, type IconName } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { SkeletonBar, SkeletonReveal, useFirstLoad } from '@/components/motion/Skeleton';
import { Sticky } from '@/components/motion/Sticky';
import { HeaderActions } from '@/components/wallet/HeaderActions';
import { ProposalRow, ProposalRowSkeleton } from '@/components/wallet/MultisigParts';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { TabScreen } from '@/components/wallet/TabScreen';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { ACTIVITY, type Activity } from '@/lib/mock-wallet';
import { describe, useActiveMultisig, useProposals } from '@/lib/multisig';
import { type ActivityFilter, updateSectionPrefs, useSectionPrefs } from '@/lib/section-prefs';
import { useWalletView } from '@/lib/wallet-view';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles, useTheme } from '@/theme';

const KIND: Record<Activity['kind'], { title: string; badge: IconName }> = {
  sent: { title: 'Sent', badge: 'arrowUp' },
  received: { title: 'Received', badge: 'arrowDown' },
  swapped: { title: 'Swapped', badge: 'trade' },
  approved: { title: 'Approved', badge: 'check' },
};

const FILTER_KIND: Record<Exclude<ActivityFilter, 'All'>, Activity['kind']> = {
  Sent: 'sent',
  Received: 'received',
  Swaps: 'swapped',
};

export default function ActivityScreen() {
  const styles = useStyles();
  const { activityFilter, activityHideApprovals } = useSectionPrefs();
  // What Activity settings asks to show.
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (...texts: (string | undefined)[]) =>
    !q || texts.some((t) => t?.toLowerCase().includes(q));
  // A wallet that's never had money in it has no history, whatever the demo data says.
  const { empty } = useWalletView();
  const all = empty ? [] : ACTIVITY;
  const shown = all.filter(
    (a) =>
      (activityFilter === 'All' || a.kind === FILTER_KIND[activityFilter]) &&
      !(activityHideApprovals && a.kind === 'approved') &&
      matches(KIND[a.kind].title, a.detail, a.symbol),
  );
  const months = [...new Set(shown.map((a) => a.month))];
  // A shared wallet's proposals still collecting approvals come first.
  const multisig = useActiveMultisig();
  const wallet = useActiveWallet();
  const proposals = useProposals(multisig?.walletId ?? '');
  const pending = proposals.pending.filter((p) => matches(describe(p.action).title));
  const history = proposals.history.filter((p) => matches(describe(p.action).title));
  const loading = useFirstLoad(LOADS.activity(multisig?.walletId ?? wallet.id));
  const openProposal = (id: string) => {
    tap();
    router.push({ pathname: '/proposal/[id]', params: { id } });
  };

  if (!wallet.demo && wallet.kind === 'wallet') {
    return (
      <TabScreen title="Activity">
        <View style={styles.live}>
          {wallet.watchOnly ? (
            <Text style={styles.liveNote}>
              On-chain activity for watched addresses is not connected yet.
            </Text>
          ) : (
            <OperationHistory key={wallet.id} />
          )}
        </View>
      </TabScreen>
    );
  }

  return (
    // The same top bar as Search: a search field, then the balance and settings.
    <TabScreen>
      <View style={styles.top}>
        <View style={styles.flex}>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search activity" />
        </View>
        <HeaderActions
          settingsLabel="Activity settings"
          onSettings={() =>
            router.push({ pathname: '/section-settings', params: { section: 'activity' } })
          }
        />
      </View>
      <SkeletonReveal
        loading={loading}
        skeleton={multisig ? <ProposalsSkeleton /> : <ActivitySkeleton />}
      >
        <View>
          {multisig && pending.length > 0 && (
            <View style={styles.month}>
              <Sticky id="awaiting">
                <Text style={styles.monthLabel}>Awaiting approval</Text>
              </Sticky>
              {pending.map((p) => (
                <ProposalRow
                  key={p.id}
                  multisig={multisig}
                  proposal={p}
                  onPress={() => openProposal(p.id)}
                />
              ))}
            </View>
          )}
          {/* A shared wallet's history is its proposals: done, rejected or cancelled. */}
          {multisig && (
            <View style={styles.month}>
              <Sticky id="history">
                <Text style={styles.monthLabel}>History</Text>
              </Sticky>
              {history.map((p) => (
                <ProposalRow
                  key={p.id}
                  multisig={multisig}
                  proposal={p}
                  onPress={() => openProposal(p.id)}
                />
              ))}
              {history.length === 0 && pending.length === 0 && (
                <EmptyState
                  icon="history"
                  title={q ? 'No matches' : 'No activity yet'}
                  hint={
                    q
                      ? 'Try another word.'
                      : 'Payments and changes on this shared wallet show up here.'
                  }
                  action={q ? { label: 'Clear search', onPress: () => setQuery('') } : undefined}
                />
              )}
            </View>
          )}
          {!multisig &&
            months.map((month) => (
              <View key={month} style={styles.month}>
                <Sticky id={`month-${month}`}>
                  <Text style={styles.monthLabel}>{month}</Text>
                </Sticky>
                {shown
                  .filter((a) => a.month === month)
                  .map((a) => (
                    <ActivityRow key={a.id} activity={a} />
                  ))}
              </View>
            ))}
          {!multisig && shown.length === 0 && (
            <ActivityEmpty
              query={q}
              onClearSearch={() => setQuery('')}
              filtered={all.length > 0 && (activityFilter !== 'All' || activityHideApprovals)}
            />
          )}
        </View>
      </SkeletonReveal>
    </TabScreen>
  );
}

/** What Activity says when the list comes up empty, and the way out. */
function ActivityEmpty({
  query,
  filtered,
  onClearSearch,
}: {
  query: string;
  filtered: boolean;
  onClearSearch: () => void;
}) {
  if (query) {
    return (
      <EmptyState
        icon="search"
        title="No matches"
        hint="Try another word or token."
        action={{ label: 'Clear search', onPress: onClearSearch }}
      />
    );
  }
  if (filtered) {
    return (
      <EmptyState
        icon="history"
        title="Nothing to show"
        hint="Nothing matches what Activity is set to show."
        action={{
          label: 'Show everything',
          onPress: () =>
            updateSectionPrefs({ activityFilter: 'All', activityHideApprovals: false }),
        }}
      />
    );
  }
  return (
    <EmptyState
      icon="history"
      title="No activity yet"
      hint="Payments, swaps and approvals show up here."
      action={{ label: 'Receive', onPress: () => router.push('/receive') }}
    />
  );
}

/** A shared wallet's History label and proposal rows, while proposals load. */
function ProposalsSkeleton() {
  const styles = useStyles();
  return (
    <View style={styles.month}>
      <View style={styles.skeletonLabel}>
        <SkeletonBar width={60} height={14} />
      </View>
      <ProposalRowSkeleton count={4} />
    </View>
  );
}

/** A month label and rows the shape of `ActivityRow`, while history loads. */
function ActivitySkeleton() {
  const styles = useStyles();
  return (
    <View style={styles.month}>
      <View style={styles.skeletonLabel}>
        <SkeletonBar width={90} height={14} />
      </View>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <View key={i} style={styles.skeletonRow}>
          <SkeletonBar width={42} height={42} radius={21} />
          <View style={styles.skeletonLines}>
            <SkeletonBar width={64} height={13} />
            <SkeletonBar width="62%" height={16} />
          </View>
          <SkeletonBar width={44} height={13} />
        </View>
      ))}
    </View>
  );
}

function ActivityRow({ activity: a }: { activity: Activity }) {
  const styles = useStyles();
  const c = useTheme();
  const kind = KIND[a.kind];
  return (
    <PressableRow
      onPress={() => {
        tap();
        router.push({ pathname: '/activity/[id]', params: { id: a.id } });
      }}
      style={styles.row}
    >
      <View>
        <TokenIcon symbol={a.symbol} size={42} />
        <View style={styles.badge}>
          <Icon name={kind.badge} size={9} color={c.canvas} />
        </View>
      </View>
      <View style={styles.flex}>
        <Text style={styles.title}>{kind.title}</Text>
        {a.swap ? (
          <View style={styles.swap}>
            <TokenIcon symbol={a.swap.from[0]} size={16} />
            <Text style={styles.swapText}>
              {a.swap.from[1]} {a.swap.from[0]} →
            </Text>
            <TokenIcon symbol={a.swap.to[0]} size={16} />
            <Text style={styles.swapText}>
              {a.swap.to[1]} {a.swap.to[0]}
            </Text>
          </View>
        ) : (
          <Text style={styles.detail} numberOfLines={1}>
            {a.detail}
          </Text>
        )}
      </View>
      <Text style={styles.date}>{a.date}</Text>
    </PressableRow>
  );
}

const useStyles = makeStyles((c) => ({
  live: { padding: 20 },
  liveNote: { fontSize: 15, color: c.textSecondary },
  flex: {
    flex: 1,
  },
  top: {
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  month: {
    marginBottom: 12,
  },
  monthLabel: {
    paddingVertical: 4,
    color: c.textSecondary,
    fontSize: 16,
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
    width: 19,
    height: 19,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.success,
    borderWidth: 2,
    borderColor: c.canvas,
  },
  title: {
    color: c.textSecondary,
    fontSize: 15,
  },
  detail: {
    marginTop: 2,
    color: c.text,
    fontSize: 17,
  },
  swap: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  swapText: {
    color: c.text,
    fontSize: 17,
  },
  date: {
    color: c.textSecondary,
    fontSize: 15,
  },
  skeletonLabel: {
    height: 27,
    justifyContent: 'center',
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    paddingVertical: 10,
  },
  skeletonLines: {
    flex: 1,
    gap: 8,
    paddingTop: 2,
  },
}));
