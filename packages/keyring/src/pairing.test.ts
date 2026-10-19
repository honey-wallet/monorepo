import { describe, expect, it } from 'vitest';
import {
  channelFor,
  clearPairAnswerSecrets,
  clearPairOfferSecrets,
  clearPairSession,
  createPairAnswer,
  createPairOffer,
  decodeNonce,
  encodeNonce,
  encodeReveal,
  openPayload,
  openReveal,
  type PairAnswer,
  type PairPayload,
  pairSession,
  parsePairUri,
  sealPayload,
} from './pairing';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * Runs both sides through the mailbox messages. `relay` can swap what the extension
 * receives, as someone in the middle would.
 */
function pair(relay: { commit?: (c: string) => string; reveal?: (r: string) => string } = {}) {
  const offer = createPairOffer(random);
  const scanned = parsePairUri(offer.uri);
  if (!scanned) throw new Error('unparsable');

  // 1. Phone commits.
  const phone = createPairAnswer(random);
  const commit = (relay.commit ?? ((c) => c))(phone.commitment);
  // 2. Extension sends its nonce.
  const nonceMessage = encodeNonce(offer.nonce);
  // 3. Phone reveals.
  const reveal = (relay.reveal ?? ((r) => r))(encodeReveal(phone));

  const phoneSide = pairSession(phone.secretKey, scanned.publicKey, {
    channel: scanned.channel,
    extensionKey: scanned.publicKey,
    phoneKey: phone.publicKey,
    extensionNonce: decodeNonce(nonceMessage),
    phoneNonce: phone.nonce,
  });
  const extensionSide = () => {
    const opened = openReveal(reveal, commit);
    return pairSession(offer.secretKey, opened.publicKey, {
      channel: offer.channel,
      extensionKey: offer.publicKey,
      phoneKey: opened.publicKey,
      extensionNonce: offer.nonce,
      phoneNonce: opened.nonce,
    });
  };
  return { phoneSide, extensionSide };
}

