import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './lib/api';
import WalletSignIn, { type EthereumProvider } from './WalletSignIn';

const address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const id = '00000000-0000-4000-8000-000000000001';
const token = 'a'.repeat(64);
const profile = {
  userId: id,
  wallet: { id, address, chainId: 'eip155:1', accountKind: 'eoa' as const },
};

function challenge() {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(issuedAt) + 300_000).toISOString();
  return {
    id,
    expiresAt,
    message: `${window.location.host} wants you to sign in with your Ethereum account:
${address}

Sign in to Honey Wallet. This does not authorize transactions.

URI: ${window.location.origin}
Version: 1
Chain ID: 1
Nonce: 00000000000040008000000000000001
Issued At: ${issuedAt}
Expiration Time: ${expiresAt}
Request ID: ${id}`,
  };
}

describe('wallet sign-in vertical slice', () => {
  let listeners: Map<string, () => void>;
  let wallet: EthereumProvider;
  beforeEach(() => {
    listeners = new Map();
    wallet = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_chainId') return '0x1';
        if (method === 'personal_sign') return `0x${'a'.repeat(130)}`;
        return [address];
      }),
      on: (event, listener) => {
        listeners.set(event, listener);
      },
      removeListener: (event) => {
        listeners.delete(event);
      },
    };
    Object.defineProperty(window, 'ethereum', { value: wallet, configurable: true });
    vi.spyOn(api, 'operations').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'swapConfiguration').mockRejectedValue(new Error('not configured'));
    vi.spyOn(api, 'acrossConfiguration').mockRejectedValue(new Error('not configured'));
    vi.spyOn(api, 'authConfiguration').mockResolvedValue({
      enabled: true,
      method: 'siwe_eoa',
      origin: window.location.origin,
      chainId: 'eip155:1',
      sessionTtlSeconds: 900,
    });
    vi.spyOn(api, 'createSignInChallenge').mockImplementation(async () => challenge());
    vi.spyOn(api, 'verifySignIn').mockResolvedValue({
      accessToken: token,
      tokenType: 'Bearer',
      profile,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshToken: null,
      refreshExpiresAt: null,
      deviceId: '00000000-0000-4000-8000-000000000002',
    });
    vi.spyOn(api, 'profile').mockResolvedValue(profile);
    vi.spyOn(api, 'signOut').mockResolvedValue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'ethereum');
  });

  async function review() {
    fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet to sign in' }));
    return await screen.findByRole('button', { name: 'Sign in with this wallet' });
  }

  it('requires review before signing, fetches the protected profile, and revokes on sign-out', async () => {
    render(<WalletSignIn />);
    const sign = await review();
    expect(wallet.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'personal_sign' }),
    );
    fireEvent.click(sign);
    expect(await screen.findByText(`Signed in as ${address}`)).toBeInTheDocument();
    expect(api.profile).toHaveBeenCalledWith(token);
    expect(localStorage.getItem('accessToken')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(api.signOut).toHaveBeenCalledWith(token));
  });

  it('refuses a foreign origin before connecting or requesting a signature', async () => {
    vi.mocked(api.authConfiguration).mockResolvedValue({
      enabled: true,
      method: 'siwe_eoa',
      origin: 'https://other.example',
      chainId: 'eip155:1',
      sessionTtlSeconds: 900,
    });
    render(<WalletSignIn />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet to sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not configured for this website');
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it('clears an authenticated session on account changes', async () => {
    render(<WalletSignIn />);
    fireEvent.click(await review());
    await screen.findByText(`Signed in as ${address}`);
    act(() => listeners.get('accountsChanged')?.());
    expect(screen.queryByText(`Signed in as ${address}`)).not.toBeInTheDocument();
    await waitFor(() => expect(api.signOut).toHaveBeenCalledWith(token));
  });

  it('rejects and revokes a browser session that unexpectedly includes refresh credentials', async () => {
    vi.mocked(api.verifySignIn).mockResolvedValue({
      accessToken: token,
      tokenType: 'Bearer',
      profile,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshToken: 'b'.repeat(64),
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      deviceId: '00000000-0000-4000-8000-000000000002',
    });
    render(<WalletSignIn />);
    const sign = await review();
    fireEvent.click(sign);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in did not complete');
    expect(api.profile).not.toHaveBeenCalled();
    await waitFor(() => expect(api.signOut).toHaveBeenCalledWith(token));
    expect(screen.queryByText(`Signed in as ${address}`)).not.toBeInTheDocument();
  });

  it('discards and revokes a late verification result after a network change', async () => {
    let resolve: ((value: Awaited<ReturnType<typeof api.verifySignIn>>) => void) | undefined;
    vi.mocked(api.verifySignIn).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<WalletSignIn />);
    fireEvent.click(await review());
    await waitFor(() => expect(api.verifySignIn).toHaveBeenCalled());
    act(() => listeners.get('chainChanged')?.());
    await act(async () =>
      resolve?.({
        accessToken: token,
        tokenType: 'Bearer',
        profile,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        refreshToken: null,
        refreshExpiresAt: null,
        deviceId: '00000000-0000-4000-8000-000000000002',
      }),
    );
    expect(screen.queryByText(`Signed in as ${address}`)).not.toBeInTheDocument();
    await waitFor(() => expect(api.signOut).toHaveBeenCalledWith(token));
  });

  it.each([
    ['user ID', { ...profile, userId: '00000000-0000-4000-8000-000000000003' }],
    [
      'wallet ID',
      {
        ...profile,
        wallet: { ...profile.wallet, id: '00000000-0000-4000-8000-000000000003' },
      },
    ],
  ])(
    'rejects and revokes a session when the protected profile %s differs',
    async (_field, issuedProfile) => {
      vi.mocked(api.verifySignIn).mockResolvedValue({
        accessToken: token,
        tokenType: 'Bearer',
        profile: issuedProfile,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        refreshToken: null,
        refreshExpiresAt: null,
        deviceId: '00000000-0000-4000-8000-000000000002',
      });
      render(<WalletSignIn />);
      const sign = await review();
      fireEvent.click(sign);
      expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in did not complete');
      await waitFor(() => expect(api.signOut).toHaveBeenCalledWith(token));
      expect(screen.queryByText(`Signed in as ${address}`)).not.toBeInTheDocument();
    },
  );
});
