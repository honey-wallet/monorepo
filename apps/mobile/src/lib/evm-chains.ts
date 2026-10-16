/**
 * EVM networks a shared wallet (Safe) can live on. Safe deploys to any EVM chain,
 * so besides a short list of popular ones, every mainnet in the public chain
 * registry behind chainlist.org (ethereum-lists/chains) can be searched. The full
 * list (~1,400 mainnets) is fetched only when someone searches, then kept.
 */

export type EvmChain = {
  chainId: number;
  name: string;
  /** The native gas token, e.g. "ETH", "POL". */
  native: string;
  /** Brand colour for the letter badge, when there's no logo. */
  color?: string;
};

/** Shown first, most used first. Base is recommended: it's the cheapest to set up on. */
export const POPULAR_EVM: EvmChain[] = [
  { chainId: 8453, name: 'Base', native: 'ETH', color: '#0052FF' },
  { chainId: 1, name: 'Ethereum', native: 'ETH', color: '#627EEA' },
  { chainId: 42161, name: 'Arbitrum One', native: 'ETH', color: '#213147' },
  { chainId: 10, name: 'OP Mainnet', native: 'ETH', color: '#FF0420' },
  { chainId: 137, name: 'Polygon', native: 'POL', color: '#8247E5' },
  { chainId: 56, name: 'BNB Smart Chain', native: 'BNB', color: '#F0B90B' },
  { chainId: 43114, name: 'Avalanche C-Chain', native: 'AVAX', color: '#E84142' },
  { chainId: 100, name: 'Gnosis', native: 'XDAI', color: '#3E6957' },
  { chainId: 59144, name: 'Linea', native: 'ETH', color: '#121212' },
  { chainId: 534352, name: 'Scroll', native: 'ETH', color: '#EBC28E' },
  { chainId: 324, name: 'zkSync Era', native: 'ETH', color: '#4E529A' },
  { chainId: 42220, name: 'Celo', native: 'CELO', color: '#FCFF52' },
];

const REGISTRY = 'https://chainid.network/chains_mini.json';

/** Testnets and dev networks, by name; mainnets also have no faucets. */
const NOT_MAINNET =
  /test|sepolia|goerli|devnet|ropsten|rinkeby|holesky|hoodi|fuji|mumbai|amoy|chapel|kovan|staging|local/i;

type RegistryEntry = {
  name: string;
  chainId: number;
  nativeCurrency?: { symbol?: string };
  faucets?: string[];
  rpc?: string[];
};

let cache: Promise<EvmChain[]> | null = null;

/** Every EVM mainnet in the registry, popular ones first. Fetched once, then cached. */
export function loadEvmChains(): Promise<EvmChain[]> {
  if (!cache) {
    cache = fetch(REGISTRY)
      .then((res) => {
        if (!res.ok) throw new Error(`Chain registry: ${res.status}`);
        return res.json() as Promise<RegistryEntry[]>;
      })
      .then((entries) => {
        const popular = new Set(POPULAR_EVM.map((c) => c.chainId));
        const rest = entries
          .filter(
            (e) =>
              !popular.has(e.chainId) &&
              !e.faucets?.length &&
              (e.rpc?.length ?? 0) > 0 &&
              !NOT_MAINNET.test(e.name),
          )
          .map((e) => ({
            chainId: e.chainId,
            name: e.name.replace(/ Mainnet$/, ''),
            native: e.nativeCurrency?.symbol ?? 'ETH',
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return [...POPULAR_EVM, ...rest];
      })
      .catch((error) => {
        // Let the next search try again.
        cache = null;
        throw error;
      });
  }
  return cache;
}

/** Matches a search against a network's name, native token or chain id. */
export function matchesChain(chain: EvmChain, query: string) {
  const q = query.trim().toLowerCase();
  return (
    !q ||
    chain.name.toLowerCase().includes(q) ||
    chain.native.toLowerCase() === q ||
    String(chain.chainId) === q
  );
}
