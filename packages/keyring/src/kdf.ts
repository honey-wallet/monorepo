import { scryptAsync } from '@noble/hashes/scrypt.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Stretches a password into a 32-byte key with scrypt. Shared by backups and the
 * browser's local vault so there's one place that turns passwords into keys.
 */
export const passwordKey = (
  password: string,
  salt: Uint8Array,
  kdf: { N: number; r: number; p: number },
) =>
  scryptAsync(utf8ToBytes(password.normalize('NFKC')), salt, {
    ...kdf,
    dkLen: 32,
    maxmem: 72 * 1024 * 1024,
  });
