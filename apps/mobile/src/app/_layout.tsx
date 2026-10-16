import * as Notifications from 'expo-notifications';
import { DarkTheme, DefaultTheme, router, Stack, type Theme, ThemeProvider } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { LaunchAnimation } from '@/components/LaunchAnimation';
import { ToastHost } from '@/components/motion/ToastHost';
import { reject, startDemoRequests } from '@/lib/multisig';
import { ACTION_REJECT, setUpNotifications } from '@/lib/push';
import { showToast } from '@/lib/toast';
import { useTheme } from '@/theme';

/**
 * Tapping a notification about a proposal opens it; its Reject button rejects it
 * without opening Honey.
 */
function handleResponse(response: Notifications.NotificationResponse) {
  const id = response.notification.request.content.data?.proposalId;
  if (typeof id !== 'string') return;
  if (response.actionIdentifier === ACTION_REJECT) {
    reject(id);
    showToast('Proposal rejected');
    return;
  }
  router.push({ pathname: '/proposal/[id]', params: { id } });
}

function useNotificationResponses() {
  useEffect(() => {
    setUpNotifications();
    startDemoRequests();
    // Opened from a notification while closed, or tapped while running.
    Notifications.getLastNotificationResponseAsync()
      .then((last) => last && handleResponse(last))
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);
    return () => sub.remove();
  }, []);
}

/** Follows the system light/dark setting; navigation chrome uses the Honey palette. */
export default function RootLayout() {
  const c = useTheme();
  useNotificationResponses();
  // The opening animation plays once per cold start, over whichever screen opens first.
  const [launched, setLaunched] = useState(false);
  const endLaunch = useCallback(() => setLaunched(true), []);
  const navigationTheme = useMemo<Theme>(() => {
    const base = c.scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: c.primary,
        background: c.canvas,
        card: c.canvas,
        text: c.text,
        border: c.divider,
      },
    };
  }, [c]);

  // Native bottom sheets: fit their content, or open tall for lists.
  const sheet = (detents: number[] | 'fitToContents') => ({
    presentation: 'formSheet' as const,
    sheetAllowedDetents: detents,
    sheetGrabberVisible: true,
    sheetCornerRadius: 28,
    contentStyle: { backgroundColor: c.sheet },
  });

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={navigationTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(onboarding)" />
          <Stack.Screen name="(wallet)" options={{ gestureEnabled: false }} />
          <Stack.Screen name="settings" />
          <Stack.Screen name="notifications" />
          <Stack.Screen name="token/[symbol]" />
          <Stack.Screen name="perp/[symbol]" />
          <Stack.Screen name="portfolio" />
          <Stack.Screen name="multisig/[id]" />
          <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="wallets" options={sheet([0.75, 1])} />
          <Stack.Screen name="earn/[symbol]" options={sheet('fitToContents')} />
          <Stack.Screen name="receive" options={sheet('fitToContents')} />
          <Stack.Screen name="my-qr" options={sheet('fitToContents')} />
          <Stack.Screen name="networks" options={sheet('fitToContents')} />
          <Stack.Screen name="send" options={sheet([1])} />
          <Stack.Screen name="buy" options={sheet('fitToContents')} />
          <Stack.Screen name="activity/[id]" options={sheet('fitToContents')} />
          <Stack.Screen name="swap-settings" options={sheet('fitToContents')} />
          <Stack.Screen name="trade-settings" options={sheet('fitToContents')} />
          <Stack.Screen name="balance" options={sheet('fitToContents')} />
          <Stack.Screen name="share-portfolio" options={sheet('fitToContents')} />
          <Stack.Screen name="section-settings" options={sheet('fitToContents')} />
          <Stack.Screen name="trade-tabs" options={sheet('fitToContents')} />
          <Stack.Screen name="token-picker" options={sheet([0.9])} />
          <Stack.Screen name="network-picker" options={sheet([0.8])} />
          <Stack.Screen name="step-help" options={sheet('fitToContents')} />
          <Stack.Screen name="perp-order" options={sheet([1])} />
          <Stack.Screen name="predict-order" options={sheet([1])} />
          <Stack.Screen name="predict-guide" options={sheet('fitToContents')} />
          <Stack.Screen name="perps-guide" options={sheet('fitToContents')} />
          {/* Money flows */}
          <Stack.Screen name="send-amount" options={sheet([1])} />
          <Stack.Screen name="buy-cash" options={sheet([1])} />
          <Stack.Screen name="add-wallet" options={sheet('fitToContents')} />
          <Stack.Screen name="burner-wallet" options={sheet('fitToContents')} />
          <Stack.Screen name="import-wallet" options={sheet([1])} />
          <Stack.Screen name="watch-wallet" options={sheet([1])} />
          <Stack.Screen name="hardware-wallet" options={sheet('fitToContents')} />
          <Stack.Screen name="jar-new" options={sheet([1])} />
          <Stack.Screen name="jar-move" options={sheet([1])} />
          {/* Shared wallets */}
          <Stack.Screen name="multisig-new" options={sheet([1])} />
          <Stack.Screen name="proposal/[id]" options={sheet([1])} />
          <Stack.Screen name="multisig-edit" options={sheet('fitToContents')} />
          {/* Settings pages (pushed) and pickers (sheets) */}
          <Stack.Screen name="profile-edit" options={sheet([1])} />
          <Stack.Screen name="app-data" />
          <Stack.Screen name="smart-wallet" />
          <Stack.Screen name="recovery-phrase" />
          <Stack.Screen name="icloud-backup" />
          <Stack.Screen name="disclosures" />
          <Stack.Screen name="help" />
          <Stack.Screen name="settings-theme" options={sheet('fitToContents')} />
          <Stack.Screen name="settings-currency" options={sheet([0.8, 1])} />
          <Stack.Screen name="settings-language" options={sheet([0.8, 1])} />
          <Stack.Screen name="settings-notifications" options={sheet('fitToContents')} />
          <Stack.Screen name="settings-balances" options={sheet('fitToContents')} />
          <Stack.Screen name="settings-advanced" options={sheet('fitToContents')} />
          <Stack.Screen name="settings-network-cost" options={sheet('fitToContents')} />
          <Stack.Screen name="settings-face-id" options={sheet('fitToContents')} />
          <Stack.Screen name="settings-permissions" options={sheet('fitToContents')} />
          <Stack.Screen name="settings-about" options={sheet('fitToContents')} />
          <Stack.Screen name="smart-wallet-info" options={sheet('fitToContents')} />
          <Stack.Screen name="contact" options={sheet('fitToContents')} />
        </Stack>
        <ToastHost />
        {!launched && <LaunchAnimation onDone={endLaunch} />}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
