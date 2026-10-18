import { describe, expect, it } from 'vitest';
import { WrongPasswordError } from './backup';
import {
  createLocalVault,
  openWithKey,
  rewrapLocalVault,
  sealWithKey,
  unlockLocalVault,
} from './local-vault';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

describe('local vault', () => {
  it('unlocks the same data key with the password', async () => {
    const { key, locked } = await createLocalVault('correct horse', random);
    const stored = JSON.parse(JSON.stringify(locked));
    expect(await unlockLocalVault(stored, 'correct horse')).toEqual(key);
  });

  it('rejects the wrong password', async () => {
    const { locked } = await createLocalVault('correct horse', random);
    await expect(unlockLocalVault(locked, 'correct horsf')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('refuses short passwords and tampered records', async () => {
    await expect(createLocalVault('short', random)).rejects.toThrow(/at least/);
    const { locked } = await createLocalVault('correct horse', random);
    await expect(
      unlockLocalVault({ ...locked, kdf: { ...locked.kdf, N: 2 ** 20 } }, 'correct horse'),
    ).rejects.toThrow('Unsupported vault');
    const data = locked.data.startsWith('A')
      ? `B${locked.data.slice(1)}`
      : `A${locked.data.slice(1)}`;
    await expect(unlockLocalVault({ ...locked, data }, 'correct horse')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('changes the password without changing the data key', async () => {
    const { key, locked } = await createLocalVault('correct horse', random);
    const sealed = sealWithKey(key, 'secret', random);
    const relocked = await rewrapLocalVault(key, 'battery staple', random);
    await expect(unlockLocalVault(relocked, 'correct horse')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(openWithKey(await unlockLocalVault(relocked, 'battery staple'), sealed)).toBe('secret');
    expect(locked.data).not.toBe(relocked.data);
  });

  it('seals text so only the data key opens it, and edits fail', () => {
    const key = random(32);
    const sealed = sealWithKey(key, 'abandon about', random);
    expect(sealed).not.toContain('abandon');
    expect(sealWithKey(key, 'abandon about', random)).not.toBe(sealed);
    expect(openWithKey(key, sealed)).toBe('abandon about');
    expect(() => openWithKey(random(32), sealed)).toThrow();
    const edited = sealed.startsWith('A') ? `B${sealed.slice(1)}` : `A${sealed.slice(1)}`;
    expect(() => openWithKey(key, edited)).toThrow();
  });
});
