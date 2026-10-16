import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * System notifications. For now they're local (scheduled on this device by the demo);
 * a push service will send the same ones once shared wallets live on the server.
 */

/** The actions on an approval request, right on the notification. */
export const APPROVAL_CATEGORY = 'approval';
export const ACTION_REVIEW = 'review';
export const ACTION_REJECT = 'reject';

let ready: Promise<void> | null = null;

/** Shows notifications as banners even while Honey is open, and adds the approval buttons. */
export function setUpNotifications() {
  if (ready) return ready;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  ready = Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY, [
    // Approving moves money, so it opens Honey to confirm there; rejecting is safe
    // to do from the banner.
    { identifier: ACTION_REVIEW, buttonTitle: 'Review', options: { opensAppToForeground: true } },
    {
      identifier: ACTION_REJECT,
      buttonTitle: 'Reject',
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ])
    .then(() => undefined)
    .catch(() => undefined);
  return ready;
}

/** Whether notifications are allowed, without asking. */
export async function notificationsAllowed() {
  const { granted } = await Notifications.getPermissionsAsync();
  return granted;
}

/** Asks for permission (iOS shows its prompt once); true if allowed. */
export async function askForNotifications() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const next = await Notifications.requestPermissionsAsync();
  return next.granted;
}

/**
 * Shows a notification now, if allowed. Returns false when it couldn't (no
 * permission, or web), so the caller can fall back to an in-app toast.
 */
export async function notify(content: {
  title: string;
  body: string;
  /** Opens this proposal when tapped. */
  proposalId?: string;
  /** Adds Review / Reject buttons. */
  approval?: boolean;
}) {
  if (Platform.OS === 'web') return false;
  try {
    await setUpNotifications();
    if (!(await notificationsAllowed())) return false;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: content.title,
        body: content.body,
        data: content.proposalId ? { proposalId: content.proposalId } : {},
        categoryIdentifier: content.approval ? APPROVAL_CATEGORY : undefined,
      },
      trigger: null,
    });
    return true;
  } catch {
    return false;
  }
}
