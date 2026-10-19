import { router } from 'expo-router';
import { randomAvatarSeed } from '@/components/Avatar';
import { forgetSavedBackendSession } from '@/lib/backend-session';
import { forgetSites } from '@/lib/dapp';
import { isWeb } from '@/lib/platform';
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

export type SetupStep =
  | 'wallet'
  | 'backup'
  | 'phone'
  | 'browser'
  | 'faceId'
  | 'notifications'
  | 'profile';

/**
 * The steps that earn the fee credit, in the order the checklist shows them. The first
 * is already done when the list appears: a head start makes people likelier to finish
 * (endowed progress: 34% vs 19% completion in Nunes & Drèze's loyalty-card study).
 */
const ALL_STEPS: { id: SetupStep; title: string; hint: string; href: string }[] = [
  {
    id: 'wallet',
    title: 'Create your wallet',
    hint: 'Done',
    href: '/home',
  },
  {
    id: 'backup',
    title: 'Back up your wallet',
    hint: 'So you can get back in on a new device',
    // No iCloud or Google Drive in a browser: writing the phrase down is the backup.
    href: isWeb ? '/recovery-phrase' : '/icloud-backup',
  },
  {
    id: 'phone',
    title: 'Get Honey on your phone',
    hint: 'Scan a code with the Honey app',
    href: '/pair-phone?send=1',
  },
  {
    id: 'browser',
    title: 'Use Honey in your browser',
    hint: 'Scan the code in the browser extension',
    href: '/scan?purpose=extension',
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

// Face ID and notifications are phone features, so the browser's checklist skips them
// and can still be finished. Its backup is writing the phrase down, so a wallet with no
// phrase on this device (signed in with Apple, Google or email) has no backup step there.
const PHONE_ONLY: SetupStep[] = ['faceId', 'notifications', 'browser'];
// Sending the wallet across is each side's own step, and needs a phrase to send.
const BROWSER_ONLY: SetupStep[] = ['phone'];
const NO_PHRASE: (SignInMethod | null)[] = ['apple', 'google', 'email'];

/** The checklist for how this wallet was set up, on this platform. */
export function setupSteps(method: SignInMethod | null) {
  if (!isWeb) {
    return ALL_STEPS.filter(
      (s) => !BROWSER_ONLY.includes(s.id) && !(s.id === 'browser' && NO_PHRASE.includes(method)),
    );
  }
  return ALL_STEPS.filter(
    (s) =>
      !PHONE_ONLY.includes(s.id) &&
      !((s.id === 'backup' || s.id === 'phone') && NO_PHRASE.includes(method)),
  );
}

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

const onboarding = createStore<Onboarding>(
  {
    method: null,
    funded: true,
    done: [...ALL_STEPS.map((s) => s.id)],
    credit: 0,
  },
  { persist: 'onboarding' },
);

export const useOnboarding = onboarding.useValue;

/** True once every setup step is done. */
/** How many of this platform's steps are done (a browser has no Face ID step to count). */
export const doneCount = (state: Pick<Onboarding, 'method' | 'done'>) =>
  setupSteps(state.method).filter((s) => state.done.includes(s.id)).length;

export const setupComplete = (state: Onboarding) =>
  doneCount(state) === setupSteps(state.method).length;

/**
 * Ends onboarding and opens the wallet. A new wallet starts empty; a restored one
 * already holds money (the demo portfolio). Backing up is done already when the user
 * wrote down a phrase. Social sign-in is a demo and does not back up keys.
 */
export function finishOnboarding(
  method: SignInMethod,
  { restored = method === 'import', email }: { restored?: boolean; email?: string } = {},
) {
  const backedUp = method === 'phrase';
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

/** Demo-only purchase walkthrough: show the fixture portfolio without claiming receipt. */
export function markDemoFunded() {
  if (onboarding.get().funded) return;
  onboarding.set((s) => ({ ...s, funded: true }));
  showToast('Demo balance updated');
}

/** Ticks off a setup step; the last one unlocks the fee credit. */
export function completeStep(step: SetupStep) {
  const state = onboarding.get();
  if (state.done.includes(step)) return;
  const done = [...state.done, step];
  const finished = doneCount({ method: state.method, done }) === setupSteps(state.method).length;
  onboarding.set({ ...state, done, credit: finished ? SETUP_REWARD_USD : state.credit });
  if (finished) showToast(`$${SETUP_REWARD_USD} fee credit unlocked`);
}

/**
 * Signs out: the wallet comes off this phone (keys, profile and wallets added here),
 * and the app goes back to Welcome. The money stays where it is, on the network, and
 * is accessible again with the original recovery phrase or private key.
 */
export async function signOut(confirmedAccountIds: readonly string[]) {
  // Revoke/forget backend credentials before removing the owner wallet. Local
  // refresh material is deleted even when the server cannot be reached.
  await forgetSavedBackendSession();
  await eraseVault(confirmedAccountIds);
  // Honey for Chrome: no website stays connected to wallets that just left.
  await forgetSites();
  onboarding.set({ method: null, funded: false, done: [], credit: 0 });
  wallets.set({ activeId: 'main', added: [] });
  setProfile({ name: 'Honey', photo: null, avatarSeed: randomAvatarSeed() });
  router.dismissAll();
  router.replace('/welcome');
}
