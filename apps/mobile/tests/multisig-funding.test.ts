import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react', () => ({
  useSyncExternalStore: (_: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock('@/lib/dapp', () => ({ publishWaiting: vi.fn() }));
vi.mock('@/lib/jars', () => ({ moveJar: vi.fn() }));
vi.mock('@/lib/push', () => ({ notify: vi.fn() }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/vault', () => ({
  createAccount: vi.fn(),
  loadAccounts: vi.fn(),
  upgradeNearAccounts: vi.fn(),
}));
vi.mock('@/lib/profile', () => ({
  getProfile: () => ({ name: 'Owner' }),
  useProfile: () => ({ name: 'Owner' }),
}));

const input = (solana: boolean) => ({
  name: 'Shared',
  purpose: 'family' as const,
  network: {
    name: solana ? 'Solana' : 'Base',
    chainId: solana ? null : 8453,
    native: solana ? 'SOL' : 'ETH',
  },
  members: [{ id: 'you', name: 'You', kind: 'you' as const, address: '0x1234' }],
  threshold: 1,
});
afterEach(() => vi.unstubAllEnvs());

it('rejects shared-wallet creation outside test mode without saving any wallet', async () => {
  vi.stubEnv('EXPO_PUBLIC_TEST_MODE', '0');
  vi.resetModules();
  const { createMultisig } = await import('@/lib/multisig');
  const { wallets } = await import('@/lib/wallets');
  for (const solana of [false, true])
    expect(() => createMultisig(input(solana))).toThrow('Not available');
  expect(wallets.get().added).toEqual([]);
});

it('keeps EVM and Solana shared previews unfundable even with demo labels hidden', async () => {
  vi.stubEnv('EXPO_PUBLIC_TEST_MODE', '1');
  vi.stubEnv('EXPO_PUBLIC_SHOW_DEMO_LABELS', '0');
  vi.resetModules();
  const { createMultisig, useMultisigDeployments: deployments } = await import('@/lib/multisig');
  const { wallets } = await import('@/lib/wallets');
  const { receiveAddresses } = await import('@/lib/receive');
  for (const solana of [false, true]) {
    const id = createMultisig(input(solana));
    const wallet = wallets.get().added.find((w) => w.id === id);
    if (!wallet) throw new Error('Preview wallet missing');
    expect(wallet.demo).toBe(true);
    expect(receiveAddresses(wallet)).toEqual([]);
    expect(deployments(id)).toEqual([]);
  }
});
