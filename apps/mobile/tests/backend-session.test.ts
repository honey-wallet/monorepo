import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configuration: vi.fn(),
  challenge: vi.fn(),
  linkChallenge: vi.fn(),
  linkWallet: vi.fn(),
  wallets: vi.fn(),
  verify: vi.fn(),
  profile: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
  confirm: vi.fn(),
  accounts: vi.fn(),
  key: vi.fn(),
  sign: vi.fn(),
  address: vi.fn(),
  active: 'real',
  storedRefresh: null as string | null,
}));
vi.mock('@/lib/api', () => ({
  api: {
    authConfiguration: mocks.configuration,
    createSignInChallenge: mocks.challenge,
    createWalletLinkChallenge: mocks.linkChallenge,
    linkWallet: mocks.linkWallet,
    wallets: mocks.wallets,
    verifySignIn: mocks.verify,
    profile: mocks.profile,
    refreshSession: mocks.refresh,
    signOut: mocks.signOut,
  },
}));
vi.mock('@/lib/secure-store', () => ({
  getItemAsync: async () => mocks.storedRefresh,
  setItemAsync: async (_key: string, value: string) => {
    mocks.storedRefresh = value;
  },
  deleteItemAsync: async () => {
    mocks.storedRefresh = null;
  },
}));
vi.mock('@/lib/auth', () => ({ confirmOwner: mocks.confirm }));
vi.mock('@/lib/vault', () => ({ loadAccounts: mocks.accounts, privateKeyOf: mocks.key }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ activeId: mocks.active }) } }));
vi.mock('@honey-wallet/keyring', () => ({
  evmAddressOfKey: mocks.address,
  signEvmMessage: mocks.sign,
}));

import {
  approveBackendSignIn,
  approveWalletLink,
  backendSession,
  backendSessionToken,
  backendVisibility,
  backendWalletChanged,
  clearBackendSession,
  clearWalletLinkReview,
  forgetSavedBackendSession,
  prepareBackendSignIn,
  prepareWalletLink,
  refreshResumeAvailability,
  resumeBackendSession,
  walletLinks,
} from '@/lib/backend-session';

