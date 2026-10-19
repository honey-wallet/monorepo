// Must come first: WalletConnect's polyfills (a no-op in the browser).
import '@/lib/walletconnect-compat';
import * as Notifications from 'expo-notifications';
import { DarkTheme, DefaultTheme, router, Stack, type Theme, ThemeProvider } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AppGate } from '@/components/AppGate';
import { BackendSessionLifecycle } from '@/components/BackendSessionLifecycle';
import { LaunchAnimation } from '@/components/LaunchAnimation';
import { ToastHost } from '@/components/motion/ToastHost';
import { Tray } from '@/components/sheets/Tray';
import { appLock } from '@/lib/app-lock';
import { createMultisig, reject, startDemoRequests } from '@/lib/multisig';
import { ACTION_REJECT, setUpNotifications } from '@/lib/push';
import { showToast } from '@/lib/toast';
import { walletConnect } from '@/lib/walletconnect';
import { useTheme } from '@/theme';

/**
 * Tapping a notification about a proposal opens it; its Reject button rejects it
 * without opening Honey.
 */
const consumedResponses = new Set<string>();

function handleResponse(response: Notifications.NotificationResponse) {
  const id = response.notification.request.content.data?.proposalId;
  if (typeof id !== 'string' || !appLock.get().unlocked) return;
  const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
  if (consumedResponses.has(key)) return;
  consumedResponses.add(key);
  if (response.actionIdentifier === ACTION_REJECT) {
    const outcome = reject(id);
    showToast(outcome === 'rejected' ? 'Proposal rejected' : 'You rejected it');
    return;
  }
  router.push({ pathname: '/proposal/[id]', params: { id } });
}

