import {
  createLocalVault,
  type LockedKey,
  openWithKey,
  sealWithKey,
  unlockLocalVault,
  WrongPasswordError,
} from '@honey-wallet/keyring';
import { createStore } from '@/lib/store';

/**
 * Secrets in a browser (Honey for Chrome), where there's no Keychain.
 *
 * Everything the phone keeps in the Keychain is kept here as one encrypted record in
 * `chrome.storage.local`: a random data key encrypts the secrets, and the user's
 * password locks the data key (see `local-vault.ts` in the keyring). Unlocking keeps
 * only the data key, in `chrome.storage.session`, which lives in memory and is cleared
 * when the browser closes, so the popup doesn't ask for the password each time it
 * opens. After AUTO_LOCK_MS without use it locks again.
 *
 * Outside the extension (a normal tab while developing) `localStorage` and
 * `sessionStorage` stand in for the two Chrome areas.
 */

export const AUTO_LOCK_MS = 15 * 60 * 1000;

const VAULT = 'honey.vault';
const SESSION = 'honey.session';

type VaultRecord = { locked: LockedKey; items: string };
type Session = { key: string; at: number };
type Area = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
};

/** The two `chrome.storage` areas used here (typed locally; the app has no Chrome types). */
type ChromeArea = {
  get(key: string): Promise<{ [key: string]: unknown }>;
  set(items: { [key: string]: unknown }): Promise<void>;
  remove(key: string): Promise<void>;
};
const chromeStorage = (
  globalThis as { chrome?: { storage?: { local?: ChromeArea; session?: ChromeArea } } }
).chrome?.storage;

function chromeArea(area: ChromeArea): Area {
  return {
    get: async <T>(key: string) => (await area.get(key))[key] as T | undefined,
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}

function webArea(storage: Storage): Area {
  return {
    get: async <T>(key: string) => {
      const raw = storage.getItem(key);
      return raw == null ? undefined : (JSON.parse(raw) as T);
    },
    set: async (key, value) => storage.setItem(key, JSON.stringify(value)),
    remove: async (key) => storage.removeItem(key),
  };
}

const local: Area = chromeStorage?.local ? chromeArea(chromeStorage.local) : webArea(localStorage);
const session: Area = chromeStorage?.session
  ? chromeArea(chromeStorage.session)
  : webArea(sessionStorage);

const random = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

export class VaultLockedError extends Error {
  constructor() {
    super('Honey is locked');
    this.name = 'VaultLockedError';
  }
}

export type VaultStatus = 'loading' | 'new' | 'locked' | 'unlocked';

/** The vault's state, for the lock screen. */
export const vaultStatus = createStore<VaultStatus>('loading');

let timer: ReturnType<typeof setTimeout> | undefined;

async function lock() {
  clearTimeout(timer);
  await session.remove(SESSION);
  vaultStatus.set((await local.get<VaultRecord>(VAULT)) ? 'locked' : 'new');
}

/** Restarts the idle timer; every read and write counts as use. */
async function touch(key: Uint8Array) {
  await session.set(SESSION, { key: toHex(key), at: Date.now() } satisfies Session);
  clearTimeout(timer);
  timer = setTimeout(() => void lock(), AUTO_LOCK_MS);
}

/** The data key while unlocked and recently used; null (and locks) otherwise. */
async function currentKey(): Promise<Uint8Array | null> {
  const state = await session.get<Session>(SESSION);
  if (!state) return null;
  if (Date.now() - state.at >= AUTO_LOCK_MS) {
    await lock();
    return null;
  }
  const key = fromHex(state.key);
  await touch(key);
  return key;
}

async function readItems(key: Uint8Array): Promise<{ [name: string]: string }> {
  const record = await local.get<VaultRecord>(VAULT);
  if (!record) throw new VaultLockedError();
  return JSON.parse(openWithKey(key, record.items));
}

async function unlockedItems() {
  const key = await currentKey();
  if (!key) {
    vaultStatus.set((await local.get<VaultRecord>(VAULT)) ? 'locked' : 'new');
    throw new VaultLockedError();
  }
  return { key, items: await readItems(key) };
}

// Writes run one at a time so two quick changes can't overwrite each other.
let queue: Promise<unknown> = Promise.resolve();
function update(change: (items: { [name: string]: string }) => void) {
  const run = queue.then(async () => {
    const { key, items } = await unlockedItems();
    change(items);
    const record = await local.get<VaultRecord>(VAULT);
    if (!record) throw new VaultLockedError();
    await local.set(VAULT, {
      locked: record.locked,
      items: sealWithKey(key, JSON.stringify(items), random),
    });
  });
  queue = run.catch(() => {});
  return run;
}

export async function getItemAsync(name: string): Promise<string | null> {
  const { items } = await unlockedItems();
  return items[name] ?? null;
}

export const setItemAsync = (name: string, value: string) =>
  update((items) => {
    items[name] = value;
  });

export const deleteItemAsync = (name: string) =>
  update((items) => {
    delete items[name];
  });

/** Setting up, unlocking and locking the browser's vault. */
export const webVault = {
  async load() {
    const record = await local.get<VaultRecord>(VAULT);
    vaultStatus.set(!record ? 'new' : (await currentKey()) ? 'unlocked' : 'locked');
    return vaultStatus.get();
  },

  /** First run: an empty vault under `password`, unlocked. */
  async create(password: string) {
    if (await local.get<VaultRecord>(VAULT)) throw new Error('Honey is already set up here');
    const { key, locked } = await createLocalVault(password, random);
    await local.set(VAULT, { locked, items: sealWithKey(key, '{}', random) });
    await touch(key);
    vaultStatus.set('unlocked');
  },

  /** False for a wrong password. */
  async unlock(password: string) {
    const record = await local.get<VaultRecord>(VAULT);
    if (!record) return false;
    try {
      const key = await unlockLocalVault(record.locked, password);
      await touch(key);
      vaultStatus.set('unlocked');
      return true;
    } catch (error) {
      if (error instanceof WrongPasswordError) return false;
      throw error;
    }
  },

  /** Checks the password without changing anything, for sensitive actions. */
  async verify(password: string) {
    const record = await local.get<VaultRecord>(VAULT);
    if (!record) return false;
    try {
      await unlockLocalVault(record.locked, password);
      return true;
    } catch (error) {
      if (error instanceof WrongPasswordError) return false;
      throw error;
    }
  },

  lock,

  /** Forgets everything Honey keeps in this browser. Wallets come back from their phrase. */
  async reset() {
    await queue;
    clearTimeout(timer);
    await session.remove(SESSION);
    await local.remove(VAULT);
    vaultStatus.set('new');
  },
};
