/** NEAR Intents 1Click previews; no deposit or transaction payload is exposed. */
export interface NearIntentsQuoteRequest {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  slippageTolerance: number;
}

export interface NearIntentsToken {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress: string | null;
}

export interface NearIntentsQuotePreview {
  provider: 'near_intents';
  executionAvailable: false;
  originAsset: string;
  destinationAsset: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  quotedAt: string;
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && /^[\x21-\x7e]+$/.test(v);
const uint = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,77}$/.test(v) && BigInt(v) < 1n << 256n;
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));

export function isNearIntentsQuoteRequest(v: unknown): v is NearIntentsQuoteRequest {
  return (
    record(v) &&
    exact(v, ['originAsset', 'destinationAsset', 'amount', 'recipient', 'slippageTolerance']) &&
    text(v.originAsset, 256) &&
    text(v.destinationAsset, 256) &&
    v.originAsset !== v.destinationAsset &&
    uint(v.amount) &&
    text(v.recipient, 128) &&
    typeof v.slippageTolerance === 'number' &&
    Number.isInteger(v.slippageTolerance) &&
    v.slippageTolerance >= 0 &&
    v.slippageTolerance <= 500
  );
}

export function isNearIntentsTokens(v: unknown): v is NearIntentsToken[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 4096) return false;
  const ids = new Set<string>();
  return v.every((token) => {
    if (
      !record(token) ||
      !exact(token, ['assetId', 'blockchain', 'symbol', 'decimals', 'contractAddress']) ||
      !text(token.assetId, 256) ||
      ids.has(token.assetId) ||
      !text(token.blockchain, 32) ||
      !text(token.symbol, 32) ||
      typeof token.decimals !== 'number' ||
      !Number.isInteger(token.decimals) ||
      token.decimals < 0 ||
      token.decimals > 38 ||
      !(token.contractAddress === null || text(token.contractAddress, 256))
    )
      return false;
    ids.add(token.assetId);
    return true;
  });
}

export function isNearIntentsQuotePreview(v: unknown): v is NearIntentsQuotePreview {
  return (
    record(v) &&
    exact(v, [
      'provider',
      'executionAvailable',
      'originAsset',
      'destinationAsset',
      'amountIn',
      'amountOut',
      'minAmountOut',
      'quotedAt',
    ]) &&
    v.provider === 'near_intents' &&
    v.executionAvailable === false &&
    text(v.originAsset, 256) &&
    text(v.destinationAsset, 256) &&
    v.originAsset !== v.destinationAsset &&
    uint(v.amountIn) &&
    uint(v.amountOut) &&
    uint(v.minAmountOut) &&
    BigInt(v.minAmountOut) <= BigInt(v.amountOut) &&
    typeof v.quotedAt === 'string' &&
    v.quotedAt.length <= 40 &&
    Number.isFinite(Date.parse(v.quotedAt))
  );
}
