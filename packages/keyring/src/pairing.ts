import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';
import { isValidMnemonic, normalizeMnemonic } from './index';

/**
 * Pairing the browser extension with the phone by scanning a QR code (version 2).
 *
 * The QR code is the one channel nobody else can tamper with: the user points their
 * own camera at their own screen. It carries the extension's one-time X25519 key and a
 * random token. Everything else goes through the server's mailbox, which anyone might
 * be watching, so the protocol assumes they are:
 *
 *   1. Phone → `commit`: sha256 of its one-time public key and a random nonce. It's
 *      bound to them before it sees anything from the extension.
 *   2. Extension → `nonce`: its own random nonce, sent only after the commitment.
 *   3. Phone → `reveal`: the public key and nonce it committed to. The extension
 *      checks them against the commitment.
 *   4. Both derive the shared key and a six-digit code from the X25519 secret, both
 *      keys and both nonces. The user checks the two screens match and confirms on both.
 *   5. Phone → `payload`: the wallet, encrypted for the extension alone.
 *
 * The same handshake also moves a wallet the other way, from the browser to the phone
 * (`d=p` in the code): the browser still shows the code and the phone still scans and
 * commits, but in step 5 the browser sends. The direction is bound into the key and the
 * six digits, so a code made for one direction can't be answered as the other.
 *
 * Someone in the middle can't make the codes match: they'd have to commit to a key
 * before seeing the extension's nonce, and the code changes completely with it, so they
 * get one blind guess in a million. Without the extension's secret key they also can't
 * read the payload. The mailbox channel is sha256(token), and every request must show
 * the token, so knowing a channel id isn't enough to write to it.
 */

const SCHEME = 'honey-pair:2';

/** Which way the wallet goes. The browser always shows the code; the phone always scans. */
export type PairDirection = 'toBrowser' | 'toPhone';
const NONCE_BYTES = 16;

const b64 = base64urlnopad;
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** The mailbox channel for a token: sha256 of its text, in hex (the server checks this). */
export const channelFor = (token: string) => bytesToHex(sha256(utf8ToBytes(token)));

/** The extension's side. The nonce stays secret until the phone has committed. */
export type PairOffer = {
  token: string;
  channel: string;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  nonce: Uint8Array;
  direction: PairDirection;
  uri: string;
};

