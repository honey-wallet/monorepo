import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  disconnectSession: vi.fn(async () => {}),
  on: vi.fn(),
}));
vi.mock('@honey-wallet/keyring', () => ({ EVM_NETWORKS: [], readSolanaTransaction: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => fixture.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      fixture.storage.set(key, value);
    },
  },
}));
vi.mock('@reown/walletkit', () => ({
  WalletKit: {
    init: async () => ({
      disconnectSession: fixture.disconnectSession,
      on: fixture.on,
    }),
  },
}));
vi.mock('@walletconnect/core', () => ({ Core: class {} }));
vi.mock('@walletconnect/utils', () => ({
  buildApprovedNamespaces: vi.fn(),
  getSdkError: (code: string) => ({ code }),
}));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn() }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/wallets', () => ({
  wallets: {
    get: () => ({
      added: [
        { id: 'real', kind: 'wallet', addresses: { evm: '0x1111' } },
        { id: 'old', kind: 'multisig', address: '0x2222' },
      ],
    }),
  },
}));
afterEach(() => vi.unstubAllEnvs());

it('disconnects restored simulated shared sessions and retains real keyed sessions', async () => {
  vi.stubEnv('EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID', 'offline-test-project');
  fixture.storage.set(
    'honey.wc.topics',
    JSON.stringify({
      good: { key: 'good-origin', caller: {} },
      bad: { key: 'bad-origin', caller: {} },
    }),
  );
  const site = { walletName: 'Wallet', solana: null, chainId: 1, connectedAt: 1 };
  fixture.storage.set(
    'honey.wc.honey.sites',
    JSON.stringify({
      'good-origin': { ...site, origin: 'good-origin', walletId: 'real', evm: '0x1111' },
      'bad-origin': { ...site, origin: 'bad-origin', walletId: 'old', evm: '0x2222' },
    }),
  );
  const { walletConnect, wcRouter } = await import('@/lib/walletconnect');
  await walletConnect();
  expect(fixture.disconnectSession).toHaveBeenCalledExactlyOnceWith({
    topic: 'bad',
    reason: { code: 'USER_DISCONNECTED' },
  });
  expect((await wcRouter.sites()).map((s) => s.walletId)).toEqual(['real']);
  expect(Object.keys(JSON.parse(fixture.storage.get('honey.wc.topics') ?? '{}'))).toEqual(['good']);
});
