import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/store', () => ({
  createStore: <T>(initial: T) => {
    let state = initial;
    return {
      get: () => state,
      set: (value: T) => {
        state = value;
      },
    };
  },
}));
// Exercise the real ciphertext storage; keep password derivation deterministic for races.
vi.mock('@honey-wallet/keyring', async (original) => {
  const actual = await original<typeof import('@honey-wallet/keyring')>();
  return {
    ...actual,
    createLocalVault: vi.fn(async (password: string) => ({
      key: new Uint8Array(32).fill(7),
      locked: { password },
    })),
    unlockLocalVault: vi.fn(async (locked: { password: string }, password: string) => {
      if (locked.password !== password) throw new actual.WrongPasswordError();
      return new Uint8Array(32).fill(7);
    }),
  };
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function area() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(data.get(key)) })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    }),
    remove: vi.fn(async (key: string) => {
      data.delete(key);
    }),
  };
}
function webStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
let local: ReturnType<typeof area>;
let session: ReturnType<typeof area>;
async function context() {
  vi.resetModules();
  return import('@/lib/secure-store.web');
}
beforeEach(() => {
  vi.useFakeTimers();
  let queue: Promise<unknown> = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, run: () => Promise<unknown>) => {
        const result = queue.then(run);
        queue = result.catch(() => {});
        return result;
      },
    },
  });
  local = area();
  session = area();
  vi.stubGlobal('chrome', { storage: { local, session } });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('serializes a stale read before a cross-window lock, which stays locked afterward', async () => {
  const a = await context();
  const b = await context();
  await a.webVault.create('password');
  await a.setItemAsync('secret', 'owned');
  const entered = deferred();
  const release = deferred();
  session.get.mockImplementationOnce(async (key) => {
    const snapshot = structuredClone(session.data.get(key));
    entered.resolve();
    await release.promise;
    return { [key]: snapshot };
  });
  const read = a.getItemAsync('secret');
  await entered.promise;
  const lock = b.webVault.lock();
  release.resolve();
  expect(await read).toBe('owned');
  await lock;
  expect(session.data.has('honey.session')).toBe(false);
  expect(await a.webVault.load()).toBe('locked');
  const fresh = await context();
  expect(await fresh.webVault.load()).toBe('locked');
  await expect(fresh.getItemAsync('secret')).rejects.toThrow('Honey is locked');
});

it('rejects reads and writes queued after lock and preserves ordinary unlock/delete', async () => {
  const a = await context();
  const b = await context();
  await a.webVault.create('password');
  await a.setItemAsync('secret', 'owned');
  const lock = b.webVault.lock();
  const read = a.getItemAsync('secret').catch((e: Error) => e.message);
  const write = a.setItemAsync('secret', 'changed').catch((e: Error) => e.message);
  await lock;
  expect(await read).toBe('Honey is locked');
  expect(await write).toBe('Honey is locked');
  expect(await b.webVault.unlock('wrong')).toBe(false);
  expect(await b.webVault.verify('password')).toBe(true);
  expect(session.data.has('honey.session')).toBe(false);
  expect(await b.webVault.unlock('password')).toBe(true);
  expect(await b.getItemAsync('secret')).toBe('owned');
  await b.deleteItemAsync('secret');
  expect(await b.getItemAsync('secret')).toBeNull();
});

it('does not lose updates from separate popup modules', async () => {
  const a = await context();
  const b = await context();
  await a.webVault.create('password');
  await Promise.all([a.setItemAsync('one', '1'), b.setItemAsync('two', '2')]);
  expect(await a.getItemAsync('one')).toBe('1');
  expect(await b.getItemAsync('two')).toBe('2');
});

it('a delayed password unlock cannot reinstall a key after a queued lock or reset', async () => {
  const a = await context();
  const b = await context();
  await a.webVault.create('password');
  await a.webVault.lock();
  const { unlockLocalVault } = await import('@honey-wallet/keyring');
  const entered = deferred();
  const release = deferred();
  vi.mocked(unlockLocalVault).mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return new Uint8Array(32).fill(7);
  });
  const unlock = a.webVault.unlock('password');
  await entered.promise;
  const lock = b.webVault.lock();
  const reset = b.webVault.reset();
  release.resolve();
  expect(await unlock).toBe(true);
  await lock;
  await reset;
  expect(await a.webVault.load()).toBe('new');
  expect(session.data.has('honey.session')).toBe(false);
});

it('old popup timers respect activity in another window and eventually expire', async () => {
  const a = await context();
  const b = await context();
  await a.webVault.create('password');
  await vi.advanceTimersByTimeAsync(a.AUTO_LOCK_MS - 100);
  await b.setItemAsync('secret', 'owned');
  await vi.advanceTimersByTimeAsync(101);
  expect(await a.webVault.load()).toBe('unlocked');
  await vi.advanceTimersByTimeAsync(a.AUTO_LOCK_MS);
  expect(await b.webVault.load()).toBe('locked');
});

it('invalidates separate-tab sessionStorage keys on lock and after reset/recreate', async () => {
  vi.stubGlobal('chrome', undefined);
  vi.stubGlobal('localStorage', webStorage());
  const tabA = webStorage();
  const tabB = webStorage();
  vi.stubGlobal('sessionStorage', tabA);
  const a = await context();
  await a.webVault.create('password');
  await a.setItemAsync('secret', 'owned');
  vi.stubGlobal('sessionStorage', tabB);
  const b = await context();
  expect(await b.webVault.load()).toBe('locked');
  expect(await b.webVault.unlock('password')).toBe(true);
  await vi.advanceTimersByTimeAsync(a.AUTO_LOCK_MS - 100);
  await b.getItemAsync('secret');
  await vi.advanceTimersByTimeAsync(101);
  expect(await a.webVault.load()).toBe('unlocked');
  await b.webVault.lock();
  expect(await a.webVault.load()).toBe('locked');
  await b.webVault.reset();
  await b.webVault.create('new password');
  await expect(a.getItemAsync('secret')).rejects.toThrow('Honey is locked');
  expect(await a.webVault.unlock('new password')).toBe(true);
});

it('rejects legacy and malformed sessions until password unlock', async () => {
  const a = await context();
  await a.webVault.create('password');
  for (const broken of [{ epoch: undefined }, { key: 'zz' }]) {
    session.data.set('honey.session', {
      ...(session.data.get('honey.session') as object),
      ...broken,
    });
    expect(await a.webVault.load()).toBe('locked');
    expect(await a.webVault.unlock('password')).toBe(true);
  }
  for (const at of [undefined, NaN, Date.now() + 1000]) {
    local.data.set('honey.vault', { ...(local.data.get('honey.vault') as object), at });
    expect(await a.webVault.load()).toBe('locked');
    expect(await a.webVault.unlock('password')).toBe(true);
  }
});

it('fails closed without cross-context locks', async () => {
  const a = await context();
  await a.webVault.create('password');
  vi.stubGlobal('navigator', {});
  await expect(a.getItemAsync('secret')).rejects.toThrow('Honey is locked');
  await expect(a.webVault.unlock('password')).rejects.toThrow('Honey is locked');
});