/** The phone's side. */
export type PairAnswer = {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  nonce: Uint8Array;
  /** Base64url, sent as `commit`. */
  commitment: string;
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

/** Starts a pairing on the extension. `random` must be cryptographically secure. */
export function createPairOffer(
  random: (bytes: number) => Uint8Array,
  direction: PairDirection = 'toBrowser',
): PairOffer {
  const secretKey = random(32);
  const publicKey = x25519.getPublicKey(secretKey);
  const token = bytesToHex(random(16));
  return {
    token,
    channel: channelFor(token),
    secretKey,
    publicKey,
    nonce: random(NONCE_BYTES),
    direction,
    uri: `${SCHEME}?t=${token}&k=${b64.encode(publicKey)}${direction === 'toPhone' ? '&d=p' : ''}`,
  };
}

/** Reads a scanned QR code. Null if it isn't a (current) Honey pairing code. */
export function parsePairUri(
  uri: string,
): { token: string; channel: string; publicKey: Uint8Array; direction: PairDirection } | null {
  if (!uri.startsWith(`${SCHEME}?`)) return null;
  const params = new URLSearchParams(uri.slice(SCHEME.length + 1));
  const token = params.get('t');
  const key = params.get('k');
  const d = params.get('d');
  if (!token || !/^[0-9a-f]{32}$/.test(token) || !key || (d !== null && d !== 'p')) return null;
  const direction: PairDirection = d === 'p' ? 'toPhone' : 'toBrowser';
  try {
    const publicKey = b64.decode(key);
    return publicKey.length === 32
      ? { token, channel: channelFor(token), publicKey, direction }
      : null;
  } catch {
    return null;
  }
}

const commitTo = (publicKey: Uint8Array, nonce: Uint8Array) =>
  sha256(concat(utf8ToBytes('honey-pair-v2 commit'), publicKey, nonce));

/** The phone's one-time key and nonce, and its commitment to them. */
export function createPairAnswer(random: (bytes: number) => Uint8Array): PairAnswer {
  const secretKey = random(32);
  const publicKey = x25519.getPublicKey(secretKey);
  const nonce = random(NONCE_BYTES);
  return { secretKey, publicKey, nonce, commitment: b64.encode(commitTo(publicKey, nonce)) };
}

export const encodeNonce = (nonce: Uint8Array) => b64.encode(nonce);

export function decodeNonce(data: string): Uint8Array {
  const nonce = b64.decode(data);
  if (nonce.length !== NONCE_BYTES) throw new Error('Bad pairing nonce');
  return nonce;
}

/** The phone's `reveal` message: its public key and nonce. */
export const encodeReveal = (answer: PairAnswer) =>
  b64.encode(concat(answer.publicKey, answer.nonce));

/** Opens the phone's `reveal`; throws unless it matches what the phone committed to. */
export function openReveal(
  data: string,
  commitment: string,
): { publicKey: Uint8Array; nonce: Uint8Array } {
  const bytes = b64.decode(data);
  if (bytes.length !== 32 + NONCE_BYTES) throw new Error('Bad pairing reveal');
  const publicKey = bytes.slice(0, 32);
  const nonce = bytes.slice(32);
  const expected = b64.decode(commitment);
  const actual = commitTo(publicKey, nonce);
  let diff = expected.length ^ actual.length;
  for (let i = 0; i < actual.length; i++) diff |= (expected[i] ?? 0) ^ (actual[i] as number);
  if (diff !== 0) throw new Error('The phone’s key doesn’t match what it committed to');
  return { publicKey, nonce };
}

/**
 * The shared key and code. Each side passes its own secret key and the other's public
 * key; the transcript is the same on both, so they get the same result.
 */
export function pairSession(
  mySecretKey: Uint8Array,
  theirPublicKey: Uint8Array,
  transcript: {
    channel: string;
    extensionKey: Uint8Array;
    phoneKey: Uint8Array;
    extensionNonce: Uint8Array;
    phoneNonce: Uint8Array;
    /** Defaults to the original direction, phone to browser. */
    direction?: PairDirection;
  },
): PairSession {
  // Throws on low-order keys (an all-zero shared secret).
  const shared = x25519.getSharedSecret(mySecretKey, theirPublicKey);
  const bound = concat(
    transcript.extensionKey,
    transcript.phoneKey,
    transcript.extensionNonce,
    transcript.phoneNonce,
  );
  // Browser-to-phone gets its own labels; phone-to-browser keeps the original ones.
  const prefix = transcript.direction === 'toPhone' ? 'honey-pair-v2 to-phone' : 'honey-pair-v2';
  const derive = (label: string, length: number) =>
    hkdf(sha256, shared, hexToBytes(transcript.channel), concat(utf8ToBytes(label), bound), length);
  const n = new DataView(derive(`${prefix} code`, 4).buffer).getUint32(0);
  return {
    key: derive(`${prefix} key`, 32),
    code: String(n % 1_000_000).padStart(6, '0'),
  };
}

const AAD = utf8ToBytes('honey-pair-v2 payload');

export function sealPayload(
  key: Uint8Array,
  payload: PairPayload,
  random: (bytes: number) => Uint8Array,
): string {
  const nonce = random(24);
  const sealed = xchacha20poly1305(key, nonce, AAD).encrypt(utf8ToBytes(JSON.stringify(payload)));
  return b64.encode(concat(nonce, sealed));
}

/** Throws if the data was made with another key or changed on the way. */
export function openPayload(key: Uint8Array, data: string): PairPayload {
  const bytes = b64.decode(data);
  const plain = xchacha20poly1305(key, bytes.subarray(0, 24), AAD).decrypt(bytes.subarray(24));
  const payload = JSON.parse(new TextDecoder().decode(plain)) as PairPayload;
  if (payload.v !== 1 || !isValidMnemonic(payload.mnemonic)) throw new Error('Bad pairing payload');
  return { ...payload, mnemonic: normalizeMnemonic(payload.mnemonic) };
}
