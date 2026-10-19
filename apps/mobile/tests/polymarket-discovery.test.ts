import type { PolymarketCatalog } from '@honey-wallet/api-client';
import { describe, expect, it } from 'vitest';
import { predictionMarketRows } from '../src/lib/polymarket-discovery';

const catalog: PolymarketCatalog = {
  schemaVersion: 1,
  executionAvailable: false,
  dataStatus: 'stale',
  fetchedAtMs: 1_700_000_000_000,
  ageMs: 30_000,
  sourceTruncated: true,
  nextCursor: '20',
  markets: [
    {
      id: 'market-1',
      slug: 'example-market',
      question: '  Will it happen? ',
      conditionId: 'condition-1',
      version: '1',
      outcomeTokenIds: ['token-yes', 'token-no'],
      positionIds: [],
      orderBookEnabled: true,
      active: true,
      closed: false,
    },
    {
      id: 'market-2',
      slug: null,
      question: null,
      conditionId: null,
      version: null,
      outcomeTokenIds: [],
      positionIds: [],
      orderBookEnabled: false,
      active: false,
      closed: true,
    },
  ],
};

describe('mobile Polymarket discovery projection', () => {
  it('projects only display-safe fields and does not expose execution identifiers', () => {
    const rows = predictionMarketRows(catalog);

    expect(rows).toEqual([
      {
        id: 'market-1',
        question: 'Will it happen?',
        slug: 'example-market',
        active: true,
        closed: false,
      },
      { id: 'market-2', question: 'Untitled market', slug: null, active: false, closed: true },
    ]);
    expect(rows[0]).not.toHaveProperty('outcomeTokenIds');
    expect(rows[0]).not.toHaveProperty('orderBookEnabled');
  });

  it('retains freshness and bounded-pagination signals from the validated catalog', () => {
    expect(catalog.executionAvailable).toBe(false);
    expect(catalog.dataStatus).toBe('stale');
    expect(catalog.sourceTruncated).toBe(true);
    expect(catalog.nextCursor).toBe('20');
  });
});
