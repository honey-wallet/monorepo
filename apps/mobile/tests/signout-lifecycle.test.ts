import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  router: { dismissAll: vi.fn(), replace: vi.fn() },
  wallets: { set: vi.fn() },
  profile: vi.fn(),
  erase: vi.fn(),
  forgetBackend: vi.fn(),
}));

vi.mock('expo-router', () => ({ router: mocks.router }));
vi.mock('@/components/Avatar', () => ({ randomAvatarSeed: () => 'seed' }));
vi.mock('@/lib/dapp', () => ({
  forgetSites: async () => {
    mocks.events.push('sites');
  },
}));
vi.mock('@/lib/platform', () => ({ isWeb: false }));
vi.mock('@/lib/profile', () => ({ setProfile: mocks.profile }));
vi.mock('@/lib/store', () => ({ createStore: () => ({ set: vi.fn(), get: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/vault', () => ({ eraseVault: mocks.erase }));
vi.mock('@/lib/wallets', () => ({ wallets: mocks.wallets }));
vi.mock('@/lib/backend-session', () => ({ forgetSavedBackendSession: mocks.forgetBackend }));

import { signOut } from '@/lib/onboarding';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.events.length = 0;
  mocks.forgetBackend.mockImplementation(async () => {
    mocks.events.push('backend');
  });
  mocks.erase.mockImplementation(async () => {
    mocks.events.push('vault');
  });
});

it('forgets backend authorization before erasing the wallet, even with the main wallet active', async () => {
  await signOut(['main']);
  expect(mocks.events.slice(0, 3)).toEqual(['backend', 'vault', 'sites']);
  expect(mocks.forgetBackend).toHaveBeenCalledTimes(1);
  expect(mocks.erase).toHaveBeenCalledWith(['main']);
});
