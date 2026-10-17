import { beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  auth: vi.fn(),
  level: vi.fn(),
  state: 'active',
  listeners: new Set<(state: string) => void>(),
}));
vi.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0 },
  getEnrolledLevelAsync: api.level,
  authenticateAsync: api.auth,
}));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return api.state;
    },
    addEventListener: (_name: string, listener: (state: string) => void) => {
      api.listeners.add(listener);
      return { remove: () => api.listeners.delete(listener) };
    },
  },
}));
vi.mock('@/lib/settings', () => ({ updateSettings: vi.fn() }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => 'true' }));

import { appLock, appVisibility, loadAppLock, unlockApp } from '@/lib/app-lock';
import { confirmOwner, isAuthenticatingOwner } from '@/lib/auth';

function transition(state: string) {
  api.state = state;
  appVisibility(state);
  for (const listener of api.listeners) listener(state);
}
beforeEach(() => {
  vi.resetAllMocks();
  api.state = 'active';
  api.listeners.clear();
  appVisibility('active');
  api.level.mockResolvedValue(1);
  api.auth.mockResolvedValue({ success: true });
});
it('does not tear down protected routes for a recovery-phrase biometric prompt', async () => {
  await loadAppLock();
  await unlockApp();
  api.auth.mockImplementation(async () => {
    expect(isAuthenticatingOwner()).toBe(true);
    transition('inactive');
    expect(appLock.get().unlocked).toBe(true);
    transition('active');
    return { success: true };
  });
  expect(await confirmOwner('Show recovery phrase')).toBe(true);
  expect(isAuthenticatingOwner()).toBe(false);
});
it('invalidates authentication on a real background transition', async () => {
  await loadAppLock();
  await unlockApp();
  api.auth.mockImplementation(async () => {
    transition('background');
    transition('active');
    return { success: true };
  });
  expect(await confirmOwner('Export recovery phrase')).toBe(false);
  expect(appLock.get().unlocked).toBe(false);
});
it('does not enable app protection on a device with no lock', async () => {
  api.level.mockResolvedValue(0);
  expect(await confirmOwner('Enable protection', true)).toBe(false);
  expect(api.auth).not.toHaveBeenCalled();
});
