import {
  type Addresses,
  createMnemonic,
  deriveAddresses,
  evmAddressFromPrivateKey,
  isPairAccountList,
  isValidMnemonic,
  nearAddressOfKey,
  normalizeMnemonic,
  privateKeyFor,
  withMnemonicSeed,
} from '@honey-wallet/keyring';
import { getRandomBytes } from 'expo-crypto';
import { hexToBytes } from 'viem';
import * as SecureStore from '@/lib/secure-store';

/**
 * The device's secrets: recovery phrases and imported private keys, kept in the
 * iOS Keychain / Android Keystore, or a password-locked vault in a browser (see
 * secure-store). They never leave the device and aren't included in iCloud or Google
 * backups (THIS_DEVICE_ONLY); the backup step covers that.
 *
 * One phrase is the primary one: "Create new wallet" adds the next account under it
 * (like MetaMask). Imported phrases and keys are stored alongside it and need
 * their own recovery copies; exporting the primary phrase does not include them.
 */

/** A wallet backed by a secret on this device. Addresses are public, so they're cached. */
export type VaultAccount = {
  id: string;
  label: string;
  burner?: boolean;
  /** The phrase it derives from (and its index), or an imported private key. */
  source: { kind: 'phrase'; seedId: string; index: number } | { kind: 'key' };
  addresses: Partial<Addresses> & { evm: string };
};

const KEY = {
  accounts: 'honey.accounts',
  primary: 'honey.primary-seed',
  seed: (id: string) => `honey.seed.${id}`,
  privateKey: (id: string) => `honey.key.${id}`,
};

const read = (key: string) => SecureStore.getItemAsync(key);
const write = (key: string, value: string) => SecureStore.setItemAsync(key, value);

// Account changes run one at a time, so a double tap can't derive the same index twice.
let queue: Promise<unknown> = Promise.resolve();
function serial<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  return (...args: A): Promise<R> => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };
}

