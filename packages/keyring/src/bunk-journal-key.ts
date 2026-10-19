import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

// These versioned domains are persisted-data compatibility constants.
const SALT = utf8ToBytes('honey:bunk:journal:extract:v1');
const INFO = utf8ToBytes('honey:bunk:journal:encryption:v1');

/** Derive the local journal encryption key from the unlocked 64-byte BIP39 seed.
 * Stable across password changes, wallet labels, networks and phrase restores.
 * This is separate from every signing path. Never use a password as the input.
 * The caller owns/wipes both buffers; the seed is not modified. The encrypted
 * store copies this key, so wipe the returned buffer after creating that store.
 * Readable history does not authorize signing: backup import still requires the
 * v3 coordinator's fresh-generation restore, even when old journal rows survive. */
export function deriveBunkJournalEncryptionKey(seed: Uint8Array): Uint8Array {
  if (!(seed instanceof Uint8Array) || seed.length !== 64)
    throw new Error('Bunk journal encryption requires a 64-byte BIP39 seed');
  const prk = extract(sha256, seed, SALT);
  try {
    return expand(sha256, prk, INFO, 32);
  } finally {
    prk.fill(0);
  }
}
