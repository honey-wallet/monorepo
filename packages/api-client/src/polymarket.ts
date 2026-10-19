import type { PolymarketCatalog, PolymarketOrderBook } from './types';

const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function isPolymarketCatalog(value: unknown): value is PolymarketCatalog {
  return (
    obj(value) &&
    value.schemaVersion === 1 &&
    value.executionAvailable === false &&
    (value.dataStatus === 'fresh' || value.dataStatus === 'stale') &&
    typeof value.fetchedAtMs === 'number' &&
    Number.isSafeInteger(value.fetchedAtMs) &&
    value.fetchedAtMs > 0 &&
    typeof value.ageMs === 'number' &&
    Number.isSafeInteger(value.ageMs) &&
    value.ageMs >= 0 &&
    value.ageMs <= 300000 &&
    typeof value.sourceTruncated === 'boolean' &&
    (value.nextCursor === null ||
      (typeof value.nextCursor === 'string' && /^(?:[1-9]\d{0,2})$/.test(value.nextCursor))) &&
    Array.isArray(value.markets) &&
    value.markets.length <= 100 &&
    value.markets.every(
      (market) =>
        obj(market) &&
        typeof market.id === 'string' &&
        market.id.length > 0 &&
        market.id.length <= 64 &&
        (market.slug === null || typeof market.slug === 'string') &&
        (market.question === null || typeof market.question === 'string') &&
        (market.conditionId === null || typeof market.conditionId === 'string') &&
        (market.version === null || typeof market.version === 'string') &&
        Array.isArray(market.outcomeTokenIds) &&
        market.outcomeTokenIds.length <= 8 &&
        market.outcomeTokenIds.every((id) => typeof id === 'string') &&
        Array.isArray(market.positionIds) &&
        market.positionIds.length <= 8 &&
        market.positionIds.every(validProviderId) &&
        market.outcomeTokenIds.every(validProviderId) &&
        (market.version === null || market.version === 'v1' || market.version === 'v2') &&
        typeof market.orderBookEnabled === 'boolean' &&
        typeof market.active === 'boolean' &&
        typeof market.closed === 'boolean',
    )
  );
}

export function isPolymarketOrderBook(value: unknown): value is PolymarketOrderBook {
  const decimal = (input: unknown): input is string =>
    typeof input === 'string' && input.length <= 64 && /^(?:\d+)(?:\.\d+)?$/.test(input);
  const compareDecimal = (left: string, right: string) => {
    const parts = (input: string) => {
      const [integer = '0', fraction = ''] = input.split('.');
      return [integer.replace(/^0+/, '') || '0', fraction.replace(/0+$/, '')] as const;
    };
    const [leftInteger, leftFraction] = parts(left);
    const [rightInteger, rightFraction] = parts(right);
    if (leftInteger.length !== rightInteger.length)
      return leftInteger.length < rightInteger.length ? -1 : 1;
    if (leftInteger !== rightInteger) return leftInteger < rightInteger ? -1 : 1;
    const width = Math.max(leftFraction.length, rightFraction.length);
    const a = leftFraction.padEnd(width, '0');
    const b = rightFraction.padEnd(width, '0');
    return a === b ? 0 : a < b ? -1 : 1;
  };
  const levels = (input: unknown, descending: boolean) => {
    if (!Array.isArray(input) || input.length > 500) return false;
    let prior: string | null = null;
    for (const item of input) {
      if (!obj(item) || !decimal(item.price) || !decimal(item.size)) return false;
      if (
        compareDecimal(item.price, '1') > 0 ||
        compareDecimal(item.size, '0') <= 0 ||
        (prior !== null &&
          (descending
            ? compareDecimal(item.price, prior) >= 0
            : compareDecimal(item.price, prior) <= 0))
      )
        return false;
      prior = item.price;
    }
    return true;
  };
  if (
    !obj(value) ||
    value.schemaVersion !== 1 ||
    value.executionAvailable !== false ||
    (value.dataStatus !== 'fresh' && value.dataStatus !== 'stale') ||
    typeof value.fetchedAtMs !== 'number' ||
    !Number.isSafeInteger(value.fetchedAtMs) ||
    value.fetchedAtMs <= 0 ||
    typeof value.ageMs !== 'number' ||
    !Number.isSafeInteger(value.ageMs) ||
    value.ageMs < 0 ||
    value.ageMs > 60_000 ||
    !obj(value.book)
  )
    return false;
  const book = value.book;
  return (
    typeof book.marketId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(book.marketId) &&
    typeof book.assetId === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(book.assetId) &&
    typeof book.timestamp === 'string' &&
    /^\d{1,32}$/.test(book.timestamp) &&
    typeof book.hash === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(book.hash) &&
    levels(book.bids, true) &&
    levels(book.asks, false) &&
    decimal(book.minOrderSize) &&
    compareDecimal(book.minOrderSize, '0') > 0 &&
    decimal(book.tickSize) &&
    compareDecimal(book.tickSize, '0') > 0 &&
    compareDecimal(book.tickSize, '1') <= 0 &&
    typeof book.negativeRisk === 'boolean' &&
    decimal(book.lastTradePrice) &&
    compareDecimal(book.lastTradePrice, '1') <= 0
  );
}

function validProviderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}
