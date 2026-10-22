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

type VaultRecord = { locked: LockedKey; items: string; epoch?: string; at?: number };
type Session = { key: string; epoch: string };
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
  globalThis as {
    chrome?: {
      storage?: {
        local?: ChromeArea;
        session?: ChromeArea;
        onChanged?: {
          addListener(listener: (changes: Record<string, unknown>, area: string) => void): void;
        };
      };
    };
  }
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

/** One origin-wide lock covers reads, writes, key installation and revocation, including
 * asynchronous storage calls. A per-popup promise queue cannot protect this boundary.
 * Unsupported/insecure browser contexts fail closed instead of falling back to a mutex.
 */
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) return Promise.reject(new VaultLockedError());
  return navigator.locks.request('honey.vault', run);
}

async function lockedStatus() {
  vaultStatus.set((await local.get<VaultRecord>(VAULT)) ? 'locked' : 'new');
}

// Called only while holding the origin-wide lock. The persisted epoch revokes keys
// even in ordinary tabs, whose sessionStorage areas are separate.
async function revoke() {
  clearTimeout(timer);
  const record = await local.get<VaultRecord>(VAULT);
  if (record) await local.set(VAULT, { ...record, epoch: toHex(random(16)) });
  await session.remove(SESSION);
  vaultStatus.set(record ? 'locked' : 'new');
}

const lock = () => exclusive(revoke);

function schedule(at: number) {
  clearTimeout(timer);
  // A stale timer checks shared activity under the lock before revoking a key.
  timer = setTimeout(
    () => void webVault.load().catch(() => {}),
    Math.max(0, at + AUTO_LOCK_MS - Date.now()),
  );
}

async function currentKey(record: VaultRecord, touch = true): Promise<Uint8Array | null> {
  const state = await session.get<Session>(SESSION);
  if (!record.epoch || !state || state.epoch !== record.epoch) return null;
  if (
    typeof record.at !== 'number' ||
    !Number.isFinite(record.at) ||
    record.at > Date.now() ||
    Date.now() - record.at >= AUTO_LOCK_MS ||
    !/^[0-9a-f]{64}$/.test(state.key)
  ) {
    await revoke();
    return null;
  }
  if (touch) {
    record.at = Date.now();
    await local.set(VAULT, record);
  }
  schedule(record.at);
  return fromHex(state.key);
}

async function install(key: Uint8Array, epoch: string) {
  const at = Date.now();
  await session.set(SESSION, { key: toHex(key), epoch } satisfies Session);
  schedule(at);
  vaultStatus.set('unlocked');
}

async function unlockedItems() {
  const record = await local.get<VaultRecord>(VAULT);
  const key = record && (await currentKey(record));
  if (!key) {
    await lockedStatus();
    throw new VaultLockedError();
  }
  return {
    key,
    record,
    items: JSON.parse(openWithKey(key, record.items)) as Record<string, string>,
  };
}

function update(change: (items: Record<string, string>) => void) {
  return exclusive(async () => {
    const { key, record, items } = await unlockedItems();
    change(items);
    await local.set(VAULT, { ...record, items: sealWithKey(key, JSON.stringify(items), random) });
  });
}

export const getItemAsync = (name: string): Promise<string | null> =>
  exclusive(async () => {
    const { items } = await unlockedItems();
    return items[name] ?? null;
  });

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
  load: () =>
    exclusive(async () => {
      const record = await local.get<VaultRecord>(VAULT);
      vaultStatus.set(!record ? 'new' : (await currentKey(record, false)) ? 'unlocked' : 'locked');
      return vaultStatus.get();
    }),

  create: (password: string) =>
    exclusive(async () => {
      if (await local.get<VaultRecord>(VAULT)) throw new Error('Honey is already set up here');
      const { key, locked } = await createLocalVault(password, random);
      const epoch = toHex(random(16));
      await local.set(VAULT, {
        locked,
        items: sealWithKey(key, '{}', random),
        epoch,
        at: Date.now(),
      });
      await install(key, epoch);
    }),

  /** False for a wrong password. Unlock completion precedes any queued lock/reset. */
  unlock: (password: string) =>
    exclusive(async () => {
      const record = await local.get<VaultRecord>(VAULT);
      if (!record) return false;
      try {
        const key = await unlockLocalVault(record.locked, password);
        const epoch = record.epoch ?? toHex(random(16));
        await local.set(VAULT, { ...record, epoch, at: Date.now() });
        await install(key, epoch);
        return true;
      } catch (error) {
        if (error instanceof WrongPasswordError) return false;
        throw error;
      }
    }),

  /** Checks the password without changing anything, for sensitive actions. */
  verify: (password: string) =>
    exclusive(async () => {
      const record = await local.get<VaultRecord>(VAULT);
      if (!record) return false;
      try {
        await unlockLocalVault(record.locked, password);
        return true;
      } catch (error) {
        if (error instanceof WrongPasswordError) return false;
        throw error;
      }
    }),

  lock,

  /** Forgets everything Honey keeps in this browser. */
  reset: () =>
    exclusive(async () => {
      clearTimeout(timer);
      await session.remove(SESSION);
      await local.remove(VAULT);
      vaultStatus.set('new');
    }),
};

// Keep already-open lock screens in sync; reads below do not refresh idle activity.
const reload = () => {
  void webVault.load().catch(() => {});
};
chromeStorage?.onChanged?.addListener((changes, area) => {
  if ((area === 'local' && VAULT in changes) || (area === 'session' && SESSION in changes))
    reload();
});
if (!chromeStorage)
  globalThis.addEventListener?.('storage', (event) => {
    if (event.key === VAULT) reload();
  });
