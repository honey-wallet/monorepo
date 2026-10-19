import type { PriceStreamOptions } from '@honey-wallet/api-client';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './lib/api';
import MarketPrices from './MarketPrices';

afterEach(() => vi.restoreAllMocks());
it('shows precise venue prices, freshness and cleans up the shared stream', () => {
  let callbacks: PriceStreamOptions | undefined;
  const stop = vi.fn();
  vi.spyOn(api, 'subscribePrices').mockImplementation((options) => {
    callbacks = options;
    return stop;
  });
  const { unmount } = render(<MarketPrices />);
  expect(screen.getByText('Connecting to market prices…')).toBeInTheDocument();
  act(() => {
    callbacks?.onSnapshot({
      schemaVersion: 1,
      type: 'snapshot',
      epoch: '01234567-89ab-4cde-8fab-0123456789ab',
      sequence: '1',
      sampledAtMs: Date.now(),
      stale: true,
      source: 'hyperliquid',
      prices: [
        {
          instrumentId: 'hyperliquid:perp:BTC',
          symbol: 'BTC',
          quoteUnit: 'USDT',
          price: '60000.123456789',
          kind: 'mid_or_last',
        },
      ],
    });
    callbacks?.onState?.('stale');
  });
  expect(screen.getByText('Prices are out of date')).toBeInTheDocument();
  expect(screen.getByText('BTC: 60000.123456789 USDT (stale)')).toBeInTheDocument();
  unmount();
  expect(stop).toHaveBeenCalledTimes(1);
});

it('stops the price stream while hidden, marks the last snapshot stale, and reconnects when visible', () => {
  let callbacks: PriceStreamOptions | undefined;
  const stops = [vi.fn(), vi.fn()];
  let subscription = 0;
  vi.spyOn(api, 'subscribePrices').mockImplementation((options) => {
    callbacks = options;
    return stops[subscription++];
  });
  const { unmount } = render(<MarketPrices />);
  act(() =>
    callbacks?.onSnapshot({
      schemaVersion: 1,
      type: 'snapshot',
      epoch: '01234567-89ab-4cde-8fab-0123456789ab',
      sequence: '1',
      sampledAtMs: Date.now(),
      stale: false,
      source: 'hyperliquid',
      prices: [
        {
          instrumentId: 'hyperliquid:perp:BTC',
          symbol: 'BTC',
          quoteUnit: 'USDT',
          price: '60000',
          kind: 'mid_or_last',
        },
        {
          instrumentId: 'hyperliquid:perp:ETH',
          symbol: 'ETH',
          quoteUnit: 'USDT',
          price: '3000',
          kind: 'mid_or_last',
        },
        {
          instrumentId: 'hyperliquid:perp:SOL',
          symbol: 'SOL',
          quoteUnit: 'USDT',
          price: '150',
          kind: 'mid_or_last',
        },
      ],
    }),
  );
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(stops[0]).toHaveBeenCalledOnce();
  expect(screen.getByText('Prices are out of date')).toBeInTheDocument();
  expect(screen.getByText('BTC: 60000 USDT (stale)')).toBeInTheDocument();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(api.subscribePrices).toHaveBeenCalledTimes(2);
  unmount();
  expect(stops[1]).toHaveBeenCalledOnce();
});
