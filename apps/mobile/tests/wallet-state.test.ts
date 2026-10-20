import { beforeEach, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
vi.mock('@/lib/vault', () => ({
  loadAccounts: load,
  createAccount: vi.fn(),
  upgradeNearAccounts: vi.fn(),
}));
vi.mock('@/lib/profile', () => ({
  useProfile: () => ({ name: 'Owner' }),
  getProfile: () => ({ name: 'Owner' }),
}));
vi.mock('@/lib/multisig', () => ({ useMultisig: () => null }));
vi.mock('@/lib/onboarding', () => ({ useOnboarding: () => ({ funded: true }) }));
vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import { useWalletView } from '@/lib/wallet-view';
import {
  allWallets,
  hydrateWallets,
  isFixtureWallet,
  isMainWallet,
  needsTestWallet,
  walletLoad,
  wallets,
} from '@/lib/wallets';

const account = {
  id: 'seed-0',
  label: 'Saved wallet',
  source: { kind: 'phrase', seedId: 'seed', index: 0 },
  addresses: { evm: '0x1234' },
};
beforeEach(() => {
  wallets.set({ activeId: 'main', added: [] });
  walletLoad.set({ ready: false, error: false });
  load.mockReset().mockResolvedValue([account]);
});
it('selects a stored account before showing receive addresses after restart', async () => {
  await hydrateWallets();
  expect(wallets.get().activeId).toBe(account.id);
  expect(allWallets('Owner', wallets.get().added).map((w) => w.address)).toEqual(['0x1234']);
  expect(walletLoad.get().ready).toBe(true);
});
it('does not substitute demo money for a newly created or imported account', async () => {
  await hydrateWallets();
  expect(useWalletView()).toMatchObject({ usd: 0, tokens: [], empty: true });
});
it('does not expose a fallback wallet when secure storage fails', async () => {
  load.mockRejectedValue(new Error('unavailable'));
  await hydrateWallets();
  expect(walletLoad.get()).toEqual({ ready: false, error: true });
});
it('marks all fixture wallets as demo when no account exists', () => {
  expect(allWallets('Owner', []).every((wallet) => wallet.demo)).toBe(true);
});

it('test mode gives real wallets fake money without hiding their keys', () => {
  const own = {
    id: 'seed-0',
    kind: 'wallet' as const,
    label: 'Mine',
    address: '0x1234',
    usd: 0,
    addresses: { evm: '0x1234' },
  };
  const watched = {
    id: 'w',
    kind: 'wallet' as const,
    label: 'Watched',
    address: '0x9',
    usd: 0,
    watchOnly: true,
  };
  expect(allWallets('Owner', [own, watched], false)).toEqual([own, watched]);
  const test = allWallets('Owner', [own, watched], true);
  expect(test[0]).toMatchObject({ id: 'seed-0', demo: true, addresses: { evm: '0x1234' } });
  expect(isFixtureWallet(test[0])).toBe(false);
  expect(test[1].demo).toBeUndefined();
  expect(test.some((w) => w.kind === 'multisig' && isFixtureWallet(w))).toBe(true);
});

it('creates a wallet at launch only in test mode with an empty vault', () => {
  expect(needsTestWallet([], true)).toBe(true);
  expect(needsTestWallet([], false)).toBe(false);
  expect(needsTestWallet([account as never], true)).toBe(false);
});

it('treats the first keyed wallet as main, or the sample wallet when none has keys', () => {
  const own = {
    id: 'seed-0',
    kind: 'wallet' as const,
    label: 'A',
    address: '0x1',
    usd: 0,
    addresses: { evm: '0x1' },
  };
  const other = { ...own, id: 'seed-1' };
  expect(isMainWallet(own, [own, other])).toBe(true);
  expect(isMainWallet(other, [own, other])).toBe(false);
  expect(isMainWallet(allWallets('Owner', [])[0], [])).toBe(true);
});
