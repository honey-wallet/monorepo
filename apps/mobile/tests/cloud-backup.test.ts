import { beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  share: vi.fn(),
  pick: vi.fn(),
  text: vi.fn(),
  size: 100,
}));
vi.mock('@/lib/auth', () => ({ confirmOwner: api.auth }));
vi.mock('@/lib/vault', () => ({ readPrimaryMnemonic: api.read }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn() }));
vi.mock('expo-sharing', () => ({ shareAsync: api.share }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: api.pick }));
vi.mock('@honey-wallet/keyring', () => ({
  encryptBackup: api.encrypt,
  decryptBackup: api.decrypt,
  isBackup: (v: unknown) => !!v,
}));
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'cache' },
  File: class {
    uri = 'file';
    exists = true;
    size = api.size;
    create() {}
    write() {}
    delete() {}
    text = api.text;
  },
}));

import { backupPrefs, pickBackupFile, saveBackupFile } from '@/lib/cloud-backup';

beforeEach(() => {
  vi.resetAllMocks();
  api.size = 100;
  api.auth.mockResolvedValue(true);
  api.read.mockResolvedValue('primary phrase');
  api.encrypt.mockResolvedValue({ app: 'honey' });
  api.text.mockResolvedValue('{"app":"honey"}');
  api.decrypt.mockResolvedValue('primary phrase');
  api.pick.mockResolvedValue({ canceled: false, assets: [{ uri: 'saved-copy' }] });
  backupPrefs.set({ provider: 'icloud', savedTo: null });
});
it('denial never reads, encrypts or shares secrets', async () => {
  api.auth.mockResolvedValue(false);
  expect(await saveBackupFile('password', 'icloud')).toBe(false);
  for (const method of [api.read, api.encrypt, api.share]) expect(method).not.toHaveBeenCalled();
});
it('a dismissed share sheet without verified copy is not a backup', async () => {
  api.pick.mockResolvedValue({ canceled: true });
  expect(await saveBackupFile('password', 'icloud')).toBe(false);
  expect(backupPrefs.get().savedTo).toBeNull();
});
it('verifies a saved copy against the exported phrase', async () => {
  expect(await saveBackupFile('password', 'icloud')).toBe(true);
  expect(backupPrefs.get().savedTo).toBe('icloud');
  expect(api.auth.mock.invocationCallOrder[0]).toBeLessThan(api.read.mock.invocationCallOrder[0]);
});
it('does not accept a different wallet backup', async () => {
  api.decrypt.mockResolvedValue('other phrase');
  await expect(saveBackupFile('password', 'icloud')).rejects.toThrow('different recovery phrase');
  expect(backupPrefs.get().savedTo).toBeNull();
});
it('refuses oversized files before reading them', async () => {
  api.size = 100_000_000;
  await expect(pickBackupFile()).rejects.toThrow();
  expect(api.text).not.toHaveBeenCalled();
});