function useNotificationResponses() {
  useEffect(() => {
    let mounted = true;
    setUpNotifications();
    startDemoRequests();
    // Opened from a notification while closed, or tapped while running.
    Notifications.getLastNotificationResponseAsync()
      .then((last) => mounted && last && handleResponse(last))
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
}

function NotificationResponses() {
  useNotificationResponses();
  return null;
}

/** Websites by WalletConnect (the phone only): reconnects saved sessions at launch. */
function WalletConnectSessions() {
  useEffect(() => {
    void walletConnect().catch((error) => console.warn('WalletConnect didn’t start', error));
  }, []);
  return null;
}

// Screenshot runs of the extension (EXPO_PUBLIC_E2E=1 builds only) open screens the way
// a tap would, over Home, instead of reloading the page at a deep link.
if (process.env.EXPO_PUBLIC_E2E === '1') {
  (globalThis as { __honeyRouter?: typeof router }).__honeyRouter = router;
  // And a shared wallet without the setup screens, for the website-approval runs.
  (globalThis as { __honeyCreateMultisig?: typeof createMultisig }).__honeyCreateMultisig =
    createMultisig;
}

/** Follows the system light/dark setting; navigation chrome uses the Honey palette. */
export default function RootLayout() {
  const c = useTheme();
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

  // Full-height sheets for amount entry: the amount gets room to breathe and the keypad
  // sits at the bottom; the review and result rise over it in a tray (`FlowTray`).
  const sheet = (detents: number[] | 'fitToContents') => ({
    presentation: 'formSheet' as const,
    sheetAllowedDetents: detents,
    sheetGrabberVisible: true,
    sheetCornerRadius: 28,
    contentStyle: { backgroundColor: c.sheet },
  });
  // Trays (Family-style): a card floating over the screen, one step at a time, its
  // height following the content. The `Tray` wrapper below draws and animates it.
  const tray = () => ({
    presentation: 'transparentModal' as const,
    animation: 'none' as const,
    gestureEnabled: false,
    contentStyle: { backgroundColor: 'transparent' },
  });

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={navigationTheme}>
        <AppGate>
          <NotificationResponses />
          <WalletConnectSessions />
          <BackendSessionLifecycle />
          <Stack
            screenOptions={{ headerShown: false }}
            screenLayout={({ options, navigation, route, children }) =>
              options.presentation === 'transparentModal' ? (
                <Tray navigation={navigation} routeKey={route.key}>
                  {children}
                </Tray>
              ) : (
                children
              )
            }
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="(onboarding)" />
            <Stack.Screen name="(wallet)" options={{ gestureEnabled: false }} />
            <Stack.Screen name="(settings)/settings" />
            <Stack.Screen name="(account)/wallet-sign-in" />
            <Stack.Screen name="(activity)/notifications" />
            <Stack.Screen name="(portfolio)/token/[symbol]" />
            <Stack.Screen name="(trade)/perp/[symbol]" />
            <Stack.Screen name="(trade)/predict/[id]" />
            <Stack.Screen name="(portfolio)/portfolio" />
            <Stack.Screen name="(shared)/multisig/[id]" />
            <Stack.Screen name="(money)/scan" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="(keys)/wallets" options={tray()} />
            <Stack.Screen name="(savings)/earn/[symbol]" options={tray()} />
            <Stack.Screen name="(savings)/savings-add" options={sheet([1])} />
            <Stack.Screen name="(money)/receive" options={tray()} />
            <Stack.Screen name="(money)/my-qr" options={tray()} />
            <Stack.Screen name="(money)/networks" options={tray()} />
            <Stack.Screen name="(money)/send" options={tray()} />
            <Stack.Screen name="(money)/buy" options={tray()} />
            <Stack.Screen name="(activity)/activity/[id]" options={tray()} />
            <Stack.Screen name="(trade)/swap-settings" options={tray()} />
            <Stack.Screen name="(trade)/trade-settings" options={tray()} />
            <Stack.Screen name="(money)/balance" options={tray()} />
            <Stack.Screen name="(portfolio)/share-portfolio" options={tray()} />
            <Stack.Screen name="(portfolio)/share-token" options={tray()} />
            <Stack.Screen name="(settings)/section-settings" options={tray()} />
            <Stack.Screen name="(trade)/trade-tabs" options={tray()} />
            <Stack.Screen name="(money)/token-picker" options={tray()} />
            <Stack.Screen name="(money)/network-picker" options={tray()} />
            <Stack.Screen name="(account)/step-help" options={tray()} />
            <Stack.Screen name="(trade)/perp-order" options={sheet([1])} />
            <Stack.Screen name="(trade)/predict-order" options={sheet([1])} />
            <Stack.Screen name="(trade)/predict-guide" options={tray()} />
            <Stack.Screen name="(trade)/perps-guide" options={tray()} />
            {/* Money flows */}
            <Stack.Screen name="(money)/send-amount" options={sheet([1])} />
            <Stack.Screen name="(money)/buy-cash" options={sheet([1])} />
            <Stack.Screen name="(keys)/add-wallet" options={tray()} />
            <Stack.Screen name="(keys)/burner-wallet" options={tray()} />
            <Stack.Screen name="(keys)/import-wallet" options={tray()} />
            <Stack.Screen name="(keys)/pair-extension" options={tray()} />
            <Stack.Screen name="(keys)/pair-phone" options={tray()} />
            {/* Honey for Chrome: websites' requests, in their own window */}
            <Stack.Screen name="(connect)/approve" />
            <Stack.Screen name="(connect)/wc" />
            <Stack.Screen name="(settings)/connected-sites" options={tray()} />
            <Stack.Screen name="(keys)/restore-backup" options={tray()} />
            <Stack.Screen name="(keys)/watch-wallet" options={tray()} />
            <Stack.Screen name="(keys)/hardware-wallet" options={tray()} />
            <Stack.Screen name="(savings)/jar-new" options={tray()} />
            <Stack.Screen name="(savings)/jar-move" options={sheet([1])} />
            {/* Shared wallets */}
            <Stack.Screen name="(shared)/multisig-new" options={tray()} />
            <Stack.Screen name="(shared)/proposal/[id]" options={tray()} />
            <Stack.Screen name="(shared)/multisig-edit" options={tray()} />
            {/* Settings pages (pushed) and pickers (sheets) */}
            <Stack.Screen name="(account)/profile-edit" options={tray()} />
            <Stack.Screen name="(account)/get-started" options={tray()} />
            <Stack.Screen name="(account)/setup" options={tray()} />
            <Stack.Screen name="(account)/sign-out" options={tray()} />
            <Stack.Screen name="(settings)/app-data" />
            <Stack.Screen name="(settings)/smart-wallet" />
            <Stack.Screen name="(keys)/recovery-phrase" />
            <Stack.Screen name="(keys)/icloud-backup" options={tray()} />
            <Stack.Screen name="(settings)/disclosures" />
            <Stack.Screen name="(settings)/help" />
            <Stack.Screen name="(settings)/settings-theme" options={tray()} />
            <Stack.Screen name="(settings)/settings-app-icon" options={sheet('fitToContents')} />
            <Stack.Screen name="(settings)/settings-currency" options={tray()} />
            <Stack.Screen name="(settings)/settings-language" options={tray()} />
            <Stack.Screen name="(settings)/settings-notifications" options={tray()} />
            <Stack.Screen name="(settings)/settings-balances" options={tray()} />
            <Stack.Screen name="(settings)/settings-advanced" options={tray()} />
            <Stack.Screen name="(settings)/settings-network-cost" options={tray()} />
            <Stack.Screen name="(settings)/settings-face-id" options={tray()} />
            <Stack.Screen name="(settings)/settings-permissions" options={tray()} />
            <Stack.Screen name="(settings)/settings-about" options={tray()} />
            <Stack.Screen name="(settings)/smart-wallet-info" options={tray()} />
            <Stack.Screen name="(settings)/contact" options={tray()} />
          </Stack>
          <ToastHost />
          {!launched && <LaunchAnimation onDone={endLaunch} />}
        </AppGate>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
