import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { Sticky } from '@/components/motion/Sticky';
import { HeaderActions } from '@/components/wallet/HeaderActions';
import { ProposalRow } from '@/components/wallet/MultisigParts';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { TabScreen } from '@/components/wallet/TabScreen';
import { tap } from '@/lib/haptics';
import { ACTIVITY, type Activity } from '@/lib/mock-wallet';
import { useActiveMultisig, useProposals } from '@/lib/multisig';
import { type ActivityFilter, useSectionPrefs } from '@/lib/section-prefs';
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
  const shown = ACTIVITY.filter(
    (a) =>
      (activityFilter === 'All' || a.kind === FILTER_KIND[activityFilter]) &&
      !(activityHideApprovals && a.kind === 'approved'),
  );
  const months = [...new Set(shown.map((a) => a.month))];
  // A shared wallet's proposals still collecting approvals come first.
  const multisig = useActiveMultisig();
  const { pending, history } = useProposals(multisig?.walletId ?? '');
  const openProposal = (id: string) => {
    tap();
    router.push({ pathname: '/proposal/[id]', params: { id } });
  };

  return (
    <TabScreen
      title="Activity"
      right={
        <HeaderActions
          settingsLabel="Activity settings"
          onSettings={() =>
            router.push({ pathname: '/section-settings', params: { section: 'activity' } })
          }
        />
      }
    >
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
              title="No activity yet"
              hint="Payments and changes on this shared wallet show up here."
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
        <EmptyState
          icon="history"
          title="Nothing to show"
          hint="Change what Activity shows from its settings."
        />
      )}
    </TabScreen>
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
  flex: {
    flex: 1,
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
    fontSize: 16,
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
}));
