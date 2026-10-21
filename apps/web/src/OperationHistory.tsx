import {
  type BridgeStatusRecovery,
  bridgeStatusMessage,
  type OperationPage,
  type OperationRecovery,
} from '@honey-wallet/api-client';
import { useEffect, useState } from 'react';
import { api } from './lib/api';

/** Read-only request recovery is available even when provider execution is disabled. */
export default function OperationHistory({ token, walletId }: { token: string; walletId: string }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<OperationPage | null>(null);
  const [detail, setDetail] = useState<OperationRecovery | null>(null);
  const [bridge, setBridge] = useState<BridgeStatusRecovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      controller?.abort();
      clearTimeout(timer);
    };
    const load = async () => {
      stop();
      if (!live || document.visibilityState === 'hidden') return;
      const request = new AbortController();
      controller = request;
      const valid = () => live && !request.signal.aborted;
      setError(null);
      try {
        if (selected) {
          const value = await api.operation(token, selected, { signal: request.signal });
          if (value.operation.walletId !== walletId) throw new Error('wallet mismatch');
          const observation =
            value.operation.action === 'bridge'
              ? await api
                  .bridgeStatus(token, selected, { signal: request.signal })
                  .catch(() => null)
              : null;
          if (valid()) {
            setDetail(value);
            setBridge(observation);
            if (
              value.operation.action === 'bridge' ||
              !['succeeded', 'failed'].includes(value.operation.state)
            )
              timer = setTimeout(
                () => void load(),
                value.operation.action === 'bridge'
                  ? (observation?.observation?.pollAfterMs ?? 10000)
                  : 5000,
              );
          }
        } else {
          const value = await api.operations(
            token,
            { cursor, limit: 10 },
            { signal: request.signal },
          );
          if (value.items.some((i) => i.operation.walletId !== walletId))
            throw new Error('wallet mismatch');
          if (valid()) setPage(value);
        }
      } catch {
        if (valid()) setError('Could not load your requests. Refresh to try again.');
      }
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else void load();
    };
    if (refresh >= 0) void load();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      live = false;
      stop();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [token, walletId, cursor, selected, refresh]);
  return (
    <section aria-label="Your Honey requests">
      <h2>Your Honey requests</h2>
      <p>Requests made through Honey. This does not include all on-chain activity.</p>
      {error && <p role="alert">{error}</p>}
      {selected ? (
        <>
          {detail?.operation.id === selected && (
            <>
              <p role="status">
                {detail.operation.action === 'bridge'
                  ? bridge?.operationId === detail.operation.id
                    ? bridgeStatusMessage(bridge)
                    : 'Bridge outcome pending'
                  : detail.operation.state.replaceAll('_', ' ')}
              </p>
              {detail.operation.state === 'bridging' ? (
                <p>Source finalized; destination delivery pending.</p>
              ) : null}
              <p>
                Operation <code>{detail.operation.id}</code>
              </p>
              {detail.operation.action === 'bridge' &&
                bridge?.operationId === detail.operation.id &&
                bridge.observation?.candidates.map((candidate) => (
                  <p key={`${candidate.chainId}:${candidate.transactionHash}`}>
                    Reported {candidate.role === 'refund' ? 'refund' : 'destination'} transaction ·
                    chain {candidate.chainId}: <code>{candidate.transactionHash}</code>
                  </p>
                ))}
              {detail.submission?.transactionHashes.map((hash) => (
                <p key={hash}>
                  Transaction <code>{hash}</code>
                </p>
              ))}
              {detail.reconciliation && (
                <p>
                  {detail.reconciliation.transactions.filter((t) => t.inclusion?.finalized).length}{' '}
                  of {detail.reconciliation.transactions.length}{' '}
                  {detail.operation.action === 'bridge'
                    ? 'source transactions finalized; destination outcome is separate.'
                    : 'transactions finalized.'}
                </p>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setDetail(null);
            }}
          >
            Back to requests
          </button>
        </>
      ) : (
        <>
          {page?.items.length === 0 && <p>No Honey requests for this wallet yet.</p>}
          <ul>
            {page?.items.map((item) => (
              <li key={item.operation.id}>
                <button
                  type="button"
                  onClick={() => {
                    setDetail(null);
                    setSelected(item.operation.id);
                  }}
                >
                  {item.operation.action} ·{' '}
                  {item.operation.action === 'bridge'
                    ? 'check destination status'
                    : item.operation.state.replaceAll('_', ' ')}{' '}
                  · {new Date(item.createdAtMs).toLocaleString()}
                </button>
              </li>
            ))}
          </ul>
          {page?.nextCursor && (
            <button
              type="button"
              onClick={() => {
                setCursor(page.nextCursor ?? undefined);
                setPage(null);
              }}
            >
              Older requests
            </button>
          )}
        </>
      )}
      <button
        type="button"
        onClick={() => {
          if (!selected) setCursor(undefined);
          setRefresh((n) => n + 1);
        }}
      >
        {selected ? 'Refresh status' : 'Newest requests'}
      </button>
    </section>
  );
}
