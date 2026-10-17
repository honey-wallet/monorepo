import { beforeEach, expect, it, vi } from 'vitest';

const load = vi.hoisted(() => vi.fn());
vi.mock('@/lib/vault', () => ({ loadAccounts: load }));
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ name: 'Owner' }) }));
vi.mock('@/lib/multisig', () => ({ useMultisig: () => null }));
vi.mock('@/lib/onboarding', () => ({ useOnboarding: () => ({ funded: true }) }));
vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import { useWalletView } from '@/lib/wallet-view';
import { allWallets, hydrateWallets, walletLoad, wallets } from '@/lib/wallets';

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
