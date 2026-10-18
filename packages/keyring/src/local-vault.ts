import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { MIN_PASSWORD_LENGTH, WrongPasswordError } from './backup';
import { passwordKey } from './kdf';

/**
 * Secrets kept by Honey in a browser (the extension), where there's no Keychain.
 *
 * A random 32-byte data key encrypts the secrets; the user's password, stretched with
 * scrypt, encrypts the data key. Unlocking runs scrypt once and keeps only the data key
 * in memory, so reading and writing secrets afterwards is fast, and changing the
 * password re-wraps one key instead of every secret. XChaCha20-Poly1305 authenticates
 * both layers, so a wrong password or an edited record fails rather than giving garbage.
 */

export type LockedKey = {
  app: 'honey-local';
  version: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  nonce: string;
  data: string;
};

/** Same cost as a backup: about a second per guess. */
const SCRYPT = { N: 2 ** 16, r: 8, p: 1 } as const;
const KEY_AAD = utf8ToBytes('honey-local-v1 key');
const DATA_AAD = utf8ToBytes('honey-local-v1 data');

async function wrap(
  key: Uint8Array,
  password: string,
  random: (bytes: number) => Uint8Array,
): Promise<LockedKey> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = random(16);
  const nonce = random(24);
  const wrapping = await passwordKey(password, salt, SCRYPT);
  return {
    app: 'honey-local',
    version: 1,
    kdf: { name: 'scrypt', ...SCRYPT, salt: base64.encode(salt) },
    nonce: base64.encode(nonce),
    data: base64.encode(xchacha20poly1305(wrapping, nonce, KEY_AAD).encrypt(key)),
  };
}

/** A new vault: the data key to use now, and its password-locked form to store. */
export async function createLocalVault(
  password: string,
  random: (bytes: number) => Uint8Array,
): Promise<{ key: Uint8Array; locked: LockedKey }> {
  const key = random(32);
  return { key, locked: await wrap(key, password, random) };
}

/** The same data key under a new password. */
export const rewrapLocalVault = wrap;

/** The data key, or `WrongPasswordError`. Refuses tampered or unsupported records. */
export async function unlockLocalVault(locked: LockedKey, password: string): Promise<Uint8Array> {
  const { N, r, p, salt } = locked?.kdf ?? ({} as LockedKey['kdf']);
  if (
    locked?.app !== 'honey-local' ||
    locked.version !== 1 ||
    locked.kdf.name !== 'scrypt' ||
    ![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0) ||
    N < 2 ||
    N > 2 ** 16 ||
    (N & (N - 1)) !== 0 ||
    r > 8 ||
    p > 4 ||
    base64.decode(salt).length !== 16 ||
    base64.decode(locked.nonce).length !== 24
  ) {
    throw new Error('Unsupported vault');
  }
  const wrapping = await passwordKey(password, base64.decode(salt), { N, r, p });
  let key: Uint8Array;
  try {
    key = xchacha20poly1305(wrapping, base64.decode(locked.nonce), KEY_AAD).decrypt(
      base64.decode(locked.data),
    );
  } catch {
    throw new WrongPasswordError();
  }
  if (key.length !== 32) throw new Error('Unsupported vault');
  return key;
}

/** Encrypts `text` with the data key: base64 of nonce then ciphertext. */
export function sealWithKey(
  key: Uint8Array,
  text: string,
  random: (bytes: number) => Uint8Array,
): string {
  const nonce = random(24);
  const sealed = xchacha20poly1305(key, nonce, DATA_AAD).encrypt(utf8ToBytes(text));
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce);
  out.set(sealed, nonce.length);
  return base64.encode(out);
}

/** The text `sealWithKey` made. Throws for another key or edited data. */
export function openWithKey(key: Uint8Array, data: string): string {
  const bytes = base64.decode(data);
  if (bytes.length < 24 + 16) throw new Error('Damaged record');
  const plain = xchacha20poly1305(key, bytes.subarray(0, 24), DATA_AAD).decrypt(bytes.subarray(24));
  return new TextDecoder().decode(plain);
}
