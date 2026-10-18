/**
 * Saves stores created with a `persist` key (see store.ts) to `chrome.storage.local`, so
 * the extension's popup, which starts afresh each time it opens, picks up where it left
 * off. Only app state goes here: balances, jars, proposals, settings. Secrets live in
 * the password-locked vault (secure-store.web.ts). Outside the extension, localStorage.
 */

const PREFIX = 'honey.state.';

type ChromeArea = {
  get(keys: null): Promise<{ [key: string]: unknown }>;
  set(items: { [key: string]: unknown }): Promise<void>;
  remove(keys: string[]): Promise<void>;
};
const chromeLocal = (globalThis as { chrome?: { storage?: { local?: ChromeArea } } }).chrome
  ?.storage?.local;

async function readAll(): Promise<{ [key: string]: unknown }> {
  if (chromeLocal) return chromeLocal.get(null);
  const out: { [key: string]: unknown } = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX)) out[key] = JSON.parse(localStorage.getItem(key) ?? 'null');
  }
  return out;
}

async function write(key: string, value: unknown) {
  if (chromeLocal) await chromeLocal.set({ [key]: value });
  else localStorage.setItem(key, JSON.stringify(value));
}

const restorers = new Map<string, (saved: unknown) => void>();
// A store changed before the saved copy loaded keeps its newer state.
const changedEarly = new Set<string>();
let saved: { [key: string]: unknown } | null = null;

export const persistence = {
  register(key: string, restore: (value: unknown) => void) {
    restorers.set(key, restore);
    if (saved && PREFIX + key in saved && !changedEarly.has(key)) restore(saved[PREFIX + key]);
  },

  save(key: string, state: unknown) {
    if (!saved) changedEarly.add(key);
    // Written straight away: the popup can close at any moment.
    void write(PREFIX + key, state);
  },

  /** Resolves once saved state is back in the stores; the app waits for it. */
  ready: readAll().then((all) => {
    saved = all;
    for (const [key, restore] of restorers) {
      if (PREFIX + key in all && !changedEarly.has(key)) restore(all[PREFIX + key]);
    }
  }),

  /** Forgets all saved app state (resetting Honey in this browser). */
  async clear() {
    const keys = Object.keys(await readAll()).filter((k) => k.startsWith(PREFIX));
    if (chromeLocal) await chromeLocal.remove(keys);
    else for (const k of keys) localStorage.removeItem(k);
  },
};
