/**
 * The two places the extension keeps things:
 *
 * - `local`: on disk, survives restarts. Only the encrypted vault and public data.
 * - `session`: in memory, cleared when the browser closes. Holds the unlocked phrase so
 *   the popup doesn't ask for the password every time it opens; never written to disk.
 *
 * Outside the extension (`pnpm dev` in a normal tab) both fall back to memory.
 */
export type Store = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
};

function chromeStore(area: chrome.storage.StorageArea): Store {
  return {
    get: async <T>(key: string) => (await area.get(key))[key] as T | undefined,
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
    clear: () => area.clear(),
  };
}

export function memoryStore(): Store {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
    clear: async () => map.clear(),
  };
}

const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage;

export const local: Store = hasChrome ? chromeStore(chrome.storage.local) : memoryStore();
export const session: Store = hasChrome ? chromeStore(chrome.storage.session) : memoryStore();
