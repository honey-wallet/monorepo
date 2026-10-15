import type { Chain } from '@/lib/mock-wallet';
import { createStore } from '@/lib/store';

/** A token on a specific network; the same symbol can live on several. */
export type TokenRef = { symbol: string; chain: Chain };

type SwapState = {
  sell: TokenRef;
  buy: TokenRef;
  /** Network filter in the token picker; null shows every network. */
  network: Chain | null;
  /** The "bridging is built in" banner, once dismissed, stays hidden. */
  bridgeTipDismissed: boolean;
};

/**
 * Swap form state shared with the token and network picker sheets. Swap also
 * bridges: when `sell` and `buy` are on different networks the route crosses chains.
 */
export const swap = createStore<SwapState>({
  sell: { symbol: 'ETH', chain: 'Ethereum' },
  buy: { symbol: 'SOL', chain: 'Solana' },
  network: null,
  bridgeTipDismissed: false,
});

export const useSwap = swap.use;

export function updateSwap(update: Partial<SwapState>) {
  swap.set((prev) => ({ ...prev, ...update }));
}

/** Picks a token for one side; picking the other side's token flips the pair. */
export function pickToken(side: 'sell' | 'buy', token: TokenRef) {
  swap.set((prev) => {
    const other = side === 'sell' ? 'buy' : 'sell';
    const same = prev[other].symbol === token.symbol && prev[other].chain === token.chain;
    return { ...prev, [side]: token, ...(same ? { [other]: prev[side] } : {}) };
  });
}