const newId = () => Array.from(getRandomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('');

/** A fresh 12-word phrase, not yet saved: shown on the backup screen first. */
export const draftMnemonic = () => createMnemonic(getRandomBytes);

export { isValidMnemonic };

/** Address families Honey no longer supports. Bitcoin was removed on 2026-10-22. */
const RETIRED_FAMILIES = ['bitcoin'] as const;

/** Drops cached addresses for retired chains; true when anything was removed. */
function dropRetiredAddresses(accounts: VaultAccount[]): boolean {
  let changed = false;
  for (const account of accounts) {
    const addresses = account.addresses as Record<string, string | undefined>;
    for (const family of RETIRED_FAMILIES) {
      if (family in addresses) {
        delete addresses[family];
        changed = true;
      }
    }
  }
  return changed;
}

async function readAccounts(): Promise<{ accounts: VaultAccount[]; retired: boolean }> {
  const json = await read(KEY.accounts);
  const accounts = json ? (JSON.parse(json) as VaultAccount[]) : [];
  return { accounts, retired: dropRetiredAddresses(accounts) };
}

export async function loadAccounts(): Promise<VaultAccount[]> {
  return (await readAccounts()).accounts;
}

/** Add NEAR to pre-existing phrase wallets once, without changing any existing address.
 * Also persists the removal of retired chains' cached addresses (Bitcoin). */
export const upgradeNearAccounts = serial(async (): Promise<void> => {
  const { accounts, retired } = await readAccounts();
  let changed = retired;
  for (const account of accounts) {
    if (account.source.kind !== 'phrase' || account.addresses.near) continue;
    const phrase = await read(KEY.seed(account.source.seedId));
    if (!phrase) continue;
    const index = account.source.index;
    account.addresses.near = await withMnemonicSeed(phrase, (seed) => {
      const key = privateKeyFor(seed, 'near', index);
      try {
        return nearAddressOfKey(key);
      } finally {
        key.fill(0);
      }
    });
    changed = true;
  }
  if (changed) await write(KEY.accounts, JSON.stringify(accounts));
});

async function saveAccount(account: VaultAccount) {
  const accounts = await loadAccounts();
  await write(KEY.accounts, JSON.stringify([...accounts, account]));
  return account;
}

export async function hasPrimaryMnemonic() {
  return !!(await read(KEY.primary));
}

/** The primary phrase, or null before the first wallet is created. */
export async function readPrimaryMnemonic(): Promise<string | null> {
  const seedId = await read(KEY.primary);
  return seedId ? read(KEY.seed(seedId)) : null;
}

/** Stores a phrase and returns its id. The first one saved becomes the primary. */
async function saveSeed(phrase: string, { primary = false } = {}) {
  const seedId = newId();
  await write(KEY.seed(seedId), normalizeMnemonic(phrase));
  if (primary || !(await read(KEY.primary))) await write(KEY.primary, seedId);
  return seedId;
}

async function deriveAccount(seedId: string, index: number, label: string, burner = false) {
  const phrase = await read(KEY.seed(seedId));
  if (!phrase) throw new Error('Recovery phrase missing from this device');
  const addresses = await withMnemonicSeed(phrase, (seed) => deriveAddresses(seed, index));
  return saveAccount({
    id: `${seedId}-${index}`,
    label,
    source: { kind: 'phrase', seedId, index },
    addresses,
    ...(burner ? { burner: true } : {}),
  });
}

/**
 * Makes `phrase` (one the user just wrote down) the primary phrase and returns its
 * first wallet.
 */
export const startWithMnemonic = serial(
  async (phrase: string, label: string): Promise<VaultAccount> =>
    deriveAccount(await saveSeed(phrase, { primary: true }), 0, label),
);

/**
 * Creates the next wallet under the primary phrase, starting a new random phrase when
 * the device doesn't have one yet (backed up later, from the setup checklist).
 */
export const createAccount = serial(
  async (label: string, burner: boolean = false): Promise<VaultAccount> => {
    let seedId = await read(KEY.primary);
    if (!seedId) seedId = await saveSeed(draftMnemonic());
    const used = (await loadAccounts()).filter(
      (a) => a.source.kind === 'phrase' && a.source.seedId === seedId,
    );
    const next = used.reduce(
      (max, a) => Math.max(max, (a.source as { index: number }).index + 1),
      0,
    );
    return deriveAccount(seedId, next, label, burner);
  },
);

/** Imports account 0 of an existing phrase from another wallet. */
export const importMnemonic = serial(
  async (phrase: string, label: string): Promise<VaultAccount> => {
    if (!isValidMnemonic(phrase)) throw new Error('That recovery phrase isn’t valid');
    return deriveAccount(await saveSeed(phrase), 0, label);
  },
);

/**
 * Brings in the wallet a phone sent when pairing: its phrase and every account the user
 * made from it, under the same names. Pairing again only adds accounts that are missing.
 */
export const importPairedWallet = serial(
  async (payload: {
    mnemonic: string;
    accounts: { index: number; label: string }[];
  }): Promise<VaultAccount[]> => {
    if (!isValidMnemonic(payload.mnemonic)) throw new Error('That recovery phrase isn’t valid');
    if (!isPairAccountList(payload.accounts))
      throw new Error('Paired wallet account list is invalid');
    const phrase = normalizeMnemonic(payload.mnemonic);
    const existing = await loadAccounts();
    let seedId: string | null = null;
    for (const account of existing) {
      if (account.source.kind !== 'phrase') continue;
      if ((await read(KEY.seed(account.source.seedId))) === phrase) {
        seedId = account.source.seedId;
        break;
      }
    }
    seedId ??= await saveSeed(phrase);
    const have = new Set(
      existing.flatMap((a) =>
        a.source.kind === 'phrase' && a.source.seedId === seedId ? [a.source.index] : [],
      ),
    );
    const wanted = payload.accounts.length ? payload.accounts : [{ index: 0, label: 'Wallet' }];
    const added: VaultAccount[] = [];
    for (const { index, label } of wanted) {
      if (!Number.isInteger(index) || index < 0 || have.has(index)) continue;
      have.add(index);
      added.push(await deriveAccount(seedId, index, label.slice(0, 40) || 'Wallet'));
    }
    return added;
  },
);

/**
 * The private key behind one of this device's wallets on one chain, for signing what a
 * website asked for after the user approved it. Never stored or kept: callers use it
 * and drop it. An imported private key only has an EVM side.
 */
export async function privateKeyOf(accountId: string, chain: 'evm' | 'solana' | 'near') {
  const account = (await loadAccounts()).find((a) => a.id === accountId);
  if (!account) throw new Error('That wallet isn’t on this device');
  if (account.source.kind === 'key') {
    if (chain !== 'evm') throw new Error('This wallet only works on EVM networks');
    const hex = await read(KEY.privateKey(account.id));
    if (!hex) throw new Error('This wallet’s key is missing');
    return hexToBytes(`0x${hex}`);
  }
  const phrase = await read(KEY.seed(account.source.seedId));
  if (!phrase) throw new Error('Recovery phrase missing from this device');
  const index = account.source.index;
  return withMnemonicSeed(phrase, (seed) => privateKeyFor(seed, chain, index));
}

/** Imports a single EVM private key. */
export const importPrivateKey = serial(
  async (hex: string, label: string): Promise<VaultAccount> => {
    const evm = evmAddressFromPrivateKey(hex);
    const id = newId();
    await write(KEY.privateKey(id), hex.trim().replace(/^0x/i, '').toLowerCase());
    return saveAccount({ id, label, source: { kind: 'key' }, addresses: { evm } });
  },
);

/**
 * The primary phrase and the accounts made from it, for pairing another device (the
 * browser extension). Null before the first wallet is created.
 */
export async function readPrimaryWallet(): Promise<{
  mnemonic: string;
  accounts: { index: number; label: string }[];
} | null> {
  const seedId = await read(KEY.primary);
  const mnemonic = seedId ? await read(KEY.seed(seedId)) : null;
  if (!seedId || !mnemonic) return null;
  const accounts = (await loadAccounts()).flatMap((a) =>
    a.source.kind === 'phrase' && a.source.seedId === seedId
      ? [{ index: a.source.index, label: a.label }]
      : [],
  );
  return { mnemonic, accounts };
}

/**
 * Erases every secret this app keeps: each phrase, each imported key, and the list of
 * accounts. Used by Sign out, so nothing sensitive stays on the phone afterwards.
 */
export const eraseVault = serial(async (confirmedAccountIds: readonly string[]) => {
  const remove = (key: string) => SecureStore.deleteItemAsync(key);
  const accounts = await loadAccounts();
  if (accounts.some((account) => !confirmedAccountIds.includes(account.id))) {
    throw new Error('Confirm recovery for every wallet before signing out');
  }
  const seeds = new Set<string>();
  for (const account of accounts) {
    if (account.source.kind === 'phrase') seeds.add(account.source.seedId);
    else await remove(KEY.privateKey(account.id));
    await remove(`honey.near.mainnet.${account.id}`);
    await remove(`honey.near.testnet.${account.id}`);
  }
  const primary = await read(KEY.primary);
  if (primary) seeds.add(primary);
  for (const seedId of seeds) await remove(KEY.seed(seedId));
  await remove(KEY.primary);
  await remove(KEY.accounts);
});
