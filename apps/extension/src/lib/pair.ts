import type { PairChannel, PairSlot } from '@honey-wallet/api-client';
import {
  createPairOffer,
  encodeNonce,
  openPayload,
  openReveal,
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

const mailbox = (offer: PairOffer): PairChannel => ({
  channel: offer.channel,
  token: offer.token,
});

/** Polls the mailbox until the phone's message arrives. */
async function waitFor(pair: PairChannel, slot: PairSlot, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const message = await api.pairReceive(pair, slot, { signal });
    if (message) return message.data;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('Pairing timed out. Start again and scan the new code.');
}

export const startPairing = (): PairOffer => createPairOffer(random);

/**
 * Runs the handshake (see packages/keyring/src/pairing.ts): wait for the phone's
 * commitment, send our nonce, then check its reveal against the commitment. Returns
 * the shared key and the code to compare.
 */
export async function waitForPhone(offer: PairOffer, signal: AbortSignal): Promise<PairSession> {
  const pair = mailbox(offer);
  const commitment = await waitFor(pair, 'commit', signal);
  await api.pairSend(pair, 'nonce', { data: encodeNonce(offer.nonce) });
  const phone = openReveal(await waitFor(pair, 'reveal', signal), commitment);
  return pairSession(offer.secretKey, phone.publicKey, {
    channel: offer.channel,
    extensionKey: offer.publicKey,
    phoneKey: phone.publicKey,
    extensionNonce: offer.nonce,
    phoneNonce: phone.nonce,
  });
}

/** After the user confirmed the codes match: waits for the wallet and opens it. */
export async function receiveWallet(
  offer: PairOffer,
  session: PairSession,
  signal: AbortSignal,
): Promise<PairPayload> {
  return openPayload(session.key, await waitFor(mailbox(offer), 'payload', signal));
}
