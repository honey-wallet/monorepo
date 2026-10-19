import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup, isBackup, WrongPasswordError } from './backup';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

describe('backups', () => {
  it('round-trips a phrase through a password', async () => {
    const backup = await encryptBackup(PHRASE, 'correct horse', random);
    expect(isBackup(JSON.parse(JSON.stringify(backup)))).toBe(true);
    expect(JSON.stringify(backup)).not.toContain('abandon');
    expect(await decryptBackup(backup, 'correct horse')).toBe(PHRASE);
  });

  it('rejects the wrong password', async () => {
    const backup = await encryptBackup(PHRASE, 'correct horse', random);
    await expect(decryptBackup(backup, 'correct horsf')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('rejects an edited file', async () => {
    const backup = await encryptBackup(PHRASE, 'correct horse', random);
    const data = backup.data.startsWith('A')
      ? `B${backup.data.slice(1)}`
      : `A${backup.data.slice(1)}`;
    await expect(decryptBackup({ ...backup, data }, 'correct horse')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('refuses short passwords and invalid phrases', async () => {
    await expect(encryptBackup(PHRASE, 'short', random)).rejects.toThrow();
    await expect(encryptBackup('abandon about', 'correct horse', random)).rejects.toThrow();
  });

  it('refuses a file that asks for absurd work', async () => {
    const backup = await encryptBackup(PHRASE, 'correct horse', random);
    await expect(
      decryptBackup({ ...backup, kdf: { ...backup.kdf, N: 2 ** 30 } }, 'correct horse'),
    ).rejects.toThrow('Unsupported backup');
  });

  it('uses a fresh salt and nonce each time', async () => {
    const [a, b] = await Promise.all([
      encryptBackup(PHRASE, 'correct horse', random),
      encryptBackup(PHRASE, 'correct horse', random),
    ]);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.data).not.toBe(b.data);
  }, 15_000);
});
