import { beforeEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device',
  getItemAsync: async (key: string) => storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    storage.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    storage.delete(key);
  },
}));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
}));

import {
  createAccount,
  eraseVault,
  importPrivateKey,
  loadAccounts,
  readPrimaryMnemonic,
  startWithMnemonic,
} from '@/lib/vault';

const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
beforeEach(() => storage.clear());
it('requires recovery confirmation for independently imported secrets before deleting anything', async () => {
  const primary = await startWithMnemonic(phrase, 'Primary');
  const imported = await importPrivateKey('1'.repeat(64), 'Imported key');
  await expect(eraseVault([primary.id])).rejects.toThrow('every wallet');
  expect(await readPrimaryMnemonic()).toBe(phrase);
  expect((await loadAccounts()).map((a) => a.id)).toEqual([primary.id, imported.id]);
  await eraseVault([primary.id, imported.id]);
  expect(storage.size).toBe(0);
});
it('catches accounts added after the confirmation screen loaded', async () => {
  const first = await startWithMnemonic(phrase, 'Primary');
  await createAccount('Second');
  await expect(eraseVault([first.id])).rejects.toThrow('every wallet');
  expect((await loadAccounts()).length).toBe(2);
});
