import { beforeEach, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => ({
  async: new Map<string, string>(),
  secure: new Map<string, string>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => stores.async.get(key) ?? null,
    setItem: async (key: string, value: string) => void stores.async.set(key, value),
    removeItem: async (key: string) => void stores.async.delete(key),
  },
}));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => stores.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void stores.secure.set(key, value),
  deleteItemAsync: async (key: string) => void stores.secure.delete(key),
}));
vi.mock('expo-crypto', async () => {
  const { randomBytes } = await import('node:crypto');
  return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});

import { encryptedSessionStorage as storage } from '@/lib/session-storage';

const KEY = 'sb-project-auth-token';
const SESSION = JSON.stringify({ access_token: 'a'.repeat(1200), refresh_token: 'r' });

beforeEach(() => {
  stores.async.clear();
  stores.secure.clear();
});

it('keeps the session encrypted in AsyncStorage and only its key in SecureStore', async () => {
  await storage.setItem(KEY, SESSION);
  expect(await storage.getItem(KEY)).toBe(SESSION);
  const sealed = stores.async.get(KEY) ?? '';
  expect(sealed).not.toContain('access_token');
  expect([...stores.secure.values()]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  for (const value of stores.secure.values()) expect(value.length).toBeLessThan(2048);
});

it('reads a session it can’t decrypt as signed out and clears it', async () => {
  await storage.setItem(KEY, SESSION);
  stores.secure.clear(); // a phone restored from a backup: AsyncStorage came back, the key didn't
  expect(await storage.getItem(KEY)).toBeNull();
  expect(stores.async.has(KEY)).toBe(false);

  await storage.setItem(KEY, SESSION);
  const sealed = stores.async.get(KEY) ?? '';
  stores.async.set(KEY, `${sealed.slice(0, -2)}${sealed.endsWith('00') ? '11' : '00'}`);
  expect(await storage.getItem(KEY)).toBeNull();
});

it('binds a sealed value to its key and removes both halves', async () => {
  await storage.setItem(KEY, SESSION);
  await storage.setItem(`${KEY}-code-verifier`, 'verifier');
  stores.async.set(`${KEY}-code-verifier`, stores.async.get(KEY) ?? '');
  expect(await storage.getItem(`${KEY}-code-verifier`)).toBeNull();
  await storage.removeItem(KEY);
  expect(stores.async.size + stores.secure.size).toBe(0);
});
