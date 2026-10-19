import { useEffect } from 'react';
import { AppState } from 'react-native';
import { appLock } from '@/lib/app-lock';
import {
  backendVisibility,
  backendWalletChanged,
  clearBackendSession,
  refreshResumeAvailability,
  suspendBackendSession,
} from '@/lib/backend-session';
import { wallets } from '@/lib/wallets';

export function BackendSessionLifecycle() {
  useEffect(() => {
    backendVisibility(AppState.currentState);
    void refreshResumeAvailability();
    let activeId = wallets.get().activeId;
    const removeWallet = wallets.subscribe(() => {
      if (activeId !== wallets.get().activeId) {
        activeId = wallets.get().activeId;
        backendWalletChanged();
      }
    });
    const removeLock = appLock.subscribe(() => {
      if (appLock.get().enabled && !appLock.get().unlocked) suspendBackendSession();
      else if (appLock.get().unlocked) void refreshResumeAvailability();
    });
    const visibility = AppState.addEventListener('change', backendVisibility);
    return () => {
      removeWallet();
      removeLock();
      visibility.remove();
      clearBackendSession();
    };
  }, []);
  return null;
}
