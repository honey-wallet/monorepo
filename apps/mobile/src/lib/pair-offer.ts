import type { PairChannel } from '@honey-wallet/api-client';
import {
  createPairAnswer,
  decodeNonce,
  encodeReveal,
  openPayload,
  type PairSession,
  pairSession,
  parsePairUri,
} from '@honey-wallet/keyring';
import { getRandomBytes } from 'expo-crypto';
import { api } from '@/lib/api';

/**
 * Hands a pairing code from the in-app scanner to the pairing screen, in memory.
 *
 * Expo Router makes every screen reachable by URL (honey://pair-extension?…), so the
 * offer must never come from route params: a link on a web page could otherwise drop
 * someone into pairing with a stranger's browser. Only the scanner can put one here,
 * and the pairing screen takes it exactly once.
 */
let held: { uri: string; at: number } | null = null;

/** How long a scanned code waits for the pairing screen to pick it up. */
const FRESH_MS = 60_000;

export function holdScannedOffer(uri: string) {
  held = parsePairUri(uri) ? { uri, at: Date.now() } : null;
}

/** The code the scanner just read, once; null if there isn't a fresh one. */
export function takeScannedOffer(): string | null {
  const offer = held && Date.now() - held.at < FRESH_MS ? held.uri : null;
  held = null;
  return offer;
}

const TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 1000;

/**
 * The phone's half of the handshake (see packages/keyring/src/pairing.ts): commit to a
 * one-time key, wait for the browser's nonce, then reveal. Returns the shared session
 * and the mailbox to send the wallet to once the user confirms.
 */
export async function phoneHandshake(uri: string, signal: AbortSignal) {
  const offer = parsePairUri(uri);
  if (!offer) throw new Error('That isn’t a Honey pairing code');
  const pair: PairChannel = { channel: offer.channel, token: offer.token };
  const answer = createPairAnswer(getRandomBytes);
  await api.pairSend(pair, 'commit', { data: answer.commitment });

  const deadline = Date.now() + TIMEOUT_MS;
  let nonce: string | null = null;
  while (!nonce) {
    signal.throwIfAborted();
    if (Date.now() > deadline) throw new Error('Your browser didn’t answer. Scan a new code.');
    nonce = (await api.pairReceive(pair, 'nonce', { signal }))?.data ?? null;
    if (!nonce) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  await api.pairSend(pair, 'reveal', { data: encodeReveal(answer) });

  const session = pairSession(answer.secretKey, offer.publicKey, {
    channel: offer.channel,
    extensionKey: offer.publicKey,
    phoneKey: answer.publicKey,
    extensionNonce: decodeNonce(nonce),
    phoneNonce: answer.nonce,
    direction: offer.direction,
  });
  return { pair, session, direction: offer.direction };
}

/** Which way a scanned code moves the wallet, or null if it isn't a pairing code. */
export const offerDirection = (uri: string) => parsePairUri(uri)?.direction ?? null;

/**
 * Browser to phone, after "Codes match": waits for the browser to send its wallet (it
 * asks for its password first) and opens it with this session's key.
 */
export async function receiveFromBrowser(
  pair: PairChannel,
  session: PairSession,
  signal: AbortSignal,
) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const message = await api.pairReceive(pair, 'payload', { signal });
    if (message) return openPayload(session.key, message.data);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('Your browser didn’t send the wallet. Scan a new code.');
}
