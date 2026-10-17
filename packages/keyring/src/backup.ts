import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { isValidMnemonic, normalizeMnemonic } from './index';

/**
 * A recovery phrase encrypted with a password the user picks, for saving to iCloud
 * Drive or Google Drive. Whoever holds the file still needs the password, and the
 * password never leaves the device, so neither the cloud provider nor Honey can read it.
 *
 * scrypt stretches the password into the key, so each guess is expensive;
 * XChaCha20-Poly1305 encrypts and authenticates (a wrong password or an edited file
 * fails to open rather than giving garbage). The parameters are stored in the file, so
 * they can be raised later without breaking old backups.
 */

export type Backup = {
  app: 'honey';
  version: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: 'xchacha20-poly1305'; nonce: string };
  data: string;
  createdAt: string;
};

/** 2^16 × 8 × 1: ~64 MB of work per guess; about a second on a recent phone. */
const SCRYPT = { N: 2 ** 16, r: 8, p: 1 } as const;

export const MIN_PASSWORD_LENGTH = 8;

/** Bound to the format so a backup can't be relabelled as another one and still open. */
const AAD = utf8ToBytes('honey-backup-v1');

const keyFor = (password: string, salt: Uint8Array, kdf: { N: number; r: number; p: number }) =>
  scryptAsync(utf8ToBytes(password.normalize('NFKC')), salt, {
    ...kdf,
    dkLen: 32,
    maxmem: 72 * 1024 * 1024,
  });

export async function encryptBackup(
  phrase: string,
  password: string,
  random: (bytes: number) => Uint8Array,
): Promise<Backup> {
  if (!isValidMnemonic(phrase)) throw new Error('Not a valid recovery phrase');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = random(16);
  const nonce = random(24);
  const key = await keyFor(password, salt, SCRYPT);
  const plain = utf8ToBytes(JSON.stringify({ mnemonic: normalizeMnemonic(phrase) }));
  return {
    app: 'honey',
    version: 1,
    kdf: { name: 'scrypt', ...SCRYPT, salt: base64.encode(salt) },
    cipher: { name: 'xchacha20-poly1305', nonce: base64.encode(nonce) },
    data: base64.encode(xchacha20poly1305(key, nonce, AAD).encrypt(plain)),
    createdAt: new Date().toISOString(),
  };
}

/** True when `value` looks like a Honey backup file (before trying a password). */
export function isBackup(value: unknown): value is Backup {
  const b = value as Backup;
  return (
    typeof b === 'object' &&
    b !== null &&
    b.app === 'honey' &&
    b.version === 1 &&
    b.kdf?.name === 'scrypt' &&
    b.cipher?.name === 'xchacha20-poly1305' &&
    typeof b.data === 'string' &&
    b.data.length <= 2048 &&
    typeof b.kdf.salt === 'string' &&
    b.kdf.salt.length === 24 &&
    typeof b.cipher.nonce === 'string' &&
    b.cipher.nonce.length === 32
  );
}

/** The phrase inside a backup. Throws `WrongPasswordError` if the password doesn't open it. */
export async function decryptBackup(backup: Backup, password: string): Promise<string> {
  if (!isBackup(backup)) throw new Error('Unsupported backup');
  const { N, r, p, salt } = backup.kdf;
  // Refuse absurd parameters from a tampered file rather than hang the app.
  if (
    ![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0) ||
    N < 2 ||
    N > 2 ** 16 ||
    (N & (N - 1)) !== 0 ||
    r > 8 ||
    p > 4 ||
    N * r * p > 2 ** 19 ||
    128 * r * (N + p + 1) > 72 * 1024 * 1024
  ) {
    throw new Error('Unsupported backup');
  }
  if (base64.decode(salt).length !== 16 || base64.decode(backup.cipher.nonce).length !== 24) {
    throw new Error('Unsupported backup');
  }
  const key = await keyFor(password, base64.decode(salt), { N, r, p });
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(key, base64.decode(backup.cipher.nonce), AAD).decrypt(
      base64.decode(backup.data),
    );
  } catch {
    throw new WrongPasswordError();
  }
  const { mnemonic } = JSON.parse(new TextDecoder().decode(plain)) as { mnemonic: string };
  if (!isValidMnemonic(mnemonic)) throw new Error('Backup is damaged');
  return mnemonic;
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password');
    this.name = 'WrongPasswordError';
  }
}
