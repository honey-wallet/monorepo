import { EmptyState, PushedScreen } from '@/components/wallet/parts';

export default function NotificationsScreen() {
  return (
    <PushedScreen title="Notifications">
      <EmptyState
        icon="bell"
        title="You're all caught up"
        hint="Incoming payments and security alerts will show up here."
      />
    </PushedScreen>
  );
}
