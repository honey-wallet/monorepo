import { type ReactNode, useEffect } from 'react';
import { AppState, Text, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { appLock, appVisibility, loadAppLock, unlockApp } from '@/lib/app-lock';
import { hydrateWallets, walletLoad } from '@/lib/wallets';
import { useTheme } from '@/theme';

/** Do not mount routes (including deep links) until protection and accounts are ready. */
export function AppGate({ children }: { children: ReactNode }) {
  const lock = appLock.useValue();
  const accounts = walletLoad.useValue();
  const c = useTheme();
  useEffect(() => {
    appVisibility(AppState.currentState);
    void loadAppLock();
    const sub = AppState.addEventListener('change', appVisibility);
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (lock.loaded && lock.unlocked && !accounts.ready) void hydrateWallets();
  }, [lock.loaded, lock.unlocked, accounts.ready]);
  if (lock.loaded && lock.unlocked && accounts.ready) return children;
  const retry = lock.error || accounts.error;
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.canvas,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: 32,
      }}
    >
      <Text style={{ color: c.text, fontSize: 24 }}>Honey</Text>
      <Text style={{ color: c.textSecondary }}>
        {retry
          ? 'Couldn’t load your wallet. Try again.'
          : lock.loaded && !lock.unlocked
            ? 'Unlock to open your wallet'
            : 'Loading your wallet…'}
      </Text>
      {(retry || (lock.loaded && !lock.unlocked)) && (
        <PillButton
          label={lock.busy ? 'Unlocking…' : retry ? 'Try again' : 'Unlock'}
          disabled={lock.busy}
          onPress={() => {
            if (!lock.loaded) void loadAppLock();
            else if (!lock.unlocked) void unlockApp();
            else void hydrateWallets();
          }}
        />
      )}
    </View>
  );
}
