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
  importPairedWallet,
  importPrivateKey,
  loadAccounts,
  privateKeyOf,
  readPrimaryMnemonic,
  startWithMnemonic,
  upgradeNearAccounts,
} from '@/lib/vault';

const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
beforeEach(() => storage.clear());
it('rejects malformed paired account metadata before persisting the paired phrase', async () => {
  await expect(
    importPairedWallet({
      mnemonic: phrase,
      accounts: [{ index: -1, label: 'Invalid' }],
    }),
  ).rejects.toThrow('Paired wallet account list is invalid');
  expect(storage.size).toBe(0);
});

it('imports a valid paired wallet and preserves its account label', async () => {
  const imported = await importPairedWallet({
    mnemonic: phrase,
    accounts: [{ index: 0, label: 'Phone wallet' }],
  });
  expect(imported).toHaveLength(1);
  expect(imported[0]?.label).toBe('Phone wallet');
});

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

it('adds NEAR to legacy phrase wallets, preserving existing addresses and raw EVM keys', async () => {
  const account = await startWithMnemonic(phrase, 'Primary');
  const imported = await importPrivateKey('1'.repeat(64), 'EVM');
  const expected = account.addresses.near;
  const { near: _near, ...legacy } = account.addresses;
  storage.set('honey.accounts', JSON.stringify([{ ...account, addresses: legacy }, imported]));
  await upgradeNearAccounts();
  await upgradeNearAccounts();
  const accounts = await loadAccounts();
  expect(accounts[0]?.addresses).toEqual({ ...legacy, near: expected });
  expect(accounts[1]?.addresses).toEqual(imported.addresses);
  expect((await privateKeyOf(account.id, 'near')).length).toBe(32);
  await expect(privateKeyOf(imported.id, 'near')).rejects.toThrow('only works on EVM');
});

it('drops cached Bitcoin addresses from accounts saved before Bitcoin was removed', async () => {
  const account = await startWithMnemonic(phrase, 'Primary');
  const legacy = { ...account, addresses: { ...account.addresses, bitcoin: 'bc1qlegacy' } };
  storage.set('honey.accounts', JSON.stringify([legacy]));
  expect((await loadAccounts())[0]?.addresses).toEqual(account.addresses);
  await upgradeNearAccounts();
  expect(storage.get('honey.accounts')).not.toContain('bitcoin');
  expect((await loadAccounts())[0]).toEqual(account);
});

it('creates a burner with recoverable keys on a distinct derivation index', async () => {
  const main = await startWithMnemonic(phrase, 'Main');
  const burner = await createAccount('Burner 1', true);
  expect(burner.burner).toBe(true);
  expect(burner.addresses.evm).not.toBe(main.addresses.evm);
  expect((await privateKeyOf(burner.id, 'evm')).length).toBe(32);
  expect((await loadAccounts()).find((a) => a.id === burner.id)?.burner).toBe(true);
});
