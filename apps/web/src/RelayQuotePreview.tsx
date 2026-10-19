import type { RelayQuotePreview as RelayPreview, WalletProfile } from '@honey-wallet/api-client';
import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';

const ZERO = '0x0000000000000000000000000000000000000000';

export default function RelayQuotePreview({
  token,
  profile,
}: {
  token: string;
  profile: WalletProfile;
}) {
  const [destinationChainId, setDestinationChainId] = useState('8453');
  const [destinationCurrency, setDestinationCurrency] = useState(ZERO);
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<RelayPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    flight.current?.abort();
    flight.current = null;
    setPreview(null);
    setBusy(false);
    setError(null);
    return () => {
      generation.current++;
      flight.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!preview) return;
    const expiry = setTimeout(() => setPreview(null), 30_000);
    const hide = () => {
      if (document.hidden) {
        generation.current++;
        flight.current?.abort();
        flight.current = null;
        setPreview(null);
        setBusy(false);
      }
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      clearTimeout(expiry);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [preview]);

  function clear(update: () => void) {
    generation.current++;
    flight.current?.abort();
    flight.current = null;
    setPreview(null);
    setBusy(false);
    setError(null);
    update();
  }

  async function request() {
    if (flight.current || document.hidden) return;
    const epoch = ++generation.current;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setPreview(null);
    setError(null);
    try {
      const originChainId = Number(profile.wallet.chainId.replace('eip155:', ''));
      if (!Number.isSafeInteger(originChainId) || originChainId <= 0)
        throw new Error('Sign in with an EVM wallet to request a preview.');
      if (!/^[1-9][0-9]{0,14}$/.test(destinationChainId))
        throw new Error('Enter a valid destination chain ID.');
      const amountRaw = parseUnits(amount);
      const result = await api.relayQuotePreview(
        token,
        {
          user: profile.wallet.address,
          originChainId,
          destinationChainId: Number(destinationChainId),
          originCurrency: ZERO,
          destinationCurrency,
          amount: amountRaw,
          tradeType: 'EXACT_INPUT',
        },
        { signal: controller.signal },
      );
      if (epoch === generation.current && !controller.signal.aborted) setPreview(result);
    } catch (e) {
      if (epoch === generation.current && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Relay preview unavailable.');
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <section aria-label="Relay quote preview">
      <h3>Relay route preview</h3>
      <p>Preview only. No transaction data is exposed and signing is unavailable.</p>
      <label>
        Destination chain ID
        <input
          inputMode="numeric"
          value={destinationChainId}
          disabled={busy}
          onChange={(event) => clear(() => setDestinationChainId(event.target.value))}
        />
      </label>
      <label>
        Destination token address (zero address = native)
        <input
          value={destinationCurrency}
          disabled={busy}
          onChange={(event) => clear(() => setDestinationCurrency(event.target.value))}
        />
      </label>
      <label>
        Amount (native token)
        <input
          inputMode="decimal"
          value={amount}
          disabled={busy}
          onChange={(event) => clear(() => setAmount(event.target.value))}
        />
      </label>
      <button type="button" disabled={busy || !amount} onClick={() => void request()}>
        {busy ? 'Loading route preview…' : 'Preview with Relay'}
      </button>
      {preview && (
        <div aria-live="polite">
          <p>Relay steps · {preview.steps.length}</p>
          <ol>
            {preview.steps.map((step) => (
              <li key={`${step.index}-${step.id}`}>
                {step.action}: {step.description} ({step.itemCount} items)
              </li>
            ))}
          </ol>
          <p>This route is informational and cannot be signed or submitted.</p>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function parseUnits(value: string): string {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value))
    throw new Error('Enter a positive amount with up to 18 decimal places.');
  const [whole = '0', fraction = ''] = value.split('.');
  const raw = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (raw <= 0n || raw >= 1n << 256n) throw new Error('Amount is outside supported bounds.');
  return raw.toString();
}
