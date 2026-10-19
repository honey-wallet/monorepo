import type { PairChannel, PairSlot } from '@honey-wallet/api-client';
import {
  clearPairBytes,
  clearPairOfferSecrets,
  clearPairSession,
  createPairOffer,
  encodeNonce,
  openPayload,
  openReveal,
  type PairDirection,
  type PairOffer,
  type PairPayload,
  type PairSession,
  pairSession,
  sealPayload,
} from '@honey-wallet/keyring';
import { getRandomBytes } from 'expo-crypto';
import { api } from '@/lib/api';
import { readPrimaryWallet } from '@/lib/vault';

/**
 * The browser's half of pairing with a phone (see packages/keyring/src/pairing.ts; the
 * phone's half is lib/pair-offer.ts). The browser shows the QR code, waits for the
 * phone's commitment, sends its nonce, checks the reveal, then both show the same code.
 * Then the wallet moves: phone to browser (receiveWallet) or browser to phone (sendWallet).
 */

/** The mailbox keeps messages for five minutes; stop waiting after that. */
export const PAIR_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 1000;

const mailbox = (offer: PairOffer): PairChannel => ({ channel: offer.channel, token: offer.token });

/** A dropped connection is retried; one that stays down this long ends the pairing. */
const OFFLINE_MS = 15_000;

async function waitFor(pair: PairChannel, slot: PairSlot, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + PAIR_TIMEOUT_MS;
  let offlineSince: number | null = null;
  while (Date.now() < deadline) {
    // Not signal.throwIfAborted(): React Native's AbortSignal doesn't have it.
    if (signal.aborted) throw new Error('Pairing stopped');
    try {
      const message = await api.pairReceive(pair, slot, { signal });
      offlineSince = null;
      if (message) return message.data;
    } catch (error) {
      if (signal.aborted) throw error;
      offlineSince ??= Date.now();
      if (Date.now() - offlineSince > OFFLINE_MS) {
        throw new Error('Can’t reach Honey. Check your connection.');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('This code expired. Show a new one.');
}

export const startPairing = (direction: PairDirection = 'toBrowser'): PairOffer =>
  createPairOffer(getRandomBytes, direction);

/** Waits for the phone to scan and answer. Returns the session and the code to compare. */
export async function waitForPhone(offer: PairOffer, signal: AbortSignal): Promise<PairSession> {
  let phone: ReturnType<typeof openReveal> | undefined;
  try {
    const pair = mailbox(offer);
    const commitment = await waitFor(pair, 'commit', signal);
    await api.pairSend(pair, 'nonce', { data: encodeNonce(offer.nonce) });
    phone = openReveal(await waitFor(pair, 'reveal', signal), commitment);
    return pairSession(offer.secretKey, phone.publicKey, {
      channel: offer.channel,
      extensionKey: offer.publicKey,
      phoneKey: phone.publicKey,
      extensionNonce: offer.nonce,
      phoneNonce: phone.nonce,
      direction: offer.direction,
    });
  } finally {
    clearPairOfferSecrets(offer);
    clearPairBytes(phone?.nonce);
    clearPairBytes(phone?.publicKey);
  }
}

/** After the codes matched: waits for the phone to send the wallet, and opens it. */
export async function receiveWallet(
  offer: PairOffer,
  session: PairSession,
  signal: AbortSignal,
): Promise<PairPayload> {
  try {
    return openPayload(session.key, await waitFor(mailbox(offer), 'payload', signal));
  } finally {
    clearPairSession(session);
    clearPairOfferSecrets(offer);
  }
}

/**
 * Browser to phone, after the codes matched and the password was entered: sends this
 * browser's recovery phrase and its wallets' names, encrypted for that phone alone.
 */
export async function sendWallet(offer: PairOffer, session: PairSession) {
  try {
    const wallet = await readPrimaryWallet();
    if (!wallet) throw new Error('There’s no recovery phrase in this browser to send.');
    const data = sealPayload(session.key, { v: 1, ...wallet }, getRandomBytes);
    await api.pairSend(mailbox(offer), 'payload', { data });
  } finally {
    clearPairSession(session);
    clearPairOfferSecrets(offer);
  }
}
