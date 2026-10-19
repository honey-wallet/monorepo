import { type EarnCatalog, formatEarnApy } from '@honey-wallet/api-client';
import { useEffect, useState } from 'react';
import { api } from './lib/api';
export default function EarnMarkets() {
  const [catalog, setCatalog] = useState<EarnCatalog | null>(null);
  const [state, setState] = useState('loading');
  useEffect(() => {
    let stop: (() => void) | undefined;
    const update = () => {
      stop?.();
      stop = undefined;
      if (document.visibilityState === 'visible')
        stop = api.subscribeEarnCatalog({ onCatalog: setCatalog, onState: setState });
      else setState('paused');
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      stop?.();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return (
    <section aria-label="Earn market data">
      <h2>Earn markets</h2>
      <p role="status">
        {state === 'error'
          ? 'Market updates are unavailable.'
          : state === 'paused'
            ? 'Market updates paused.'
            : catalog?.status === 'not_configured'
              ? 'Earn markets are not available yet.'
              : state === 'loading'
                ? 'Loading market data…'
                : 'Indexed market observations'}
      </p>
      <ul>
        {catalog?.products.map((p) => (
          <li key={p.id}>
            <strong>{p.label}</strong> · {p.protocol === 'aave_v3' ? 'Aave V3' : 'Morpho Vault V2'}{' '}
            · Chain {p.chainId}
            <p>
              {p.observation?.supplyApy
                ? formatEarnApy(p.observation.supplyApy.fraction)
                : 'Rate unavailable'}{' '}
              · {p.protocol === 'aave_v3' ? 'Current supply APY' : 'Past-day APY after vault fees'}{' '}
              · excludes rewards
            </p>
            <p>
              {p.status === 'fresh' && state === 'ready'
                ? 'Recently fetched'
                : p.status === 'unavailable'
                  ? 'Data unavailable'
                  : 'Data may be out of date'}
            </p>
            <code>{p.contractAddress}</code>
          </li>
        ))}
      </ul>
      <p>
        These are market rates, not wallet earnings. Deposits and withdrawals are not available yet.
      </p>
    </section>
  );
}
