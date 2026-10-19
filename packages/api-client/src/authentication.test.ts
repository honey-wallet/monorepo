import { describe, expect, it, vi } from 'vitest';
import { validateSignInChallenge, validateWalletLinkChallenge } from './authentication';
import { createApiClient } from './client';

const address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const id = '00000000-0000-4000-8000-000000000001';
const issued = '2026-10-18T12:00:00Z';
const expires = '2026-10-18T12:05:00Z';
const message = `localhost:5173 wants you to sign in with your Ethereum account:
${address}

Sign in to Honey Wallet. This does not authorize transactions.

URI: http://localhost:5173
Version: 1
Chain ID: 1
Nonce: 00000000000040008000000000000001
Issued At: ${issued}
Expiration Time: ${expires}
Request ID: ${id}`;
const challenge = { id, message, expiresAt: expires };
const context = { origin: 'http://localhost:5173', address, chainId: 'eip155:1' };
const now = Date.parse(issued) + 1000;

describe('wallet authentication contract', () => {
  it('accepts the exact server SIWE subset with local, independently supplied context', () => {
    expect(() => validateSignInChallenge(challenge, context, now)).not.toThrow();
  });

  it('requires the distinct explicit wallet-link statement and preserves authorized API headers', async () => {
    const linkMessage = message.replace(
      'Sign in to Honey Wallet. This does not authorize transactions.',
      'Link this wallet to my Honey Wallet account. This does not authorize transactions.',
    );
    expect(() =>
      validateWalletLinkChallenge({ ...challenge, message: linkMessage }, context, now),
    ).not.toThrow();
    expect(() => validateWalletLinkChallenge(challenge, context, now)).toThrow();
    const token = 'a'.repeat(64);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(challenge)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id, chainId: 'eip155:1', address, accountKind: 'eoa' })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id, chainId: 'eip155:1', address, accountKind: 'eoa' }])),
      );
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.createWalletLinkChallenge(token, address, {
      headers: { Authorization: 'Bearer wrong' },
    });
    await api.linkWallet(token, id, '0xsignature');
    await api.wallets(token);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://api.test/api/v1/me/wallets/challenges',
      'http://api.test/api/v1/me/wallets',
      'http://api.test/api/v1/me/wallets',
    ]);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${token}`,
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('content-type')).toBe(
      'application/json',
    );
    expect(fetch.mock.calls[1]?.[1]?.credentials).toBe('omit');
  });

  it('accepts an exact Chrome extension origin while rejecting non-Chrome extension IDs', () => {
    const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const extensionMessage = message
      .replaceAll('localhost:5173', 'abcdefghijklmnopabcdefghijklmnop')
      .replace('http://abcdefghijklmnopabcdefghijklmnop', extensionOrigin);
    expect(() =>
      validateSignInChallenge(
        { ...challenge, message: extensionMessage },
        { ...context, origin: extensionOrigin },
        now,
      ),
    ).not.toThrow();
    expect(() =>
      validateSignInChallenge(
        {
          ...challenge,
          message: extensionMessage.replaceAll(
            'abcdefghijklmnopabcdefghijklmnop',
            'abcdefghijklmnopabcdefghijklmnopa',
          ),
        },
        { ...context, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnopa' },
        now,
      ),
    ).toThrow();
  });

  it.each([
    message.replace('localhost:5173 wants', 'attacker.example wants'),
    message.replace('URI: http://localhost:5173', 'URI: https://attacker.example'),
    message.replace('Chain ID: 1', 'Chain ID: 10'),
    message.replace(address, '0x0000000000000000000000000000000000000000'),
    message.replace('Sign in to Honey Wallet.', 'Authorize a transfer.'),
    `${message}\nResources:\n- urn:recap:delegated`,
    message.replace('12:05:00Z', '12:55:00Z'),
    message.replace('Issued At: 2026-10-18T12:00:00Z', 'Issued At: October 18, 2026 12:00:00 UTC'),
  ])('refuses an altered or broader signing request', (altered) => {
    expect(() =>
      validateSignInChallenge({ ...challenge, message: altered }, context, now),
    ).toThrow();
  });

  it('rejects expiry, future issuance, and insecure production origins', () => {
    expect(() => validateSignInChallenge(challenge, context, Date.parse(expires))).toThrow();
    expect(() => validateSignInChallenge(challenge, context, now - 60_000)).toThrow();
    expect(() =>
      validateSignInChallenge(challenge, { ...context, origin: 'http://honey.example' }, now),
    ).toThrow();
  });

  it('keeps authentication credentials in bound headers and never retries proofs', async () => {
    const token = 'a'.repeat(64);
    const profile = {
      userId: id,
      wallet: { id, address, chainId: 'eip155:1', accountKind: 'eoa' },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(profile)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'expired' } }), {
          status: 401,
        }),
      );
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await expect(
      api.profile(token, { headers: { Authorization: 'Bearer wrong' }, credentials: 'include' }),
    ).resolves.toEqual(profile);
    expect(fetch.mock.calls[0]?.[0]).toBe('http://api.test/api/v1/me');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${token}`,
    );
    expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('omit');
    await api.signOut(token);
    expect(fetch.mock.calls[1]?.[1]?.method).toBe('DELETE');
    await expect(api.verifySignIn(id, '0xsignature')).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('issues a per-installation device ID and rotates refresh credentials without cookies', async () => {
    const session = {
      accessToken: 'a'.repeat(64),
      tokenType: 'Bearer',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshToken: 'b'.repeat(64),
      refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      deviceId: id,
      profile: {
        userId: id,
        wallet: { id, address, chainId: 'eip155:1', accountKind: 'eoa' },
      },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(session)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...session, refreshToken: 'c'.repeat(64) })),
      );
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await expect(api.verifySignIn(id, '0xsignature')).resolves.toMatchObject(session);
    const verifyBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(verifyBody.deviceId).toMatch(/^[0-9a-f-]{36}$/i);
    await api.refreshSession(session.refreshToken, session.deviceId);
    expect(fetch.mock.calls[1]?.[0]).toBe('http://api.test/api/v1/auth/refresh');
    expect(fetch.mock.calls[1]?.[1]?.credentials).toBe('omit');
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      refreshToken: session.refreshToken,
      deviceId: session.deviceId,
    });
  });

  it('fails closed on invalid auth/session responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ enabled: 'true', accessToken: 'fake' })),
    );
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await expect(api.authConfiguration()).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(api.verifySignIn(id, '0xsignature')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