describe('pairing', () => {
  it('overwrites ephemeral offer, answer, and session key buffers when retired', () => {
    const offer = createPairOffer(random);
    const answer = createPairAnswer(random);
    const session = pairSession(answer.secretKey, offer.publicKey, {
      channel: offer.channel,
      extensionKey: offer.publicKey,
      phoneKey: answer.publicKey,
      extensionNonce: offer.nonce,
      phoneNonce: answer.nonce,
    });
    const offerSecret = offer.secretKey;
    const offerNonce = offer.nonce;
    const answerSecret = answer.secretKey;
    const answerNonce = answer.nonce;
    const sessionKey = session.key;

    clearPairOfferSecrets(offer);
    clearPairAnswerSecrets(answer);
    clearPairSession(session);

    expect(offerSecret.every((byte) => byte === 0)).toBe(true);
    expect(offerNonce.every((byte) => byte === 0)).toBe(true);
    expect(answerSecret.every((byte) => byte === 0)).toBe(true);
    expect(answerNonce.every((byte) => byte === 0)).toBe(true);
    expect(sessionKey.every((byte) => byte === 0)).toBe(true);
    // Cleanup is safe in overlapping error and unmount handlers.
    expect(() => clearPairSession(session)).not.toThrow();
  });

  it('gives both sides the same key and code', () => {
    const { phoneSide, extensionSide } = pair();
    const ext = extensionSide();
    expect(phoneSide.code).toMatch(/^\d{6}$/);
    expect(ext.code).toBe(phoneSide.code);
    expect(ext.key).toEqual(phoneSide.key);
  });

  it('carries the wallet across, readable only with the shared key', () => {
    const { phoneSide, extensionSide } = pair();
    const payload = { v: 1 as const, mnemonic: PHRASE, accounts: [{ index: 0, label: 'Maya' }] };
    const data = sealPayload(phoneSide.key, payload, random);
    expect(data).not.toContain('abandon');
    expect(openPayload(extensionSide().key, data)).toEqual(payload);
  });

  it('overwrites the caller-owned sealing nonce after payload encryption', () => {
    const { phoneSide } = pair();
    const nonce = new Uint8Array(24).fill(7);
    sealPayload(phoneSide.key, { v: 1, mnemonic: PHRASE, accounts: [] }, () => nonce);
    expect(nonce.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    ['non-array accounts', { not: 'an array' }],
    ['non-object account', [null]],
    ['unsafe index', [{ index: Number.MAX_SAFE_INTEGER, label: 'Wallet' }]],
    ['negative index', [{ index: -1, label: 'Wallet' }]],
    [
      'duplicate index',
      [
        { index: 0, label: 'One' },
        { index: 0, label: 'Two' },
      ],
    ],
    ['non-string label', [{ index: 0, label: 42 }]],
    ['oversized label', [{ index: 0, label: 'x'.repeat(257) }]],
    ['too many accounts', Array.from({ length: 257 }, (_, index) => ({ index, label: 'Wallet' }))],
  ])('rejects malformed pairing account metadata: %s', (_case, accounts) => {
    const { phoneSide, extensionSide } = pair();
    const data = sealPayload(
      phoneSide.key,
      { v: 1, mnemonic: PHRASE, accounts } as PairPayload,
      random,
    );
    expect(() => openPayload(extensionSide().key, data)).toThrow('Bad pairing payload');
  });

  it('rejects a reveal that differs from the commitment', () => {
    const intruder = createPairAnswer(random);
    const { extensionSide } = pair({ reveal: () => encodeReveal(intruder) });
    expect(extensionSide).toThrow('committed');
  });

  it('leaves someone in the middle with mismatched codes and an unreadable payload', () => {
    // They replace both the commitment and the reveal with their own key.
    let intruder: PairAnswer | undefined;
    const { phoneSide, extensionSide } = pair({
      commit: () => {
        intruder = createPairAnswer(random);
        return intruder.commitment;
      },
      reveal: () => encodeReveal(intruder as PairAnswer),
    });
    const ext = extensionSide();
    expect(ext.code).not.toBe(phoneSide.code);
    const data = sealPayload(phoneSide.key, { v: 1, mnemonic: PHRASE, accounts: [] }, random);
    expect(() => openPayload(ext.key, data)).toThrow();
  });

  it('derives the channel the server checks: sha256 of the token, in hex', async () => {
    const token = '3f9a1c7e5b2d4086aa71c3e9f0b6d218';
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    );
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(channelFor(token)).toBe(hex);
    const offer = createPairOffer(random);
    expect(offer.uri).not.toContain(offer.channel);
    expect(parsePairUri(offer.uri)?.channel).toBe(offer.channel);
  });

  it('ignores QR codes that are not current Honey pairing codes', () => {
    expect(parsePairUri('ethereum:0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBeNull();
    expect(parsePairUri('honey-pair:1?c=q2v8Zp0rWm4Tn6Yc1Lk3Hg&k=AAAA')).toBeNull();
    expect(parsePairUri('honey-pair:2?t=nothex&k=AAAA')).toBeNull();
  });

  it('marks a browser-to-phone code and binds the direction into the code and key', () => {
    const offer = createPairOffer(random, 'toPhone');
    expect(offer.uri).toMatch(/&d=p$/);
    const scanned = parsePairUri(offer.uri);
    expect(scanned?.direction).toBe('toPhone');
    expect(parsePairUri(createPairOffer(random).uri)?.direction).toBe('toBrowser');
    expect(parsePairUri(`${offer.uri.replace('&d=p', '')}&d=x`)).toBeNull();

    const phone = createPairAnswer(random);
    const transcript = {
      channel: offer.channel,
      extensionKey: offer.publicKey,
      phoneKey: phone.publicKey,
      extensionNonce: offer.nonce,
      phoneNonce: phone.nonce,
    };
    const phoneSide = pairSession(phone.secretKey, offer.publicKey, {
      ...transcript,
      direction: 'toPhone',
    });
    const browserSide = pairSession(offer.secretKey, phone.publicKey, {
      ...transcript,
      direction: 'toPhone',
    });
    expect(browserSide).toEqual(phoneSide);
    // The other direction's session can't read it.
    const other = pairSession(offer.secretKey, phone.publicKey, transcript);
    expect(other.key).not.toEqual(phoneSide.key);
    const sealed = sealPayload(browserSide.key, { v: 1, mnemonic: PHRASE, accounts: [] }, random);
    expect(openPayload(phoneSide.key, sealed).mnemonic).toBe(PHRASE);
    expect(() => openPayload(other.key, sealed)).toThrow();
  });
});
