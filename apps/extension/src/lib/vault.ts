import {
  type Addresses,
  type Backup,
  decryptBackup,
  deriveAddresses,
  encryptBackup,
  mnemonicToSeed,
} from '@honey-wallet/keyring';
import type { Store } from './storage';

/**
 * The extension's wallet. The phrase is stored encrypted with the user's password, in
 * the same format as a phone backup (scrypt + XChaCha20-Poly1305), so there's one
 * well-tested way of locking it. Unlocked, the phrase sits in session storage (memory
 * only) until the user locks, the browser closes, or it's been idle for AUTO_LOCK_MS.
 */

export type Account = { index: number; label: string };
export type AccountView = Account & { addresses: Addresses };

export const AUTO_LOCK_MS = 15 * 60 * 1000;

const KEY = { vault: 'vault', accounts: 'accounts', unlocked: 'unlocked' };

type Unlocked = { mnemonic: string; at: number };

export const random = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes));

export function createVault(local: Store, session: Store, now = Date.now) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  async function lock() {
    clearTimeout(timer);
    for (const listener of listeners) listener();
    await session.remove(KEY.unlocked);
  }
  async function remember(mnemonic: string) {
    await session.set(KEY.unlocked, { mnemonic, at: now() } satisfies Unlocked);
    clearTimeout(timer);
    timer = setTimeout(() => {
      void lock();
    }, AUTO_LOCK_MS);
  }

  return {
    /** True once a wallet has been set up here. */
    exists: async () => !!(await local.get<Backup>(KEY.vault)),

    /** Saves a phrase (new, imported or from the phone) under a password, unlocked. */
    async save(mnemonic: string, password: string, accounts: Account[]) {
      const vault = await encryptBackup(mnemonic, password, random);
      await local.set(KEY.vault, vault);
      await local.set(KEY.accounts, accounts.length ? accounts : [{ index: 0, label: 'Wallet 1' }]);
      await remember(mnemonic);
    },

    /** Resolves false for a wrong password. */
    async unlock(password: string) {
      const vault = await local.get<Backup>(KEY.vault);
      if (!vault) return false;
      try {
        await remember(await decryptBackup(vault, password));
        return true;
      } catch {
        return false;
      }
    },

    lock,
    onLock(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** The phrase while unlocked and recently used; otherwise null (and locks). */
    async unlocked(): Promise<string | null> {
      const state = await session.get<Unlocked>(KEY.unlocked);
      if (!state) return null;
      if (now() - state.at >= AUTO_LOCK_MS) {
        await lock();
        return null;
      }
      await remember(state.mnemonic);
      return state.mnemonic;
    },

    /** Each account with its address on every chain. */
    async accounts(mnemonic: string): Promise<AccountView[]> {
      const list = (await local.get<Account[]>(KEY.accounts)) ?? [];
      const seed = await mnemonicToSeed(mnemonic);
      return list.map((a) => ({ ...a, addresses: deriveAddresses(seed, a.index) }));
    },

    /** Forgets everything on this browser. The phone and backups are untouched. */
    async reset() {
      await lock();
      await local.clear();
      await session.clear();
    },
  };
}

export type Vault = ReturnType<typeof createVault>;
