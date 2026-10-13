import type { VersionInfo } from '@honey-wallet/api-client';
import { useEffect, useState } from 'react';
import { api } from './lib/api';

type Status =
  | { state: 'loading' }
  | { state: 'online'; info: VersionInfo }
  | { state: 'offline'; message: string };

export default function App() {
  const [status, setStatus] = useState<Status>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    api
      .version({ signal: controller.signal })
      .then((info) => setStatus({ state: 'online', info }))
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
      <p className={`status status-${status.state}`} role="status">
        {status.state === 'loading' && 'Connecting to server…'}
        {status.state === 'online' && `Connected to ${status.info.name} v${status.info.version}`}
        {status.state === 'offline' && `Server unreachable: ${status.message}`}
      </p>
    </main>
  );
}
