import type { PolymarketCatalog, PolymarketMarket } from '@honey-wallet/api-client';

export type PredictionMarketRow = {
  id: string;
  question: string;
  slug: string | null;
  active: boolean;
  closed: boolean;
};

/** The catalog is discovery metadata only; deliberately excludes token and order data. */
export function predictionMarketRows(catalog: PolymarketCatalog): PredictionMarketRow[] {
  return catalog.markets.map((market: PolymarketMarket) => ({
    id: market.id,
    question: market.question?.trim() || 'Untitled market',
    slug: market.slug,
    active: market.active,
    closed: market.closed,
  }));
}
