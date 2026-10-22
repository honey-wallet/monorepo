import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('expo-router', () => ({ router: { dismissAll: vi.fn(), replace: vi.fn() } }));
vi.mock('@/components/Avatar', () => ({ randomAvatarSeed: () => 'seed' }));
vi.mock('@/lib/backend-session', () => ({ forgetSavedBackendSession: vi.fn() }));
vi.mock('@/lib/dapp', () => ({ forgetSites: vi.fn() }));
vi.mock('@/lib/platform', () => ({ isWeb: false }));
vi.mock('@/lib/profile', () => ({ setProfile: vi.fn() }));
vi.mock('@/lib/store', () => ({
  createStore: (initial: unknown) => {
    let value = initial as Record<string, unknown>;
    return {
      get: () => value,
      set: (next: unknown) => {
        value = (typeof next === 'function' ? next(value) : next) as Record<string, unknown>;
      },
      useValue: () => value,
    };
  },
}));
vi.mock('@/lib/toast', () => ({ showToast: state.toast }));
vi.mock('@/lib/vault', () => ({ eraseVault: vi.fn() }));
vi.mock('@/lib/wallets', () => ({ wallets: { set: vi.fn() } }));

import { finishOnboarding, markDemoFunded, setupSteps, useOnboarding } from '@/lib/onboarding';

beforeEach(() => {
  state.toast.mockClear();
});

it('marks only the demo onboarding view as funded and never claims money arrived', () => {
  finishOnboarding('email');
  expect(useOnboarding().funded).toBe(false);

  markDemoFunded();

  expect(useOnboarding().funded).toBe(true);
  expect(state.toast).toHaveBeenCalledWith('Balance updated');
  expect(state.toast).not.toHaveBeenCalledWith(expect.stringMatching(/arrived/i));
});

it('keeps the backup step for Apple / Google / email wallets: their phrase lives on this device', () => {
  for (const method of ['apple', 'google', 'email', 'phrase'] as const) {
    const steps = setupSteps(method).map((s) => s.id);
    expect(steps).toContain('backup');
    expect(steps).toContain('browser');
    expect(steps).not.toContain('phone');
  }
});
