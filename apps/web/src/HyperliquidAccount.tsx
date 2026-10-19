import type { HyperliquidPerpsAccountState, WalletProfile } from '@honey-wallet/api-client';
import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';

export default function HyperliquidAccount({
  token,
  profile,
}: {
  token: string;
  profile: WalletProfile;
}) {
  const [account, setAccount] = useState<HyperliquidPerpsAccountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const clearAccount = () => {
      generation.current++;
      flight.current?.abort();
      flight.current = null;
      setAccount(null);
      setBusy(false);
      setError(null);
    };
    generation.current++;
    flight.current?.abort();
    flight.current = null;
    setAccount(null);
    setBusy(false);
    setError(null);
    const onVisibilityChange = () => {
      if (document.hidden) clearAccount();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      generation.current++;
      flight.current?.abort();
    };
  }, []);

  async function refresh() {
    if (flight.current || document.hidden) return;
    const epoch = ++generation.current;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await api.hyperliquidPerpsAccount(token, { signal: controller.signal });
      if (
        epoch === generation.current &&
        !controller.signal.aborted &&
        result.account.toLowerCase() === profile.wallet.address.toLowerCase()
      ) {
        setAccount(result);
      } else if (epoch === generation.current && !controller.signal.aborted) {
        throw new Error('The account response did not match the signed-in wallet.');
      }
    } catch (e) {
      if (epoch === generation.current && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Account data unavailable.');
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        setBusy(false);
      }
    }
  }

  const margin = account?.state.marginSummary;
  return (
    <section aria-label="Hyperliquid perps account">
      <h3>Hyperliquid account</h3>
      <p>Read-only account data for the wallet you signed in with. No orders are submitted.</p>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {busy ? 'Loading account…' : account ? 'Refresh account' : 'Load account'}
      </button>
      {margin && account && (
        <div aria-live="polite">
          <p>Account value: ${margin.accountValue}</p>
          <p>Open notional: ${margin.totalNtlPos}</p>
          <p>Margin used: ${margin.totalMarginUsed}</p>
          <p>Withdrawable: ${account.state.withdrawable}</p>
          <h4>Positions</h4>
          {account.state.assetPositions.length ? (
            <ul>
              {account.state.assetPositions.map(({ position }) => (
                <li key={position.coin}>
                  {position.coin}: {position.szi} · unrealized PnL ${position.unrealizedPnl} ·{' '}
                  {position.leverage.value}x {position.leverage.type}
                  {position.liquidationPx ? ` · liquidation ${position.liquidationPx}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p>No open positions.</p>
          )}
          <p>
            Fetched {new Date(account.fetchedAtMs).toLocaleTimeString()}. Values are
            provider-reported.
          </p>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
