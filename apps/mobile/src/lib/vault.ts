import {
  type Addresses,
  createMnemonic,
  deriveAddresses,
  evmAddressFromPrivateKey,
  isValidMnemonic,
  mnemonicToSeed,
  normalizeMnemonic,
} from '@honey-wallet/keyring';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

/**
 * The device's secrets: recovery phrases and imported private keys, kept in the
 * iOS Keychain / Android Keystore. They never leave the device and aren't included
 * in iCloud or Google backups (THIS_DEVICE_ONLY); the backup step covers that.
 *
 * One phrase is the primary one: "Create new wallet" adds the next account under it
 * (like MetaMask), so the user only ever has one phrase to back up. Imported phrases
 * and keys are stored alongside it.
 */

/** A wallet backed by a secret on this device. Addresses are public, so they're cached. */
export type VaultAccount = {
  id: string;
  label: string;
  /** The phrase it derives from (and its index), or an imported private key. */
  source: { kind: 'phrase'; seedId: string; index: number } | { kind: 'key' };
  addresses: Partial<Addresses> & { evm: string };
};

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const KEY = {
  accounts: 'honey.accounts',
  primary: 'honey.primary-seed',
  seed: (id: string) => `honey.seed.${id}`,
  privateKey: (id: string) => `honey.key.${id}`,
};

const read = (key: string) => SecureStore.getItemAsync(key, OPTIONS);
const write = (key: string, value: string) => SecureStore.setItemAsync(key, value, OPTIONS);

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

export async function loadAccounts(): Promise<VaultAccount[]> {
  const json = await read(KEY.accounts);
  return json ? (JSON.parse(json) as VaultAccount[]) : [];
}

async function saveAccount(account: VaultAccount) {
  const accounts = await loadAccounts();
  await write(KEY.accounts, JSON.stringify([...accounts, account]));
  return account;
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

async function deriveAccount(seedId: string, index: number, label: string) {
  const phrase = await read(KEY.seed(seedId));
  if (!phrase) throw new Error('Recovery phrase missing from this device');
  const addresses = deriveAddresses(await mnemonicToSeed(phrase), index);
  return saveAccount({
    id: `${seedId}-${index}`,
    label,
    source: { kind: 'phrase', seedId, index },
    addresses,
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
export const createAccount = serial(async (label: string): Promise<VaultAccount> => {
  let seedId = await read(KEY.primary);
  if (!seedId) seedId = await saveSeed(draftMnemonic());
  const used = (await loadAccounts()).filter(
    (a) => a.source.kind === 'phrase' && a.source.seedId === seedId,
  );
  const next = used.reduce((max, a) => Math.max(max, (a.source as { index: number }).index + 1), 0);
  return deriveAccount(seedId, next, label);
});

/** Imports account 0 of an existing phrase from another wallet. */
export const importMnemonic = serial(
  async (phrase: string, label: string): Promise<VaultAccount> => {
    if (!isValidMnemonic(phrase)) throw new Error('That recovery phrase isn’t valid');
    return deriveAccount(await saveSeed(phrase), 0, label);
  },
);

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
