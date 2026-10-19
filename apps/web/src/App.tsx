import type { Capabilities, VersionInfo } from '@honey-wallet/api-client';
import { useEffect, useState } from 'react';
import EarnMarkets from './EarnMarkets';
import { api } from './lib/api';
import MarketPrices from './MarketPrices';
import PredictionMarkets from './PredictionMarkets';
import WalletSignIn from './WalletSignIn';

type Status =
  | { state: 'loading' }
  | { state: 'online'; info: VersionInfo; capabilities: Capabilities | null }
  | { state: 'offline'; message: string };

export default function App() {
  const [status, setStatus] = useState<Status>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api.version({ signal: controller.signal }),
      api.capabilities({ signal: controller.signal }).catch(() => null),
    ])
      .then(([info, capabilities]) => {
        if (!controller.signal.aborted) setStatus({ state: 'online', info, capabilities });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({
          state: 'offline',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>Honey Wallet</h1>
      <WalletSignIn />
      {status.state === 'online' && <EarnMarkets />}
      {status.state === 'online' && <PredictionMarkets />}
      {status.state === 'online' &&
        status.capabilities?.features.some(
          (feature) => feature.id === 'price_stream' && feature.reason !== 'not_configured',
        ) && <MarketPrices />}
      <p className={`status status-${status.state}`} role="status">
        {status.state === 'loading' && 'Connecting to server…'}
        {status.state === 'online' && `Connected to ${status.info.name} v${status.info.version}`}
        {status.state === 'offline' && `Server unreachable: ${status.message}`}
      </p>
      {status.state === 'online' && (
        <p>
          {status.capabilities === null
            ? 'Could not check live wallet services.'
            : status.capabilities.features.some(
                  (feature) => feature.available && feature.scope === 'production',
                )
              ? 'Live wallet services are available.'
              : status.capabilities.features.some(
                    (feature) => feature.available && feature.scope === 'read_only',
                  )
                ? 'Read-only wallet services are available.'
                : status.capabilities.features.some((feature) => feature.scope === 'local_testnet')
                  ? 'Local testnet integrations are configured; production transactions are unavailable.'
                  : 'Live wallet services are not available yet.'}
        </p>
      )}
    </main>
  );
}
