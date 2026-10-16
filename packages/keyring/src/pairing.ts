import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';
import { isValidMnemonic, normalizeMnemonic } from './index';

/**
 * Pairing the browser extension with the phone by scanning a QR code.
 *
 *   1. The extension makes a one-time X25519 key and a random channel id, and shows
 *      both as a QR code (`honey-pair:1?c=…&k=…`).
 *   2. The phone scans it, makes its own one-time key and leaves its public key in
 *      the server's mailbox (`hello`). Both sides now derive the same secret.
 *   3. Both screens show a six-digit code derived from that secret and both public
 *      keys. The user checks they match and confirms on both; a mismatch means
 *      someone swapped a key in between, and pairing stops.
 *   4. The phone encrypts the wallet with the shared key and leaves it in the mailbox
 *      (`payload`). Only the extension can open it.
 *
 * The server only ever holds public keys and ciphertext, for five minutes.
 */

const SCHEME = 'honey-pair:1';

/** Shown on the extension; holds the secret half of its one-time key. */
export type PairOffer = {
  channel: string;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  uri: string;
};

/** What the wallet sends across: the phrase, and how the user named its accounts. */
export type PairPayload = {
  v: 1;
  mnemonic: string;
  accounts: { index: number; label: string }[];
};

export type PairSession = {
  /** Encrypts and decrypts the payload. */
  key: Uint8Array;
  /** The six digits both screens show, e.g. "042917". */
  code: string;
};

const b64 = base64urlnopad;

/** Starts a pairing on the extension. `random` must be cryptographically secure. */
export function createPairOffer(random: (bytes: number) => Uint8Array): PairOffer {
  const secretKey = random(32);
  const publicKey = x25519.getPublicKey(secretKey);
  const channel = b64.encode(random(16));
  return {
    channel,
    secretKey,
    publicKey,
    uri: `${SCHEME}?c=${channel}&k=${b64.encode(publicKey)}`,
  };
}

/** Reads a scanned QR code. Null if it isn't a Honey pairing code. */
export function parsePairUri(uri: string): { channel: string; publicKey: Uint8Array } | null {
  if (!uri.startsWith(`${SCHEME}?`)) return null;
  const params = new URLSearchParams(uri.slice(SCHEME.length + 1));
  const channel = params.get('c');
  const key = params.get('k');
  if (!channel || !/^[A-Za-z0-9_-]{16,64}$/.test(channel) || !key) return null;
  try {
    const publicKey = b64.decode(key);
    return publicKey.length === 32 ? { channel, publicKey } : null;
  } catch {
    return null;
  }
}

/** The phone's side: its one-time key, to send as `hello`. */
export function createPairAnswer(random: (bytes: number) => Uint8Array) {
  const secretKey = random(32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/**
 * The shared key and code. Both sides pass the same channel and the two public keys
 * in the same order (the extension's first), so they get the same result.
 */
export function pairSession(
  mySecretKey: Uint8Array,
  theirPublicKey: Uint8Array,
  channel: string,
  extensionPublicKey: Uint8Array,
  phonePublicKey: Uint8Array,
): PairSession {
  // Throws on low-order keys (an all-zero shared secret).
  const shared = x25519.getSharedSecret(mySecretKey, theirPublicKey);
  const salt = b64.decode(channel);
  const transcript = new Uint8Array([...extensionPublicKey, ...phonePublicKey]);
  const derive = (label: string, length: number) =>
    hkdf(sha256, shared, salt, new Uint8Array([...utf8ToBytes(label), ...transcript]), length);
  const n = new DataView(derive('honey-pair-v1 code', 4).buffer).getUint32(0);
  return {
    key: derive('honey-pair-v1 key', 32),
    code: String(n % 1_000_000).padStart(6, '0'),
  };
}

export const encodeKey = (key: Uint8Array) => b64.encode(key);
export const decodeKey = (data: string) => b64.decode(data);

const AAD = utf8ToBytes('honey-pair-v1 payload');

export function sealPayload(
  key: Uint8Array,
  payload: PairPayload,
  random: (bytes: number) => Uint8Array,
): string {
  const nonce = random(24);
  const sealed = xchacha20poly1305(key, nonce, AAD).encrypt(utf8ToBytes(JSON.stringify(payload)));
  return b64.encode(new Uint8Array([...nonce, ...sealed]));
}

/** Throws if the data was made with another key or changed on the way. */
export function openPayload(key: Uint8Array, data: string): PairPayload {
  const bytes = b64.decode(data);
  const plain = xchacha20poly1305(key, bytes.subarray(0, 24), AAD).decrypt(bytes.subarray(24));
  const payload = JSON.parse(new TextDecoder().decode(plain)) as PairPayload;
  if (payload.v !== 1 || !isValidMnemonic(payload.mnemonic)) throw new Error('Bad pairing payload');
  return { ...payload, mnemonic: normalizeMnemonic(payload.mnemonic) };
}
