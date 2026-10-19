import { describe, expect, it, vi } from 'vitest';
import { isPolymarketCatalog, isPolymarketOrderBook } from './polymarket';

describe('Polymarket read-only catalog contract', () => {
  it('accepts catalog data while keeping execution disabled', () => {
    expect(
      isPolymarketCatalog({
        schemaVersion: 1,
        executionAvailable: false,
        dataStatus: 'fresh',
        fetchedAtMs: 1000,
        ageMs: 1,
        sourceTruncated: false,
        nextCursor: null,
        markets: [
          {
            id: '703257',
            slug: 'example',
            question: 'Question?',
            conditionId: '0xabc',
            version: 'v1',
            outcomeTokenIds: ['yes', 'no'],
            positionIds: [],
            orderBookEnabled: true,
            active: true,
            closed: false,
          },
        ],
      }),
    ).toBe(true);
  });
  it('rejects any response that advertises execution', () => {
    expect(
      isPolymarketCatalog({
        schemaVersion: 1,
        executionAvailable: true,
        dataStatus: 'fresh',
        fetchedAtMs: 1000,
        ageMs: 1,
        sourceTruncated: false,
        nextCursor: null,
        markets: [],
      }),
    ).toBe(false);
  });
  it('validates bounded snapshot pagination metadata', () => {
    expect(
      isPolymarketCatalog({ ...validCatalog(), nextCursor: '100', sourceTruncated: true }),
    ).toBe(true);
    expect(isPolymarketCatalog({ ...validCatalog(), nextCursor: '1000' })).toBe(false);
    expect(isPolymarketCatalog({ ...validCatalog(), nextCursor: '1x' })).toBe(false);
  });
  it('accepts V2 position identifiers when CLOB token identifiers are absent', () => {
    expect(
      isPolymarketCatalog({
        schemaVersion: 1,
        executionAvailable: false,
        dataStatus: 'stale',
        fetchedAtMs: 1000,
        ageMs: 31000,
        sourceTruncated: false,
        nextCursor: null,
        markets: [
          {
            id: '1',
            slug: null,
            question: null,
            conditionId: null,
            version: 'v2',
            outcomeTokenIds: [],
            positionIds: ['yes-position', 'no-position'],
            orderBookEnabled: false,
            active: true,
            closed: false,
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects malformed Gamma outcome identifiers and unknown market versions', () => {
    const market = {
      id: '1',
      slug: null,
      question: null,
      conditionId: null,
      version: 'v1',
      outcomeTokenIds: ['yes token'],
      positionIds: [],
      orderBookEnabled: true,
      active: true,
      closed: false,
    };
    const catalog = { ...validCatalog(), markets: [market] };
    expect(isPolymarketCatalog(catalog)).toBe(false);
    expect(
      isPolymarketCatalog({
        ...catalog,
        markets: [{ ...market, outcomeTokenIds: ['yes'], version: 'v3' }],
      }),
    ).toBe(false);
  });
});

function validCatalog() {
  return {
    schemaVersion: 1,
    executionAvailable: false,
    dataStatus: 'fresh',
    fetchedAtMs: 1,
    ageMs: 0,
    sourceTruncated: false,
    nextCursor: null,
    markets: [],
  } as const;
}

it('accepts bounded public order books only when execution stays disabled', () => {
  const book = {
    schemaVersion: 1,
    executionAvailable: false,
    dataStatus: 'fresh',
    fetchedAtMs: 1000,
    ageMs: 0,
    book: {
      marketId: 'condition-4',
      assetId: 'token-4',
      timestamp: '1700000000',
      hash: 'hash123',
      bids: [{ price: '0.45', size: '100' }],
      asks: [{ price: '0.46', size: '150' }],
      minOrderSize: '1',
      tickSize: '0.01',
      negativeRisk: false,
      lastTradePrice: '0.45',
    },
  };
  expect(isPolymarketOrderBook(book)).toBe(true);
  expect(isPolymarketOrderBook({ ...book, executionAvailable: true })).toBe(false);
  expect(isPolymarketOrderBook({ ...book, ageMs: 60_001 })).toBe(false);
  expect(
    isPolymarketOrderBook({
      ...book,
      book: { ...book.book, bids: Array(501).fill({ price: '0.1', size: '1' }) },
    }),
  ).toBe(false);
});

it('uses the typed API route with safely encoded token IDs and rejects invalid IDs locally', async () => {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          executionAvailable: false,
          dataStatus: 'fresh',
          fetchedAtMs: 1000,
          ageMs: 0,
          book: {
            marketId: 'condition-4',
            assetId: 'token-4',
            timestamp: '1700000000',
            hash: 'hash123',
            bids: [],
            asks: [],
            minOrderSize: '1',
            tickSize: '0.01',
            negativeRisk: false,
            lastTradePrice: '0.45',
          },
        }),
        { status: 200 },
      ),
  );
  const { createApiClient } = await import('./client');
  const api = createApiClient({ baseUrl: 'https://api.example', fetch: fetchMock as typeof fetch });
  await expect(api.polymarketOrderBook('token-4')).resolves.toMatchObject({
    book: { assetId: 'token-4' },
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'https://api.example/api/v1/prediction/order-book?token_id=token-4',
  );
  expect(() => api.polymarketOrderBook('bad token')).toThrow(
    expect.objectContaining({ code: 'invalid_token_id' }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('requests a bounded catalog page using the server snapshot cursor', async () => {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ ...validCatalog(), nextCursor: null, sourceTruncated: true }), {
        status: 200,
      }),
  );
  const { createApiClient } = await import('./client');
  const api = createApiClient({ baseUrl: 'https://api.example', fetch: fetchMock as typeof fetch });
  await expect(api.polymarketCatalog(undefined, '100')).resolves.toMatchObject({
    sourceTruncated: true,
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'https://api.example/api/v1/prediction/markets?cursor=100',
  );
  expect(() => api.polymarketCatalog(undefined, '1000')).toThrow(
    expect.objectContaining({ code: 'invalid_catalog_cursor' }),
  );
});
