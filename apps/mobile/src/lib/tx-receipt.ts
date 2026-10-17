import type { Chain } from '@/lib/mock-wallet';

const HEX = '0123456789abcdef';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Where each chain's transactions are looked up. */
const EXPLORERS: Record<Chain, { name: string; tx: (hash: string) => string }> = {
  Ethereum: { name: 'Etherscan', tx: (h) => `https://etherscan.io/tx/${h}` },
  Base: { name: 'Basescan', tx: (h) => `https://basescan.org/tx/${h}` },
  Solana: { name: 'Solscan', tx: (h) => `https://solscan.io/tx/${h}` },
  Bitcoin: { name: 'mempool.space', tx: (h) => `https://mempool.space/tx/${h}` },
  Tron: { name: 'Tronscan', tx: (h) => `https://tronscan.org/#/transaction/${h}` },
  'XRP Ledger': { name: 'XRPScan', tx: (h) => `https://xrpscan.com/tx/${h}` },
};

/**
 * A just-sent transaction's id and where to see it. Demo data until sends hit a real
 * chain: a hash in that chain's format, derived from `seed` so it stays put on re-render.
 */
export function txReceipt(chain: Chain, seed: string) {
  let n = 0;
  for (const ch of seed) n = (Math.imul(n, 31) + ch.charCodeAt(0)) >>> 0;
  const next = () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n >>> 16;
  };
  const pick = (alphabet: string, length: number) =>
    Array.from({ length }, () => alphabet[next() % alphabet.length]).join('');
  const hash =
    chain === 'Solana'
      ? pick(BASE58, 88)
      : chain === 'XRP Ledger'
        ? pick(HEX, 64).toUpperCase()
        : chain === 'Bitcoin' || chain === 'Tron'
          ? pick(HEX, 64)
          : `0x${pick(HEX, 64)}`;
  const explorer = EXPLORERS[chain];
  return { hash, explorer: { name: explorer.name, url: explorer.tx(hash) } };
}
