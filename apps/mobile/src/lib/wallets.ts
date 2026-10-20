import type { Addresses } from '@honey-wallet/keyring';
import { ADDRESS, BALANCE, otherWallets, type Wallet } from '@/lib/mock-wallet';
import { getProfile, useProfile } from '@/lib/profile';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';
import { createAccount, loadAccounts, upgradeNearAccounts, type VaultAccount } from '@/lib/vault';

/**
 * A wallet added this session. Watched addresses can be viewed but not spent from;
 * burners are disposable wallets for sites you don't fully trust.
 */
export type AddedWallet = Wallet & {
  watchOnly?: boolean;
  demo?: boolean;
  burner?: boolean;
  /** Wallets with keys on this device: their address on each chain. */
  addresses?: Partial<Addresses>;
};

/** The wallet the app is showing, and any wallets added this session. */
export const wallets = createStore<{ activeId: string; added: AddedWallet[] }>(
  {
    activeId: 'main',
    added: [],
  },
  { persist: 'wallets' },
);

export const useWallets = wallets.useValue;

const fromVault = (account: VaultAccount): AddedWallet => ({
  id: account.id,
  kind: 'wallet',
  label: account.label,
  address: account.addresses.evm,
  addresses: account.addresses,
  usd: 0,
});

// Wallets created or imported on an earlier launch. Their keys stay in secure storage;
// only the public addresses are loaded here.
export const walletLoad = createStore({ ready: false, error: false });
export async function hydrateWallets() {
  try {
    await upgradeNearAccounts();
    let accounts = await loadAccounts();
    // Test mode behaves like the real app: with no wallet yet, make the main one silently.
    if (needsTestWallet(accounts)) accounts = [await createAccount(getProfile().name)];
    wallets.set((prev) => ({
      activeId: prev.activeId === 'main' && accounts.length ? accounts[0].id : prev.activeId,
      added: [
        ...accounts.map(fromVault),
        ...prev.added.filter((w) => !accounts.some((a) => a.id === w.id)),
      ],
    }));
    walletLoad.set({ ready: true, error: false });
  } catch {
    walletLoad.set({ ready: false, error: true });
  }
}

/** Test mode only: true when the vault has no wallet, so one is created at launch. */
export function needsTestWallet(accounts: VaultAccount[], testMode: boolean = TEST_MODE) {
  return testMode && accounts.length === 0;
}

/**
 * The user's main wallet: the sample one when nothing has keys here, otherwise the first
 * wallet created or imported on this device.
 */
export function isMainWallet(wallet: AddedWallet, added: AddedWallet[] = wallets.get().added) {
  return wallet.id === 'main' || wallet.id === added.find((w) => w.addresses)?.id;
}

/** Adds a wallet whose keys were just saved to the vault, and switches to it. */
export function addVaultWallet(account: VaultAccount) {
  wallets.set((prev) => ({ activeId: account.id, added: [...prev.added, fromVault(account)] }));
  return account.id;
}

/** The user's own wallet plus the others, as one list. */
export function allWallets(
  name: string,
  added: AddedWallet[],
  testMode: boolean = TEST_MODE,
): AddedWallet[] {
  if (added.some((wallet) => wallet.addresses)) {
    return testMode ? withSampleMoney(name, added) : added;
  }
  return [
    { demo: true, id: 'main', kind: 'wallet', label: name, address: ADDRESS, usd: BALANCE },
    ...otherWallets(name).map((wallet) => ({ ...wallet, demo: true })),
    ...added,
  ];
}

/**
 * Test mode: the user's real wallets (real addresses, real keys) hold the sample portfolio
 * instead of their on-chain balances, and the sample shared wallets are listed too. Sample
 * wallets take the fixture flows, which end on success pages and never sign anything.
 */
function withSampleMoney(name: string, added: AddedWallet[]): AddedWallet[] {
  const own = added.map((w) => (w.watchOnly ? w : { ...w, demo: true }));
  const shared = otherWallets(name)
    .filter((w) => w.kind === 'multisig' && !added.some((a) => a.id === w.id))
    .map((w) => ({ ...w, demo: true }));
  return [...own, ...shared];
}

/** A built-in sample wallet with no keys on this device (not one of the user's own). */
export const isFixtureWallet = (wallet: AddedWallet) => !!wallet.demo && !wallet.addresses;

export function setActiveWallet(id: string) {
  wallets.set((prev) => ({ ...prev, activeId: id }));
}

/** Adds a wallet and switches to it. Returns its id. */
export function addWallet(wallet: Omit<AddedWallet, 'id'>) {
  const id = `added-${Date.now()}`;
  wallets.set((prev) => ({ activeId: id, added: [...prev.added, { ...wallet, id }] }));
  return id;
}

/** The label for the next created wallet, e.g. "Wallet 4". */
export function nextWalletLabel(name: string) {
  const count = allWallets(name, wallets.get().added).filter((w) => w.kind === 'wallet').length;
  return `Wallet ${count + 1}`;
}

/** The label for the next burner, e.g. "Burner 2". */
export function nextBurnerLabel() {
  return `Burner ${wallets.get().added.filter((w) => w.burner).length + 1}`;
}

/** A random-looking address for demo data (watched handles, multisig members). */
export function demoAddress() {
  const hex = '0123456789abcdef';
  let out = '0x';
  for (let i = 0; i < 40; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

/** True for a full EVM address, e.g. "0x7a3F…aB3c" written out in full. */
export function isEvmAddress(value: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/** True for a Honey handle, e.g. "maya.honey". */
export function isHoneyHandle(value: string) {
  return /^[^\s.]+\.honey$/i.test(value.trim());
}

/** The wallet currently shown on home, kept up to date as it changes. */
export function useActiveWallet(): AddedWallet {
  const { activeId, added } = useWallets();
  const { name } = useProfile();
  const list = allWallets(name, added);
  return list.find((w) => w.id === activeId) ?? list[0];
}
