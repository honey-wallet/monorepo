import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/push', () => ({ notify: async () => true }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/profile', () => ({ getProfile: () => ({ name: 'Owner' }) }));
vi.mock('@/lib/wallets', () => ({
  allWallets: () => [],
  wallets: { get: () => ({ added: [] }) },
  demoAddress: () => '0x0',
  useActiveWallet: vi.fn(),
  addWallet: vi.fn(),
}));

import { jars } from '@/lib/jars';
import { approve, cancel, propose } from '@/lib/multisig';

afterEach(() => vi.useRealTimers());
it('applies delayed approval to the original jar exactly once, even after rename', async () => {
  vi.useFakeTimers();
  jars.set([
    { id: 'original', name: 'Trip', symbol: 'USDC', goal: 100, saved: 0 },
    { id: 'other', name: 'Trip', symbol: 'USDC', goal: 100, saved: 0 },
  ]);
  const { proposal, executed } = propose('family', {
    type: 'jarAdd',
    jarId: 'original',
    jar: 'Trip',
    symbol: 'USDC',
    amount: 10,
    usd: 10,
  });
  expect(executed).toBe(false);
  expect(jars.get()[0].saved).toBe(0);
  jars.set((list) =>
    list.map((jar) => (jar.id === 'original' ? { ...jar, name: 'Renamed' } : jar)),
  );
  await vi.advanceTimersByTimeAsync(4000);
  expect(jars.get().map((jar) => jar.saved)).toEqual([10, 0]);
  approve(proposal.id);
  expect(jars.get()[0].saved).toBe(10);
});
it('does not move a cancelled proposal', async () => {
  vi.useFakeTimers();
  jars.set([{ id: 'original', name: 'Trip', symbol: 'USDC', goal: 100, saved: 20 }]);
  const { proposal } = propose('family', {
    type: 'jarWithdraw',
    jarId: 'original',
    jar: 'Trip',
    symbol: 'USDC',
    amount: 10,
    usd: 10,
  });
  cancel(proposal.id);
  await vi.advanceTimersByTimeAsync(4000);
  expect(jars.get()[0].saved).toBe(20);
});
