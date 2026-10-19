import { validateSignInChallenge } from '@honey-wallet/api-client';
import { describe, expect, it } from 'vitest';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const origin = `chrome-extension://${extensionId}`;
const address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const id = '00000000-0000-4000-8000-000000000001';
const issued = '2026-10-18T12:00:00Z';
const expires = '2026-10-18T12:05:00Z';
const challenge = {
  id,
  expiresAt: expires,
  message: `${extensionId} wants you to sign in with your Ethereum account:
${address}

Sign in to Honey Wallet. This does not authorize transactions.

URI: ${origin}
Version: 1
Chain ID: 1
Nonce: 00000000000040008000000000000001
Issued At: ${issued}
Expiration Time: ${expires}
Request ID: ${id}`,
};
const now = Date.parse(issued) + 1000;

describe('extension wallet authentication acceptance', () => {
  it('accepts only the configured installed-extension origin and selected EOA context', () => {
    const expected = { origin, address, chainId: 'eip155:1' };
    expect(() => validateSignInChallenge(challenge, expected, now)).not.toThrow();

    for (const mismatch of [
      { ...expected, origin: `chrome-extension://${'b'.repeat(32)}` },
      { ...expected, origin: `${origin}/attacker` },
      { ...expected, address: '0x0000000000000000000000000000000000000001' },
      { ...expected, chainId: 'eip155:10' },
    ]) {
      expect(() => validateSignInChallenge(challenge, mismatch, now)).toThrow();
    }
  });

  it('refuses an extension challenge changed to a website or an authorization request', () => {
    for (const message of [
      challenge.message.replace(origin, 'https://wallet.example'),
      challenge.message.replace(
        'This does not authorize transactions.',
        'Authorize a token transfer.',
      ),
      `${challenge.message}\nResources:\n- urn:recap:delegated`,
    ]) {
      expect(() =>
        validateSignInChallenge(
          { ...challenge, message },
          { origin, address, chainId: 'eip155:1' },
          now,
        ),
      ).toThrow();
    }
  });
});
