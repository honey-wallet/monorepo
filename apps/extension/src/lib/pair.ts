import type { PairSlot } from '@honey-wallet/api-client';
import {
  createPairOffer,
  decodeKey,
  openPayload,
  type PairOffer,
  type PairPayload,
  type PairSession,
  pairSession,
} from '@honey-wallet/keyring';
import { api } from './api';
import { random } from './vault';

/** The mailbox keeps messages for five minutes; stop waiting after that. */
const TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 1000;

/** Polls the mailbox until the phone's message arrives. */
async function waitFor(channel: string, slot: PairSlot, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const message = await api.pairReceive(channel, slot, { signal });
    if (message) return message.data;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('Pairing timed out. Start again and scan the new code.');
}

export const startPairing = (): PairOffer => createPairOffer(random);

/** Waits for the phone to scan the code; returns the shared key and the code to compare. */
export async function waitForPhone(offer: PairOffer, signal: AbortSignal): Promise<PairSession> {
  const phoneKey = decodeKey(await waitFor(offer.channel, 'hello', signal));
  return pairSession(offer.secretKey, phoneKey, offer.channel, offer.publicKey, phoneKey);
}

/** After the user confirmed the codes match: waits for the wallet and opens it. */
export async function receiveWallet(
  offer: PairOffer,
  session: PairSession,
  signal: AbortSignal,
): Promise<PairPayload> {
  return openPayload(session.key, await waitFor(offer.channel, 'payload', signal));
}
