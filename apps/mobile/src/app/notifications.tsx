import { useEffect } from 'react';
import { EmptyState, PushedScreen } from '@/components/wallet/parts';
import { markNotificationsRead } from '@/lib/notifications';

export default function NotificationsScreen() {
  // Opening the screen clears Home's unread badge.
  useEffect(markNotificationsRead, []);
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
