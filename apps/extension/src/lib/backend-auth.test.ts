import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authConfiguration: vi.fn(),
  createSignInChallenge: vi.fn(),
  verifySignIn: vi.fn(),
  profile: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('./api', () => ({ api: mocks }));

import {
  approveBackendSignIn,
  backendAccessToken,
  clearBackendSignIn,
  prepareBackendSignIn,
} from './backend-auth';

const origin = `chrome-extension://${'a'.repeat(32)}`;
const address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const account = { index: 2, addresses: { evm: address } } as never;

function validChallenge(walletAddress = address) {
  const id = '00000000-0000-4000-8000-000000000001';
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  return {
    id,
    expiresAt,
    message: `${'a'.repeat(32)} wants you to sign in with your Ethereum account:
${walletAddress}

Sign in to Honey Wallet. This does not authorize transactions.

URI: ${origin}
Version: 1
Chain ID: 1
Nonce: 00000000000040008000000000000001
Issued At: ${issuedAt}
Expiration Time: ${expiresAt}
Request ID: ${id}`,
  };
}

afterEach(() => vi.resetAllMocks());

it('prepares a backend challenge only for the exact configured extension origin and account', async () => {
  mocks.authConfiguration.mockResolvedValue({
    enabled: true,
    method: 'siwe_eoa',
    origin,
    chainId: 'eip155:1',
    sessionTtlSeconds: 900,
  });
  const challenge = validChallenge();
  mocks.createSignInChallenge.mockResolvedValue(challenge);

  const review = await prepareBackendSignIn(account, origin);
  expect(review).toMatchObject({
    accountIndex: 2,
    address,
    origin,
    chainId: 'eip155:1',
    challenge,
  });
  expect(mocks.createSignInChallenge).toHaveBeenCalledWith(address, 'eip155:1');
});

it('does not request a challenge when backend origin differs from the installed extension', async () => {
  mocks.authConfiguration.mockResolvedValue({
    enabled: true,
    method: 'siwe_eoa',
    origin: 'https://wallet.example',
    chainId: 'eip155:1',
    sessionTtlSeconds: 900,
  });

  await expect(prepareBackendSignIn(account, origin)).rejects.toThrow(/not configured/i);
  expect(mocks.createSignInChallenge).not.toHaveBeenCalled();
});

it('reviews, signs, and verifies only the derived extension wallet profile in memory', async () => {
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const walletAddress = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  const selected = { index: 0, addresses: { evm: walletAddress } } as never;
  mocks.authConfiguration.mockResolvedValue({
    enabled: true,
    method: 'siwe_eoa',
    origin,
    chainId: 'eip155:1',
    sessionTtlSeconds: 900,
  });
  mocks.createSignInChallenge.mockResolvedValue(validChallenge(walletAddress));
  const wallet = {
    id: '00000000-0000-4000-8000-000000000002',
    chainId: 'eip155:1',
    address: walletAddress,
    accountKind: 'eoa',
  };
  mocks.verifySignIn.mockResolvedValue({
    accessToken: 'access-token',
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: null,
    refreshExpiresAt: null,
    deviceId: '00000000-0000-4000-8000-000000000003',
    profile: { userId: '00000000-0000-4000-8000-000000000004', wallet },
  });
  mocks.profile.mockResolvedValue({ userId: '00000000-0000-4000-8000-000000000004', wallet });
  mocks.signOut.mockResolvedValue(undefined);

  const review = await prepareBackendSignIn(selected, origin);
  expect(review.challenge.message).toContain('This does not authorize transactions.');
  expect(await approveBackendSignIn(mnemonic, review)).toBe(walletAddress);
  expect(backendAccessToken()).toBe('access-token');
  expect(mocks.profile).toHaveBeenCalledWith('access-token');
  mocks.signOut.mockRejectedValueOnce(new Error('offline'));
  expect(await clearBackendSignIn()).toBe(false);
  expect(mocks.signOut).toHaveBeenCalledWith('access-token');
  expect(backendAccessToken()).toBeNull();
});

it('revokes a verification that completes after sign-in has been cancelled', async () => {
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const walletAddress = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  const selected = { index: 0, addresses: { evm: walletAddress } } as never;
  mocks.authConfiguration.mockResolvedValue({
    enabled: true,
    method: 'siwe_eoa',
    origin,
    chainId: 'eip155:1',
    sessionTtlSeconds: 900,
  });
  mocks.createSignInChallenge.mockResolvedValue(validChallenge(walletAddress));
  let resolveVerification!: (value: unknown) => void;
  mocks.verifySignIn.mockReturnValue(
    new Promise((resolve) => {
      resolveVerification = resolve;
    }),
  );
  mocks.signOut.mockResolvedValue(undefined);

  const review = await prepareBackendSignIn(selected, origin);
  const approval = approveBackendSignIn(mnemonic, review);
  await vi.waitFor(() => expect(mocks.verifySignIn).toHaveBeenCalledOnce());
  await clearBackendSignIn();
  mocks.signOut.mockRejectedValueOnce(new Error('offline'));
  resolveVerification({
    accessToken: 'late-access-token',
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: null,
    refreshExpiresAt: null,
    deviceId: '00000000-0000-4000-8000-000000000003',
    profile: {
      userId: '00000000-0000-4000-8000-000000000004',
      wallet: {
        id: '00000000-0000-4000-8000-000000000002',
        chainId: 'eip155:1',
        address: walletAddress,
        accountKind: 'eoa',
      },
    },
  });

  await expect(approval).rejects.toThrow(/revocation failed/i);
  expect(mocks.signOut).toHaveBeenCalledWith('late-access-token');
  expect(backendAccessToken()).toBeNull();
});
