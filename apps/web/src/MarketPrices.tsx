import type { PriceConnectionState, PriceSnapshot } from '@honey-wallet/api-client';
import { useEffect, useState } from 'react';
import { api } from './lib/api';

export default function MarketPrices() {
  const [snapshot, setSnapshot] = useState<PriceSnapshot | null>(null);
  const [state, setState] = useState<PriceConnectionState>('connecting');
  useEffect(() => {
    let stop: (() => void) | undefined;
    const connect = () => {
      if (document.hidden || stop) return;
      stop = api.subscribePrices({ onSnapshot: setSnapshot, onState: setState });
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop?.();
        stop = undefined;
        setSnapshot((current) => (current ? { ...current, stale: true } : current));
        setState('stale');
      } else {
        connect();
      }
    };
    connect();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stop?.();
    };
  }, []);
  return (
    <section aria-label="Hyperliquid market prices">
      <h2>Perpetual market prices</h2>
      <p role="status">
        {state === 'live'
          ? 'Live · Hyperliquid'
          : state === 'stale'
            ? 'Prices are out of date'
            : state === 'reconnecting'
              ? 'Reconnecting to market prices…'
              : 'Connecting to market prices…'}
      </p>
      {snapshot && (
        <ul>
          {snapshot.prices.map((price) => (
            <li key={price.instrumentId}>
              {price.symbol}: {price.price} {price.quoteUnit}
              {snapshot.stale ? ' (stale)' : ''}
            </li>
          ))}
        </ul>
      )}
      <p>Indicative mid or last-trade prices. These are not executable quotes.</p>
    </section>
  );
}
