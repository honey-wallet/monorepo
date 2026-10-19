import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './lib/api';
import PredictionMarkets from './PredictionMarkets';

afterEach(() => vi.restoreAllMocks());

it('renders versioned public market metadata without offering order actions', async () => {
  vi.spyOn(api, 'polymarketCatalog').mockResolvedValue({
    schemaVersion: 1,
    executionAvailable: false,
    dataStatus: 'fresh',
    fetchedAtMs: Date.now(),
    ageMs: 0,
    sourceTruncated: false,
    nextCursor: null,
    markets: [
      {
        id: 'market-1',
        slug: 'will-it-happen',
        question: 'Will it happen?',
        conditionId: '0xabc',
        version: 'v2',
        outcomeTokenIds: [],
        positionIds: ['yes-position', 'no-position'],
        orderBookEnabled: false,
        active: true,
        closed: false,
      },
    ],
  });

  render(<PredictionMarkets />);
  expect(await screen.findByText('Will it happen?')).toBeInTheDocument();
  expect(screen.getByText('V2 · 2 outcome identifiers')).toBeInTheDocument();
  expect(screen.getByText(/market metadata only/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /buy|sell|order/i })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View on Polymarket' })).toHaveAttribute(
    'href',
    'https://polymarket.com/event/will-it-happen',
  );
});

it('shows an unavailable state when the public market API fails', async () => {
  vi.spyOn(api, 'polymarketCatalog').mockRejectedValue(new Error('unavailable'));
  render(<PredictionMarkets />);
  expect(await screen.findByRole('status')).toHaveTextContent('Public market data is unavailable.');
});

it('loads the next bounded catalog page without replacing prior markets', async () => {
  const loadCatalog = vi.spyOn(api, 'polymarketCatalog');
  loadCatalog
    .mockResolvedValueOnce({
      schemaVersion: 1,
      executionAvailable: false,
      dataStatus: 'fresh',
      fetchedAtMs: Date.now(),
      ageMs: 0,
      sourceTruncated: false,
      nextCursor: '100',
      markets: [
        {
          id: 'market-one',
          slug: null,
          question: 'First page question?',
          conditionId: null,
          version: null,
          outcomeTokenIds: [],
          positionIds: [],
          orderBookEnabled: false,
          active: true,
          closed: false,
        },
      ],
    })
    .mockResolvedValueOnce({
      schemaVersion: 1,
      executionAvailable: false,
      dataStatus: 'fresh',
      fetchedAtMs: Date.now(),
      ageMs: 1,
      sourceTruncated: false,
      nextCursor: null,
      markets: [
        {
          id: 'market-two',
          slug: null,
          question: 'Second page question?',
          conditionId: null,
          version: null,
          outcomeTokenIds: [],
          positionIds: [],
          orderBookEnabled: false,
          active: true,
          closed: false,
        },
      ],
    });

  render(<PredictionMarkets />);
  expect(await screen.findByText('First page question?')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more markets' }));
  expect(await screen.findByText('Second page question?')).toBeInTheDocument();
  expect(screen.getByText('First page question?')).toBeInTheDocument();
  expect(loadCatalog).toHaveBeenNthCalledWith(2, undefined, '100');
  expect(screen.queryByRole('button', { name: 'Load more markets' })).not.toBeInTheDocument();
});

it('restarts pagination when the catalog snapshot changes between page requests', async () => {
  const loadCatalog = vi.spyOn(api, 'polymarketCatalog');
  const market = (id: string, question: string) => ({
    id,
    slug: null,
    question,
    conditionId: null,
    version: null,
    outcomeTokenIds: [],
    positionIds: [],
    orderBookEnabled: false,
    active: true,
    closed: false,
  });
  loadCatalog
    .mockResolvedValueOnce({
      schemaVersion: 1,
      executionAvailable: false,
      dataStatus: 'fresh',
      fetchedAtMs: 1_000,
      ageMs: 0,
      sourceTruncated: false,
      nextCursor: '100',
      markets: [market('old-first', 'Old snapshot first page?')],
    })
    .mockResolvedValueOnce({
      schemaVersion: 1,
      executionAvailable: false,
      dataStatus: 'fresh',
      fetchedAtMs: 2_000,
      ageMs: 0,
      sourceTruncated: false,
      nextCursor: null,
      markets: [market('new-second', 'Mixed snapshot second page?')],
    })
    .mockResolvedValueOnce({
      schemaVersion: 1,
      executionAvailable: false,
      dataStatus: 'fresh',
      fetchedAtMs: 2_000,
      ageMs: 1,
      sourceTruncated: false,
      nextCursor: '100',
      markets: [market('new-first', 'New snapshot first page?')],
    });

  render(<PredictionMarkets />);
  expect(await screen.findByText('Old snapshot first page?')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load more markets' }));
  expect(await screen.findByText('New snapshot first page?')).toBeInTheDocument();
  expect(screen.queryByText('Old snapshot first page?')).not.toBeInTheDocument();
  expect(screen.queryByText('Mixed snapshot second page?')).not.toBeInTheDocument();
  expect(screen.getByText(/pagination restarted/i)).toBeInTheDocument();
  expect(loadCatalog).toHaveBeenNthCalledWith(2, undefined, '100');
  expect(loadCatalog).toHaveBeenNthCalledWith(3);
});

it('loads a read-only order book only for an active Gamma CLOB token', async () => {
  vi.spyOn(api, 'polymarketCatalog').mockResolvedValue({
    schemaVersion: 1,
    executionAvailable: false,
    dataStatus: 'fresh',
    fetchedAtMs: Date.now(),
    ageMs: 0,
    sourceTruncated: false,
    nextCursor: null,
    markets: [
      {
        id: 'market-book',
        slug: null,
        question: 'Book market?',
        conditionId: 'condition-4',
        version: 'v1',
        outcomeTokenIds: ['token-4'],
        positionIds: [],
        orderBookEnabled: true,
        active: true,
        closed: false,
      },
    ],
  });
  const readBook = vi.spyOn(api, 'polymarketOrderBook').mockResolvedValue({
    schemaVersion: 1,
    executionAvailable: false,
    dataStatus: 'fresh',
    fetchedAtMs: Date.now(),
    ageMs: 0,
    book: {
      marketId: 'condition-4',
      assetId: 'token-4',
      timestamp: '1700000000',
      hash: 'hash123',
      bids: [{ price: '0.45', size: '10' }],
      asks: [{ price: '0.46', size: '12' }],
      minOrderSize: '1',
      tickSize: '0.01',
      negativeRisk: false,
      lastTradePrice: '0.45',
    },
  });
  render(<PredictionMarkets />);
  fireEvent.click(await screen.findByRole('button', { name: 'View outcome 1 book' }));
  expect(await screen.findByText('fresh book · best bid 0.45 · best ask 0.46')).toBeInTheDocument();
  expect(readBook).toHaveBeenCalledWith('token-4');
  expect(screen.queryByRole('button', { name: /buy|sell|submit order/i })).not.toBeInTheDocument();
});
