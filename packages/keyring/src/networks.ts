/**
 * The networks websites can use through Honey for Chrome, with a public RPC for each.
 * Shared by the extension's background worker (read-only calls) and the app (sending).
 * Kept free of other imports so the worker can bundle it alone.
 */

export type EvmNetwork = {
  chainId: number;
  name: string;
  /** The gas token's symbol. */
  native: string;
  rpc: string;
  /** Block explorer, for "View transaction". */
  explorer: string;
  testnet?: boolean;
};

export const EVM_NETWORKS: EvmNetwork[] = [
  {
    chainId: 1,
    name: 'Ethereum',
    native: 'ETH',
    rpc: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io',
  },
  {
    chainId: 8453,
    name: 'Base',
    native: 'ETH',
    rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
  },
  {
    chainId: 42161,
    name: 'Arbitrum One',
    native: 'ETH',
    rpc: 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io',
  },
  {
    chainId: 10,
    name: 'OP Mainnet',
    native: 'ETH',
    rpc: 'https://mainnet.optimism.io',
    explorer: 'https://optimistic.etherscan.io',
  },
  {
    chainId: 137,
    name: 'Polygon',
    native: 'POL',
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    explorer: 'https://polygonscan.com',
  },
  {
    chainId: 56,
    name: 'BNB Smart Chain',
    native: 'BNB',
    rpc: 'https://bsc-rpc.publicnode.com',
    explorer: 'https://bscscan.com',
  },
  {
    chainId: 43114,
    name: 'Avalanche C-Chain',
    native: 'AVAX',
    rpc: 'https://api.avax.network/ext/bc/C/rpc',
    explorer: 'https://snowtrace.io',
  },
  {
    chainId: 100,
    name: 'Gnosis',
    native: 'XDAI',
    rpc: 'https://rpc.gnosischain.com',
    explorer: 'https://gnosisscan.io',
  },
  {
    chainId: 59144,
    name: 'Linea',
    native: 'ETH',
    rpc: 'https://rpc.linea.build',
    explorer: 'https://lineascan.build',
  },
  {
    chainId: 534352,
    name: 'Scroll',
    native: 'ETH',
    rpc: 'https://rpc.scroll.io',
    explorer: 'https://scrollscan.com',
  },
  {
    chainId: 11155111,
    name: 'Sepolia',
    native: 'ETH',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    testnet: true,
  },
  {
    chainId: 84532,
    name: 'Base Sepolia',
    native: 'ETH',
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    testnet: true,
  },
];

/** Where a site starts before it asks for another network. */
export const DEFAULT_CHAIN_ID = 1;

export const evmNetwork = (chainId: number) => EVM_NETWORKS.find((n) => n.chainId === chainId);

export const SOLANA_MAINNET = {
  chain: 'solana:mainnet',
  name: 'Solana',
  rpc: 'https://api.mainnet-beta.solana.com',
  explorer: 'https://solscan.io',
} as const;

export const NEAR_NETWORKS = {
  mainnet: {
    name: 'NEAR',
    rpc: 'https://rpc.mainnet.near.org',
    explorer: 'https://nearblocks.io',
  },
  testnet: {
    name: 'NEAR Testnet',
    rpc: 'https://rpc.testnet.near.org',
    explorer: 'https://testnet.nearblocks.io',
  },
} as const;

export type NearNetwork = keyof typeof NEAR_NETWORKS;
