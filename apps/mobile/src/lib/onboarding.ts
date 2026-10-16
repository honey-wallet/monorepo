import { router } from 'expo-router';
import { randomAvatarSeed } from '@/components/Avatar';
import { setProfile } from '@/lib/profile';
import { createStore } from '@/lib/store';
import { showToast } from '@/lib/toast';
import { eraseVault } from '@/lib/vault';
import { wallets } from '@/lib/wallets';

/**
 * Onboarding and activation, built around one goal: a new user's first deposit. A
 * funded wallet is the moment Honey becomes useful (and the best predictor that
 * someone stays), so everything before it is kept as short as possible and
 * everything after it nudges towards finishing setup.
 *
 *   welcome  → Create a new wallet (Apple, Google, email, or a recovery phrase)
 *            → I already have a wallet (Apple, Google, email, or import a phrase)
 *   home     → no money yet: the empty state is all about adding money
 *            → money, setup unfinished: "Finish setting up, get $5 off network fees"
 *            → setup done: nothing extra
 *
 * In memory for now, so it resets on restart. The default state is an onboarded,
 * funded wallet, so deep links straight to /home show the full demo portfolio.
 */
export type SignInMethod = 'apple' | 'google' | 'email' | 'phrase' | 'import';

export type SetupStep = 'wallet' | 'backup' | 'faceId' | 'notifications' | 'profile';

/**
 * The steps that earn the fee credit, in the order the checklist shows them. The first
 * is already done when the list appears: a head start makes people likelier to finish
 * (endowed progress: 34% vs 19% completion in Nunes & Drèze's loyalty-card study).
 */
export const SETUP_STEPS: { id: SetupStep; title: string; hint: string; href: string }[] = [
  {
    id: 'wallet',
    title: 'Create your wallet',
    hint: 'Done',
    href: '/home',
  },
  {
    id: 'backup',
    title: 'Back up your wallet',
    hint: 'So you can get back in on a new phone',
    href: '/icloud-backup',
  },
  {
    id: 'faceId',
    title: 'Turn on Face ID',
    hint: 'Approve payments with a glance',
    href: '/settings-face-id',
  },
  {
    id: 'notifications',
    title: 'Turn on notifications',
    hint: 'Know when money arrives',
    href: '/settings-notifications',
  },
  {
    id: 'profile',
    title: 'Add your name and photo',
    hint: 'So friends know it’s you',
    href: '/profile-edit',
  },
];

/** The reward for finishing setup: credit against network fees. */
export const SETUP_REWARD_USD = 5;

type Onboarding = {
  method: SignInMethod | null;
  /** Whether the wallet has ever received money. */
  funded: boolean;
  done: SetupStep[];
  /** The fee credit left, once setup is finished. */
  credit: number;
};

const onboarding = createStore<Onboarding>({
  method: null,
  funded: true,
  done: [...SETUP_STEPS.map((s) => s.id)],
  credit: 0,
});

export const useOnboarding = onboarding.use;

/** True once every setup step is done. */
export const setupComplete = (state: Onboarding) => state.done.length === SETUP_STEPS.length;

/**
 * Ends onboarding and opens the wallet. A new wallet starts empty; a restored one
 * already holds money (the demo portfolio). Backing up is done already when the user
 * wrote down a phrase or signed in with Apple or Google (their account is the backup).
 */
export function finishOnboarding(
  method: SignInMethod,
  { restored = method === 'import', email }: { restored?: boolean; email?: string } = {},
) {
  const backedUp = method === 'phrase' || method === 'apple' || method === 'google';
  onboarding.set({
    method,
    funded: restored,
    done: backedUp ? ['wallet', 'backup'] : ['wallet'],
    credit: 0,
  });
  if (email) setProfile({ name: nameFromEmail(email) });
  router.dismissAll();
  router.replace('/home');
}

/** "maya.lee@gmail.com" → "Maya". */
function nameFromEmail(email: string) {
  const local = email.split('@')[0]?.split(/[._+-]/)[0] ?? '';
  return local ? local[0].toUpperCase() + local.slice(1) : 'Honey';
}

/** The first deposit landed: the wallet now shows its balance. */
export function markFunded(usd?: number) {
  if (onboarding.get().funded) return;
  onboarding.set((s) => ({ ...s, funded: true }));
  showToast(usd ? `$${usd.toFixed(2)} arrived. You're all set` : 'Money arrived. You’re all set');
}

/** Ticks off a setup step; the last one unlocks the fee credit. */
export function completeStep(step: SetupStep) {
  const state = onboarding.get();
  if (state.done.includes(step)) return;
  const done = [...state.done, step];
  const finished = done.length === SETUP_STEPS.length;
  onboarding.set({ ...state, done, credit: finished ? SETUP_REWARD_USD : state.credit });
  if (finished) showToast(`$${SETUP_REWARD_USD} off network fees unlocked`);
}

/**
 * DEMO: an incoming transfer a few seconds after the Receive sheet opens on an empty
 * wallet, so the first-deposit moment can be seen without a real chain. Remove once
 * balances come from the server.
 */
let demoDeposit: ReturnType<typeof setTimeout> | undefined;
export function simulateDemoDeposit() {
  if (onboarding.get().funded || demoDeposit) return;
  demoDeposit = setTimeout(() => {
    demoDeposit = undefined;
    markFunded(25);
  }, 6000);
}

/**
 * Signs out: the wallet comes off this phone (keys, profile and wallets added here),
 * and the app goes back to Welcome. The money stays where it is, on the network, and
 * comes back with the account or the recovery phrase.
 */
export async function signOut() {
  await eraseVault();
  onboarding.set({ method: null, funded: false, done: [], credit: 0 });
  wallets.set({ activeId: 'main', added: [] });
  setProfile({ name: 'Honey', photo: null, avatarSeed: randomAvatarSeed() });
  router.dismissAll();
  router.replace('/welcome');
}
