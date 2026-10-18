import { createStore } from '@/lib/store';

/**
 * Whether there are notifications you haven't seen. Demo state: starts unread so
 * Home's bell shows its badge, and clears once the Notifications screen opens.
 */
const unread = createStore(true, { persist: 'notifications.unread' });

export const useUnreadNotifications = unread.useValue;

export function markNotificationsRead() {
  unread.set(false);
}
