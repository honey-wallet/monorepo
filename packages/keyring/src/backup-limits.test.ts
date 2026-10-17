import { beforeEach, expect, it, vi } from 'vitest';

const derive = vi.hoisted(() => vi.fn());
vi.mock('@noble/hashes/scrypt.js', () => ({ scryptAsync: derive }));

import { type Backup, decryptBackup } from './backup';

const backup: Backup = {
  app: 'honey',
  version: 1,
  createdAt: '2026-10-17',
  kdf: { name: 'scrypt', N: 65536, r: 8, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' },
  cipher: { name: 'xchacha20-poly1305', nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  data: 'AAAAAAAAAAAAAAAAAAAAAA==',
};
beforeEach(() => derive.mockReset());
it.each([
  { N: 2 ** 20 },
  { r: 16 },
  { p: 4 },
  { N: 65535 },
  { N: 0 },
  { N: -1 },
  { N: 1.5 },
  { r: 0 },
  { p: NaN },
  { N: Infinity },
])('rejects excessive or malformed KDF before allocation: %j', async (kdf) => {
  await expect(
    decryptBackup({ ...backup, kdf: { ...backup.kdf, ...kdf } }, 'password'),
  ).rejects.toThrow('Unsupported backup');
  expect(derive).not.toHaveBeenCalled();
});
it('rejects excessive ciphertext before deriving', async () => {
  await expect(decryptBackup({ ...backup, data: 'A'.repeat(3000) }, 'password')).rejects.toThrow(
    'Unsupported backup',
  );
  expect(derive).not.toHaveBeenCalled();
});
