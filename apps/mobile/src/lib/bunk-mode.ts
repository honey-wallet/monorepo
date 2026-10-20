import { type BunkNetwork, deriveBunkRotation, withMnemonicSeed } from '@honey-wallet/keyring';
import { createStore } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';
import { readPrimaryMnemonic } from '@/lib/vault';

export type BunkChain = 'evm' | 'solana' | 'bitcoin';

export type BunkAccount = {
  chain: BunkChain;
  label: string;
  /** The current one-time owner key's address (not the smart account's address). */
  owner: string;
  /** The next one-time owner key's address: it signs the next transaction. */
  next: string;
  /** Commitment to the next owner, registered ahead of time. */
  nextCommitment: string;
  rotations: number;
  sample: boolean;
};

export type BunkActivity = { id: string; chain: BunkChain; title: string; when: string };

/**
 * Opt-in, off by default in the real app. Test mode starts with it on so its screens can be
 * reviewed; only test mode can turn it on (see `bunkToggle`).
 */
export const bunkMode = createStore<{ enabled: boolean }>(
  { enabled: TEST_MODE },
  { persist: 'bunk-mode' },
);

const NETWORKS: Record<BunkChain, { label: string; network: BunkNetwork }> = {
  evm: { label: 'Ethereum', network: { family: 'evm', chainId: '1' } },
  solana: {
    label: 'Solana',
    network: { family: 'solana', genesisHash: '5eykt4UsFv8P8NJdTREpY1vuAUSKWq8W7GhKWCa9eBYW' },
  },
  bitcoin: { label: 'Bitcoin', network: { family: 'bitcoin', network: 'mainnet' } },
};

export const BUNK_CHAINS = Object.keys(NETWORKS) as BunkChain[];

const SAMPLE_ROTATIONS: Record<BunkChain, number> = { evm: 7, solana: 3, bitcoin: 1 };

/**
 * Current and next owners for each chain, derived from the primary recovery phrase.
 * Rotation counts come from chain state, which isn't live: real accounts show 0.
 * In test mode the counts are sample values.
 */
export async function loadBunkAccounts(): Promise<BunkAccount[] | null> {
  const phrase = await readPrimaryMnemonic();
  if (!phrase) return TEST_MODE ? sampleAccounts() : null;
  return withMnemonicSeed(phrase, (seed) =>
    BUNK_CHAINS.map((chain) => {
      const rotations = TEST_MODE ? SAMPLE_ROTATIONS[chain] : 0;
      const { current, next } = deriveBunkRotation(seed, {
        network: NETWORKS[chain].network,
        accountIndex: 0,
        ownerIndex: rotations,
      });
      return {
        chain,
        label: NETWORKS[chain].label,
        owner: current.ownerAddress,
        next: next.ownerAddress,
        nextCommitment: next.commitment,
        rotations,
        sample: TEST_MODE,
      };
    }),
  );
}

function sampleAccounts(): BunkAccount[] {
  const owners: Record<BunkChain, string> = {
    evm: '0x5aE1b1f0c3d2E9A47b6C8d1f2E3a4B5c6D7e8F90',
    solana: 'BunkSamp1eOwner1111111111111111111111111111',
    bitcoin: 'bc1qsampleowner0000000000000000000000000000',
  };
  return BUNK_CHAINS.map((chain) => ({
    chain,
    label: NETWORKS[chain].label,
    owner: owners[chain],
    next: owners[chain],
    nextCommitment: `0x${'ab'.repeat(32)}`,
    rotations: SAMPLE_ROTATIONS[chain],
    sample: true,
  }));
}

/** Sample activity for test mode only. */
export const SAMPLE_BUNK_ACTIVITY: BunkActivity[] = [
  { id: 'a1', chain: 'evm', title: 'Sent 0.05 ETH · new owner key', when: 'Today' },
  { id: 'a2', chain: 'solana', title: 'Swapped SOL · new owner key', when: 'Yesterday' },
  { id: 'a3', chain: 'evm', title: 'Approved USDC · new owner key', when: 'Oct 15' },
  { id: 'a4', chain: 'bitcoin', title: 'Sent 0.001 BTC · new owner key', when: 'Oct 12' },
];
