import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accounts: [] as { id: string }[],
  createAccount: vi.fn(),
  addVaultWallet: vi.fn(),
  finishOnboarding: vi.fn(),
}));

vi.mock('@/lib/vault', () => ({
  loadAccounts: async () => mocks.accounts,
  createAccount: mocks.createAccount,
}));
vi.mock('@/lib/wallets', () => ({ addVaultWallet: mocks.addVaultWallet }));
vi.mock('@/lib/profile', () => ({ getProfile: () => ({ name: 'Honey' }) }));
vi.mock('@/lib/onboarding', () => ({
  finishOnboarding: mocks.finishOnboarding,
  nameFromEmail: (email: string) => `from:${email}`,
}));

import { isAuthCallback } from '@/lib/auth-callback';
import { IDENTITY_ENABLED } from '@/lib/identity';
import { continueAfterSignIn } from '@/lib/identity-onboarding';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.accounts = [];
  mocks.createAccount.mockImplementation(async (label: string) => ({ id: 'seed-0', label }));
});

describe('after Apple / Google / email sign-in', () => {
  it('creates the wallet on this device; the account only supplies a name', async () => {
    const next = await continueAfterSignIn('google', {
      restore: false,
      identity: { email: 'maya@example.com', name: 'Maya' },
    });
    expect(next).toBe('opened');
    expect(mocks.createAccount).toHaveBeenCalledWith('Maya');
    expect(mocks.addVaultWallet).toHaveBeenCalledWith({ id: 'seed-0', label: 'Maya' });
    expect(mocks.finishOnboarding).toHaveBeenCalledWith('google', {
      restored: false,
      name: 'Maya',
    });
  });

  it('never pretends to restore: with no keys here it asks for them and opens nothing', async () => {
    const next = await continueAfterSignIn('apple', { restore: true, identity: {} });
    expect(next).toBe('needs-keys');
    expect(mocks.createAccount).not.toHaveBeenCalled();
    expect(mocks.finishOnboarding).not.toHaveBeenCalled();
  });

  it('opens wallets already on this device without making another', async () => {
    mocks.accounts = [{ id: 'existing' }];
    const next = await continueAfterSignIn('email', {
      restore: true,
      identity: { email: 'maya@example.com' },
    });
    expect(next).toBe('opened');
    expect(mocks.createAccount).not.toHaveBeenCalled();
    expect(mocks.finishOnboarding).toHaveBeenCalledWith('email', {
      restored: true,
      name: 'from:maya@example.com',
    });
  });
});

it('is off without a publishable key', () => {
  expect(process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '').toBe('');
  expect(IDENTITY_ENABLED).toBe(false);
});

it('recognises only the sign-in redirect as the auth callback', () => {
  expect(isAuthCallback('honeywallet://sso-callback?rotating_token_nonce=x')).toBe(true);
  expect(isAuthCallback('/sso-callback')).toBe(true);
  expect(isAuthCallback('honeywallet:///sso-callback')).toBe(true);
  expect(isAuthCallback('/home')).toBe(false);
  expect(isAuthCallback('honeywallet://wc?uri=sso-callback-ish')).toBe(false);
});
