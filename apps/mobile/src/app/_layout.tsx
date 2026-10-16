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
    const outcome = reject(id);
    showToast(outcome === 'rejected' ? 'Proposal rejected' : 'You rejected it');
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
          <Stack.Screen name="(settings)/settings" />
          <Stack.Screen name="(activity)/notifications" />
          <Stack.Screen name="(portfolio)/token/[symbol]" />
          <Stack.Screen name="(trade)/perp/[symbol]" />
          <Stack.Screen name="(trade)/predict/[id]" />
          <Stack.Screen name="(portfolio)/portfolio" />
          <Stack.Screen name="(shared)/multisig/[id]" />
          <Stack.Screen name="(money)/scan" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="(keys)/wallets" options={sheet([0.75, 1])} />
          <Stack.Screen name="(savings)/earn/[symbol]" options={sheet('fitToContents')} />
          <Stack.Screen name="(savings)/savings-add" options={sheet([1])} />
          <Stack.Screen name="(money)/receive" options={sheet('fitToContents')} />
          <Stack.Screen name="(money)/my-qr" options={sheet('fitToContents')} />
          <Stack.Screen name="(money)/networks" options={sheet('fitToContents')} />
          <Stack.Screen name="(money)/send" options={sheet([1])} />
          <Stack.Screen name="(money)/buy" options={sheet('fitToContents')} />
          <Stack.Screen name="(activity)/activity/[id]" options={sheet('fitToContents')} />
          <Stack.Screen name="(trade)/swap-settings" options={sheet('fitToContents')} />
          <Stack.Screen name="(trade)/trade-settings" options={sheet('fitToContents')} />
          <Stack.Screen name="(money)/balance" options={sheet('fitToContents')} />
          <Stack.Screen name="(portfolio)/share-portfolio" options={sheet('fitToContents')} />
          <Stack.Screen name="(portfolio)/share-token" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/section-settings" options={sheet('fitToContents')} />
          <Stack.Screen name="(trade)/trade-tabs" options={sheet('fitToContents')} />
          <Stack.Screen name="(money)/token-picker" options={sheet([0.9])} />
          <Stack.Screen name="(money)/network-picker" options={sheet([0.8])} />
          <Stack.Screen name="(account)/step-help" options={sheet('fitToContents')} />
          <Stack.Screen name="(trade)/perp-order" options={sheet([1])} />
          <Stack.Screen name="(trade)/predict-order" options={sheet([1])} />
          <Stack.Screen name="(trade)/predict-guide" options={sheet('fitToContents')} />
          <Stack.Screen name="(trade)/perps-guide" options={sheet('fitToContents')} />
          {/* Money flows */}
          <Stack.Screen name="(money)/send-amount" options={sheet([1])} />
          <Stack.Screen name="(money)/buy-cash" options={sheet([1])} />
          <Stack.Screen name="(keys)/add-wallet" options={sheet('fitToContents')} />
          <Stack.Screen name="(keys)/burner-wallet" options={sheet('fitToContents')} />
          <Stack.Screen name="(keys)/import-wallet" options={sheet([1])} />
          <Stack.Screen name="(keys)/pair-extension" options={sheet([1])} />
          <Stack.Screen name="(keys)/restore-backup" options={sheet('fitToContents')} />
          <Stack.Screen name="(keys)/watch-wallet" options={sheet([1])} />
          <Stack.Screen name="(keys)/hardware-wallet" options={sheet('fitToContents')} />
          <Stack.Screen name="(savings)/jar-new" options={sheet([1])} />
          <Stack.Screen name="(savings)/jar-move" options={sheet([1])} />
          {/* Shared wallets */}
          <Stack.Screen name="(shared)/multisig-new" options={sheet([1])} />
          <Stack.Screen name="(shared)/proposal/[id]" options={sheet('fitToContents')} />
          <Stack.Screen name="(shared)/multisig-edit" options={sheet('fitToContents')} />
          {/* Settings pages (pushed) and pickers (sheets) */}
          <Stack.Screen name="(account)/profile-edit" options={sheet('fitToContents')} />
          <Stack.Screen name="(account)/get-started" options={sheet('fitToContents')} />
          <Stack.Screen name="(account)/setup" options={sheet('fitToContents')} />
          <Stack.Screen name="(account)/sign-out" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/app-data" />
          <Stack.Screen name="(settings)/smart-wallet" />
          <Stack.Screen name="(keys)/recovery-phrase" />
          <Stack.Screen name="(keys)/icloud-backup" />
          <Stack.Screen name="(settings)/disclosures" />
          <Stack.Screen name="(settings)/help" />
          <Stack.Screen name="(settings)/settings-theme" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/settings-currency" options={sheet([0.8, 1])} />
          <Stack.Screen name="(settings)/settings-language" options={sheet([0.8, 1])} />
          <Stack.Screen name="(settings)/settings-notifications" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/settings-balances" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/settings-advanced" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/settings-network-cost" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/settings-face-id" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/settings-permissions" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/settings-about" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/smart-wallet-info" options={sheet('fitToContents')} />
          <Stack.Screen name="(settings)/contact" options={sheet('fitToContents')} />
        </Stack>
        <ToastHost />
        {!launched && <LaunchAnimation onDone={endLaunch} />}
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