const address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const id = '00000000-0000-4000-8000-000000000001';
const profile = { userId: id, wallet: { id, address, chainId: 'eip155:1', accountKind: 'eoa' } };
function challenge(origin = 'http://localhost:5173') {
  const issued = new Date().toISOString();
  const expires = new Date(Date.now() + 300000).toISOString();
  const uri = new URL(origin);
  return {
    id,
    expiresAt: expires,
    message: `${uri.host} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Honey Wallet. This does not authorize transactions.\n\nURI: ${origin}\nVersion: 1\nChain ID: 1\nNonce: 00000000000040008000000000000001\nIssued At: ${issued}\nExpiration Time: ${expires}\nRequest ID: ${id}`,
  };
}
const linkedAddress = '0x0000000000000000000000000000000000000002';
function linkChallenge() {
  const issued = new Date().toISOString();
  const expires = new Date(Date.now() + 300000).toISOString();
  return {
    id: '00000000-0000-4000-8000-000000000003',
    expiresAt: expires,
    message: `localhost:5173 wants you to sign in with your Ethereum account:\n${linkedAddress}\n\nLink this wallet to my Honey Wallet account. This does not authorize transactions.\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: 1\nNonce: 00000000000040008000000000000001\nIssued At: ${issued}\nExpiration Time: ${expires}\nRequest ID: 00000000-0000-4000-8000-000000000003`,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.active = 'real';
  mocks.storedRefresh = null;
  vi.stubEnv('EXPO_PUBLIC_AUTH_ORIGIN', 'http://localhost:5173');
  vi.stubEnv('EXPO_PUBLIC_AUTH_CHAIN_ID', 'eip155:1');
  backendVisibility('active');
  clearBackendSession();
  mocks.signOut.mockResolvedValue(undefined);
  mocks.configuration.mockResolvedValue({
    enabled: true,
    origin: 'http://localhost:5173',
    chainId: 'eip155:1',
  });
  mocks.accounts.mockResolvedValue([{ id: 'real', addresses: { evm: address } }]);
  mocks.challenge.mockImplementation(async () => challenge());
  mocks.linkChallenge.mockImplementation(async () => linkChallenge());
  mocks.linkWallet.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000004',
    chainId: 'eip155:1',
    address: linkedAddress,
    accountKind: 'eoa',
  });
  mocks.wallets.mockResolvedValue([
    profile.wallet,
    {
      id: '00000000-0000-4000-8000-000000000004',
      chainId: 'eip155:1',
      address: linkedAddress,
      accountKind: 'eoa',
    },
  ]);
  mocks.confirm.mockResolvedValue(true);
  mocks.key.mockResolvedValue(new Uint8Array(32).fill(1));
  mocks.address.mockReturnValue(address);
  mocks.sign.mockResolvedValue('signature');
  mocks.verify.mockImplementation(async () => ({
    accessToken: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    refreshToken: 'c'.repeat(64),
    refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    deviceId: '00000000-0000-4000-8000-000000000002',
    profile,
  }));
  mocks.profile.mockResolvedValue(profile);
  mocks.refresh.mockImplementation(async () => ({
    accessToken: 'b'.repeat(64),
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    refreshToken: 'd'.repeat(64),
    refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    deviceId: '00000000-0000-4000-8000-000000000002',
    profile,
  }));
});
it('reviews and locally signs a separate explicit wallet-link proof before listing the linked wallet', async () => {
  await prepareBackendSignIn();
  await approveBackendSignIn();
  mocks.key.mockClear();
  await prepareWalletLink({
    id: 'second',
    label: 'Second wallet',
    source: { kind: 'key' },
    addresses: { evm: linkedAddress },
  });
  expect(walletLinks.get().review?.address).toBe(linkedAddress);
  expect(mocks.key).not.toHaveBeenCalled();
  mocks.address.mockReturnValue(linkedAddress);
  await approveWalletLink();
  expect(mocks.confirm).toHaveBeenLastCalledWith('Link wallet to Honey', true);
  expect(mocks.linkWallet).toHaveBeenCalledWith(
    'a'.repeat(64),
    '00000000-0000-4000-8000-000000000003',
    'signature',
  );
  expect(walletLinks.get().wallets).toHaveLength(2);
  expect(walletLinks.get().review).toBeNull();
});
it('does not sign or submit after a wallet-link review is cancelled during owner confirmation', async () => {
  await prepareBackendSignIn();
  await approveBackendSignIn();
  mocks.key.mockClear();
  await prepareWalletLink({
    id: 'second',
    label: 'Second wallet',
    source: { kind: 'key' },
    addresses: { evm: linkedAddress },
  });
  let finishConfirmation!: (confirmed: boolean) => void;
  mocks.confirm.mockImplementationOnce(
    () => new Promise((resolve) => (finishConfirmation = resolve)),
  );
  const approval = approveWalletLink();
  clearWalletLinkReview();
  finishConfirmation(true);
  await approval;
  expect(mocks.key).not.toHaveBeenCalled();
  expect(mocks.linkWallet).not.toHaveBeenCalled();
  expect(walletLinks.get().review).toBeNull();
});
afterEach(() => {
  clearBackendSession();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it('requires review before device proof, wipes key bytes, verifies profile and expires locally', async () => {
  await prepareBackendSignIn();
  expect(backendSession.get().review).not.toBeNull();
  expect(mocks.key).not.toHaveBeenCalled();
  await approveBackendSignIn();
  expect(mocks.confirm).toHaveBeenCalledWith('Sign in to Honey', true);
  const key = await mocks.key.mock.results[0]?.value;
  expect(key.every((b: number) => b === 0)).toBe(true);
  expect(backendSessionToken()).toBe('a'.repeat(64));
  expect(backendSession.get().profile).toEqual(profile);
  expect(mocks.storedRefresh).toContain('c'.repeat(64));
  await vi.advanceTimersByTimeAsync(14 * 60_000);
  expect(mocks.refresh).toHaveBeenCalledWith(
    'c'.repeat(64),
    '00000000-0000-4000-8000-000000000002',
  );
  expect(backendSessionToken()).toBe('b'.repeat(64));
  mocks.refresh.mockRejectedValueOnce(new Error('offline'));
  await vi.advanceTimersByTimeAsync(14 * 60_000);
  expect(backendSessionToken()).toBeNull();
  expect(backendSession.get().resumeAvailable).toBe(true);
});
it('stores only a rotating refresh family, suspends on background and resumes after owner confirmation', async () => {
  await prepareBackendSignIn();
  await approveBackendSignIn();
  mocks.signOut.mockClear();
  backendVisibility('background');
  expect(backendSessionToken()).toBeNull();
  expect(mocks.signOut).not.toHaveBeenCalled();
  expect(mocks.storedRefresh).toContain('c'.repeat(64));
  backendVisibility('active');
  await refreshResumeAvailability();
  expect(backendSession.get().resumeAvailable).toBe(true);
  await resumeBackendSession();
  expect(mocks.confirm).toHaveBeenLastCalledWith('Resume Honey account', true);
  expect(mocks.refresh).toHaveBeenCalledWith(
    'c'.repeat(64),
    '00000000-0000-4000-8000-000000000002',
  );
  expect(backendSessionToken()).toBe('b'.repeat(64));
  expect(mocks.storedRefresh).toContain('d'.repeat(64));
});

it('forgets a suspended refresh family and attempts server-side revocation', async () => {
  await prepareBackendSignIn();
  await approveBackendSignIn();
  backendVisibility('background');
  await forgetSavedBackendSession();
  expect(mocks.storedRefresh).toBeNull();
  expect(backendSession.get().resumeAvailable).toBe(false);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.signOut).toHaveBeenCalledTimes(1);
});
it('awaits access-session revocation and clears refresh material when actively signed in', async () => {
  await prepareBackendSignIn();
  await approveBackendSignIn();
  const events: string[] = [];
  mocks.signOut.mockImplementation(async () => {
    events.push('server-revoked');
  });
  await forgetSavedBackendSession();
  expect(events).toEqual(['server-revoked']);
  expect(mocks.signOut).toHaveBeenCalledTimes(1);
  expect(backendSessionToken()).toBeNull();
  expect(mocks.storedRefresh).toBeNull();
});
it('completes local session removal when refresh transport stalls during sign-out', async () => {
  await prepareBackendSignIn();
  await approveBackendSignIn();
  backendVisibility('background');
  mocks.refresh.mockReturnValue(new Promise(() => {}));
  const forgetting = forgetSavedBackendSession();
  await vi.advanceTimersByTimeAsync(2000);
  await forgetting;
  expect(mocks.storedRefresh).toBeNull();
  expect(backendSession.get().resumeAvailable).toBe(false);
});
it('supports a dedicated extension origin with access-only 15-minute sessions', async () => {
  vi.stubEnv('EXPO_PUBLIC_TARGET', 'extension');
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  vi.stubEnv('EXPO_PUBLIC_AUTH_ORIGIN', origin);
  mocks.configuration.mockResolvedValue({ enabled: true, origin, chainId: 'eip155:1' });
  mocks.challenge.mockImplementation(async () => challenge(origin));
  mocks.verify.mockImplementation(async () => ({
    accessToken: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    refreshToken: null,
    refreshExpiresAt: null,
    deviceId: '00000000-0000-4000-8000-000000000002',
    profile,
  }));
  await prepareBackendSignIn();
  expect(backendSession.get().review?.origin).toBe(origin);
  await approveBackendSignIn();
  expect(backendSessionToken()).toBe('a'.repeat(64));
  expect(backendSession.get().resumeAvailable).toBe(false);
  expect(mocks.storedRefresh).toBeNull();
  expect(mocks.refresh).not.toHaveBeenCalled();
  backendVisibility('background');
  expect(backendSessionToken()).toBeNull();
});
it('rejects and revokes an extension response that includes refresh credentials', async () => {
  vi.stubEnv('EXPO_PUBLIC_TARGET', 'extension');
  const origin = `chrome-extension://${'a'.repeat(32)}`;
  vi.stubEnv('EXPO_PUBLIC_AUTH_ORIGIN', origin);
  mocks.configuration.mockResolvedValue({ enabled: true, origin, chainId: 'eip155:1' });
  mocks.challenge.mockImplementation(async () => challenge(origin));
  await prepareBackendSignIn();
  await approveBackendSignIn();
  expect(mocks.signOut).toHaveBeenCalledWith('a'.repeat(64));
  expect(backendSessionToken()).toBeNull();
  expect(backendSession.get().profile).toBeNull();
  expect(mocks.storedRefresh).toBeNull();
  expect(backendSession.get().error).toMatch(/unexpected persistent browser session/i);
  expect(await refreshResumeAvailability()).toBe(false);
  await resumeBackendSession();
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it('refuses watched wallets and an API-selected identity origin before signing', async () => {
  mocks.accounts.mockResolvedValue([]);
  await prepareBackendSignIn();
  expect(mocks.challenge).not.toHaveBeenCalled();
  mocks.accounts.mockResolvedValue([{ id: 'real', addresses: { evm: address } }]);
  mocks.configuration.mockResolvedValue({
    enabled: true,
    origin: 'https://attacker.example',
    chainId: 'eip155:1',
  });
  await prepareBackendSignIn();
  expect(mocks.challenge).not.toHaveBeenCalled();
  expect(mocks.key).not.toHaveBeenCalled();
});
it('cancels on background during device authentication', async () => {
  await prepareBackendSignIn();
  mocks.confirm.mockImplementation(async () => {
    backendVisibility('background');
    backendVisibility('active');
    return true;
  });
  await approveBackendSignIn();
  expect(mocks.key).not.toHaveBeenCalled();
  expect(backendSessionToken()).toBeNull();
});
it('revokes a late verification response after account switch', async () => {
  await prepareBackendSignIn();
  mocks.verify.mockImplementation(async () => {
    mocks.active = 'other';
    backendWalletChanged();
    return {
      accessToken: 'b'.repeat(64),
      profile,
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      refreshToken: 'd'.repeat(64),
      refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      deviceId: '00000000-0000-4000-8000-000000000002',
    };
  });
  await approveBackendSignIn();
  expect(backendSessionToken()).toBeNull();
  expect(mocks.signOut).toHaveBeenCalledWith('b'.repeat(64));
});
it('rejects altered sign-in messages and mismatching private keys', async () => {
  mocks.challenge.mockImplementation(async () => ({
    ...challenge(),
    message: challenge().message.replace('Chain ID: 1', 'Chain ID: 10'),
  }));
  await prepareBackendSignIn();
  expect(backendSession.get().review).toBeNull();
  expect(mocks.key).not.toHaveBeenCalled();
  mocks.challenge.mockImplementation(async () => challenge());
  await prepareBackendSignIn();
  mocks.address.mockReturnValue('0x0000000000000000000000000000000000000000');
  await approveBackendSignIn();
  expect(mocks.sign).not.toHaveBeenCalled();
  const key = await mocks.key.mock.results[0]?.value;
  expect(key.every((b: number) => b === 0)).toBe(true);
});
it('does not restore a revoked session after protected-profile failure', async () => {
  await prepareBackendSignIn();
  mocks.profile.mockRejectedValue(new Error('Unauthorized'));
  await approveBackendSignIn();
  expect(backendSessionToken()).toBeNull();
  expect(mocks.signOut).toHaveBeenCalled();
});
