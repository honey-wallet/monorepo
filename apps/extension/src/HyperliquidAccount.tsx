import type { HyperliquidPerpsAccountState } from '@honey-wallet/api-client';
import { useEffect, useRef, useState } from 'react';
import { readHyperliquidAccount } from './lib/hyperliquid';

/** User-triggered, read-only account view. Data lives only in this mounted popup. */
export function HyperliquidAccount({ token, address }: { token: string; address: string }) {
  const [account, setAccount] = useState<HyperliquidPerpsAccountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    flight.current?.abort();
    flight.current = null;
    setAccount(null);
    setBusy(false);
    setError(null);
    return () => {
      generation.current++;
      flight.current?.abort();
      flight.current = null;
    };
    // App keys this view by signed-in wallet and mounts it only while its popup token exists.
  }, []);

  async function load() {
    if (flight.current) return;
    const epoch = ++generation.current;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await readHyperliquidAccount(token, address, controller.signal);
      if (controller.signal.aborted || epoch !== generation.current) return;
      setAccount(result);
    } catch (cause) {
      if (!controller.signal.aborted && epoch === generation.current)
        setError(
          cause instanceof Error ? cause.message : 'Hyperliquid account data is unavailable.',
        );
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (epoch === generation.current) setBusy(false);
      }
    }
  }

  const margin = account?.state.marginSummary;
  return (
    <section aria-label="Hyperliquid account" className="card">
      <p className="section">Hyperliquid account</p>
      <p className="note">
        Read-only provider data for the signed-in wallet. No orders are submitted.
      </p>
      <ButtonLike disabled={busy} onClick={() => void load()}>
        {busy ? 'Loading account…' : account ? 'Refresh account' : 'Load account'}
      </ButtonLike>
      {margin && account ? (
        <div aria-live="polite" className="note">
          <p>Account value: ${margin.accountValue}</p>
          <p>Open notional: ${margin.totalNtlPos}</p>
          <p>Margin used: ${margin.totalMarginUsed}</p>
          <p>Withdrawable: ${account.state.withdrawable}</p>
          <p>{account.state.assetPositions.length ? 'Open positions:' : 'No open positions.'}</p>
          {account.state.assetPositions.map(({ position }) => (
            <p key={position.coin}>
              {position.coin}: {position.szi} · unrealized PnL ${position.unrealizedPnl}
            </p>
          ))}
          <p>
            Fetched {new Date(account.fetchedAtMs).toLocaleTimeString()}. Provider-reported values.
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="note error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ButtonLike({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button type="button" className="pill" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
