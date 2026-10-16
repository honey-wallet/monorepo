// Demo collectibles and DeFi positions for Home's NFTs and Positions tabs. Mock data
// like the rest of the wallet; the art is drawn from each NFT's seed (NftArt).

export type Nft = {
  id: string;
  name: string;
  collection: string;
  chain: 'Ethereum' | 'Base' | 'Solana';
  /** Drives the generated art: palette and shapes. */
  seed: number;
  /** Floor price in the chain's native token (ETH, or SOL on Solana). */
  floor: number;
  traits: { type: string; value: string; rarity: number }[];
};

export const NFTS: Nft[] = [
  {
    id: 'bear-412',
    name: 'Honey Bear #412',
    collection: 'Honey Bears',
    chain: 'Base',
    seed: 412,
    floor: 0.42,
    traits: [
      { type: 'Fur', value: 'Golden', rarity: 4 },
      { type: 'Eyes', value: 'Sleepy', rarity: 12 },
      { type: 'Hat', value: 'Beekeeper', rarity: 2 },
      { type: 'Background', value: 'Meadow', rarity: 18 },
    ],
  },
  {
    id: 'bear-77',
    name: 'Honey Bear #77',
    collection: 'Honey Bears',
    chain: 'Base',
    seed: 77,
    floor: 0.42,
    traits: [
      { type: 'Fur', value: 'Cinnamon', rarity: 9 },
      { type: 'Eyes', value: 'Wink', rarity: 6 },
      { type: 'Background', value: 'Dusk', rarity: 11 },
    ],
  },
  {
    id: 'hive-3',
    name: 'Hive Pass #3',
    collection: 'Hive Pass',
    chain: 'Ethereum',
    seed: 3,
    floor: 1.8,
    traits: [
      { type: 'Tier', value: 'Queen', rarity: 1 },
      { type: 'Cells', value: 'Seven', rarity: 7 },
    ],
  },
  {
    id: 'blob-1290',
    name: 'Based Blob #1290',
    collection: 'Based Blobs',
    chain: 'Base',
    seed: 1290,
    floor: 0.008,
    traits: [
      { type: 'Shape', value: 'Wobble', rarity: 22 },
      { type: 'Mood', value: 'Sunny', rarity: 15 },
      { type: 'Glow', value: 'Soft', rarity: 30 },
    ],
  },
  {
    id: 'mad-88',
    name: 'Mad Lad #88',
    collection: 'Mad Lads',
    chain: 'Solana',
    seed: 88,
    floor: 18,
    traits: [
      { type: 'Jacket', value: 'Varsity', rarity: 5 },
      { type: 'Mouth', value: 'Grin', rarity: 10 },
    ],
  },
  {
    id: 'blob-44',
    name: 'Based Blob #44',
    collection: 'Based Blobs',
    chain: 'Base',
    seed: 44,
    floor: 0.008,
    traits: [
      { type: 'Shape', value: 'Drop', rarity: 8 },
      { type: 'Mood', value: 'Calm', rarity: 19 },
    ],
  },
];

export type Position = {
  id: string;
  kind: 'liquidity' | 'lending' | 'staking' | 'vault';
  title: string;
  protocol: string;
  symbols: string[];
  usd: number;
  apy: number;
  /** Rewards earned and not yet claimed, in USD. */
  earned: number;
  /** Liquidity: the price range and where the price sits now. */
  range?: { min: number; max: number; price: number; unit: string };
  /** Lending: supplied, borrowed and the health factor. */
  health?: { supplied: number; borrowed: number; factor: number };
};

export const POSITIONS: Position[] = [
  {
    id: 'uni-eth-usdc',
    kind: 'liquidity',
    title: 'ETH / USDC',
    protocol: 'Uniswap v3',
    symbols: ['ETH', 'USDC'],
    usd: 1240.5,
    apy: 18.4,
    earned: 4.12,
    range: { min: 2200, max: 2900, price: 2510, unit: 'USDC per ETH' },
  },
  {
    id: 'aave-usdc',
    kind: 'lending',
    title: 'USDC supply',
    protocol: 'Aave',
    symbols: ['USDC'],
    usd: 820,
    apy: 4.9,
    earned: 1.06,
    health: { supplied: 820, borrowed: 310, factor: 2.12 },
  },
  {
    id: 'lido-eth',
    kind: 'staking',
    title: 'Staked ETH',
    protocol: 'Lido',
    symbols: ['ETH'],
    usd: 312.4,
    apy: 3.1,
    earned: 0.37,
  },
  {
    id: 'jar-usdc',
    kind: 'vault',
    title: 'Honey Jar',
    protocol: 'Morpho vault',
    symbols: ['USDC'],
    usd: 58.3,
    apy: 6.2,
    earned: 0.09,
  },
];

/** Demo prices, in line with Home's ETH and SOL balances. */
export const ETH_USD = 2510;
export const SOL_USD = 148.7;

export const nftNative = (nft: Nft) => (nft.chain === 'Solana' ? 'SOL' : 'ETH');
export const nftFloorUsd = (nft: Nft) => nft.floor * (nft.chain === 'Solana' ? SOL_USD : ETH_USD);

/** An open trade: perps, a prediction, a future or an option. Value and P&L in USD. */
export type TradePosition = {
  id: string;
  mode: 'Perps' | 'Predict' | 'Futures' | 'Options';
  /** Token logo, or none for a prediction (it shows the predict icon). */
  symbol?: string;
  title: string;
  detail: string;
  usd: number;
  pnl: number;
  /** Where tapping it goes. */
  href: string;
};

export const TRADES: TradePosition[] = [
  {
    id: 'perp-btc',
    mode: 'Perps',
    symbol: 'BTC',
    title: 'BTC Long 5×',
    detail: 'Entry $97,240',
    usd: 250,
    pnl: 18.4,
    href: '/perp/BTC',
  },
  {
    id: 'predict-fed',
    mode: 'Predict',
    title: 'Fed cuts in December · Yes',
    detail: '40 shares at 62¢',
    usd: 28.4,
    pnl: 3.6,
    href: '/trade?mode=Predict',
  },
  {
    id: 'future-eth',
    mode: 'Futures',
    symbol: 'ETH',
    title: 'ETH Dec future · Short',
    detail: 'Entry $2,580',
    usd: 120,
    pnl: -4.2,
    href: '/trade?mode=Futures',
  },
  {
    id: 'option-eth',
    mode: 'Options',
    symbol: 'ETH',
    title: 'ETH $3,000 Call',
    detail: 'Expires Dec 26',
    usd: 42,
    pnl: -6.8,
    href: '/trade?mode=Options',
  },
];
