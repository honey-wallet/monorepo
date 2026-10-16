import { describe, expect, it } from 'vitest';
import {
  createPairAnswer,
  createPairOffer,
  openPayload,
  pairSession,
  parsePairUri,
  sealPayload,
} from './pairing';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Runs both sides of a pairing, optionally with a key swapped in between. */
function pair({ swapPhoneKey = false } = {}) {
  const offer = createPairOffer(random);
  const scanned = parsePairUri(offer.uri);
  if (!scanned) throw new Error('unparsable');
  const phone = createPairAnswer(random);
  const phoneSide = pairSession(
    phone.secretKey,
    scanned.publicKey,
    scanned.channel,
    scanned.publicKey,
    phone.publicKey,
  );
  // What the extension receives as `hello`: the phone's key, or an attacker's.
  const hello = swapPhoneKey ? createPairAnswer(random).publicKey : phone.publicKey;
  const extensionSide = pairSession(offer.secretKey, hello, offer.channel, offer.publicKey, hello);
  return { phoneSide, extensionSide };
}

describe('pairing', () => {
  it('gives both sides the same key and code', () => {
    const { phoneSide, extensionSide } = pair();
    expect(phoneSide.code).toMatch(/^\d{6}$/);
    expect(phoneSide.code).toBe(extensionSide.code);
    expect(phoneSide.key).toEqual(extensionSide.key);
  });

  it('carries the wallet across, readable only with the shared key', () => {
    const { phoneSide, extensionSide } = pair();
    const payload = { v: 1 as const, mnemonic: PHRASE, accounts: [{ index: 0, label: 'Maya' }] };
    const data = sealPayload(phoneSide.key, payload, random);
    expect(data).not.toContain('abandon');
    expect(openPayload(extensionSide.key, data)).toEqual(payload);
  });

  it('shows different codes when a key is swapped in between', () => {
    const { phoneSide, extensionSide } = pair({ swapPhoneKey: true });
    expect(phoneSide.code).not.toBe(extensionSide.code);
    const data = sealPayload(phoneSide.key, { v: 1, mnemonic: PHRASE, accounts: [] }, random);
    expect(() => openPayload(extensionSide.key, data)).toThrow();
  });

  it('ignores QR codes that are not Honey pairing codes', () => {
    expect(parsePairUri('ethereum:0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBeNull();
    expect(parsePairUri('honey-pair:1?c=short&k=AAAA')).toBeNull();
    expect(parsePairUri('honey-pair:1?c=q2v8Zp0rWm4Tn6Yc1Lk3Hg&k=!!')).toBeNull();
  });
});
