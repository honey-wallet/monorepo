import {
  type AcrossConfiguration,
  type AcrossQuote,
  formatTokenAmount,
  parseTokenAmount,
  validateAcrossQuote,
  type WalletProfile,
} from '@honey-wallet/api-client';
import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';

export default function AcrossQuotes({
  token,
  profile,
}: {
  token: string;
  profile: WalletProfile;
}) {
  const [config, setConfig] = useState<AcrossConfiguration | null>(null);
  const [loading, setLoading] = useState(true),
    [routeId, setRouteId] = useState('');
  const [amount, setAmount] = useState(''),
    [minimum, setMinimum] = useState('');
  const [recipient, setRecipient] = useState(profile.wallet.address.toLowerCase());
  const [quote, setQuote] = useState<AcrossQuote | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    flight = useRef<AbortController | null>(null);
  const address = profile.wallet.address.toLowerCase(),
    chain = profile.wallet.chainId;
  useEffect(() => {
    const abort = new AbortController();
    generation.current++;
    setConfig(null);
    setQuote(null);
    setLoading(true);
    setBusy(false);
    setError(null);
    setRecipient(address);
    if (!token || !chain) {
      setLoading(false);
      return;
    }
    void api
      .acrossConfiguration({ signal: abort.signal })
      .then((c) => {
        if (!abort.signal.aborted) {
          setConfig(c);
          setRouteId(c.routes[0]?.id ?? '');
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    const hide = () => {
      if (document.hidden) {
        generation.current++;
        flight.current?.abort();
        flight.current = null;
        setQuote(null);
        setBusy(false);
      }
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      generation.current++;
      abort.abort();
      flight.current?.abort();
      flight.current = null;
      document.removeEventListener('visibilitychange', hide);
    };
  }, [token, address, chain]);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(
      () => {
        setQuote(null);
        setError('Quote expired. Request a fresh quote.');
      },
      Math.max(0, quote.expiresAtMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [quote]);
  function change(update: () => void) {
    generation.current++;
    flight.current?.abort();
    flight.current = null;
    setBusy(false);
    setQuote(null);
    setError(null);
    update();
  }
  const route = config?.routes.find((r) => r.id === routeId);
  async function request() {
    if (flight.current || document.hidden) return;
    const abort = new AbortController(),
      epoch = ++generation.current;
    flight.current = abort;
    setBusy(true);
    setQuote(null);
    setError(null);
    try {
      if (!config || !route || chain !== `eip155:${config.sourceChainId}`)
        throw new Error('Sign in on the bridge source network.');
      const input = {
        routeId,
        amountRaw: parseTokenAmount(amount, route.inputToken.decimals),
        minimumOutputRaw: parseTokenAmount(minimum, route.outputToken.decimals),
        recipient: recipient.toLowerCase(),
      };
      const result = await api.acrossQuote(token, input, { signal: abort.signal });
      validateAcrossQuote(result, config, input, address);
      if (epoch === generation.current && !abort.signal.aborted) setQuote(result);
    } catch (e) {
      if (epoch === generation.current && !abort.signal.aborted)
        setError(e instanceof Error ? e.message : 'Quote unavailable.');
    } finally {
      if (flight.current === abort) {
        flight.current = null;
        setBusy(false);
      }
    }
  }
  if (loading) return <p>Checking bridge availability…</p>;
  if (!config || !route) return <p>Live bridge quotes are not available.</p>;
  return (
    <section aria-label="Across bridge quotes">
      <p>Across bridge · source chain {config.sourceChainId}</p>
      <label>
        Bridge route
        <select
          value={routeId}
          disabled={busy}
          onChange={(e) => change(() => setRouteId(e.target.value))}
        >
          {config.routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.inputToken.symbol} → chain {r.destinationChainId} · {r.id}
            </option>
          ))}
        </select>
      </label>
      <p>
        Allowed amount: {formatTokenAmount(route.minimumInputRaw, route.inputToken.decimals)}–
        {formatTokenAmount(route.maximumInputRaw, route.inputToken.decimals)}{' '}
        {route.inputToken.symbol}. Maximum bridge fee: {route.maximumBridgeFeeBps / 100}%.
      </p>
      <label>
        Bridge amount
        <input
          inputMode="decimal"
          value={amount}
          disabled={busy}
          onChange={(e) => change(() => setAmount(e.target.value))}
        />
      </label>
      <label>
        Minimum to receive
        <input
          inputMode="decimal"
          value={minimum}
          disabled={busy}
          onChange={(e) => change(() => setMinimum(e.target.value))}
        />
      </label>
      <label>
        Destination recipient
        <input
          value={recipient}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => change(() => setRecipient(e.target.value))}
        />
      </label>
      <button
        type="button"
        disabled={
          busy || !amount || !minimum || !recipient || chain !== `eip155:${config.sourceChainId}`
        }
        onClick={() => void request()}
      >
        {busy ? 'Requesting bridge quote…' : 'Get bridge quote'}
      </button>
      {chain !== `eip155:${config.sourceChainId}` ? (
        <p>Sign in on source chain {config.sourceChainId} to request a quote.</p>
      ) : null}
      {quote ? (
        <div aria-live="polite">
          <p>
            Quoted minimum: {formatTokenAmount(quote.minimumOutputRaw, route.outputToken.decimals)}{' '}
            {route.outputToken.symbol} on chain {quote.destinationChainId}
          </p>
          <p>Recipient: {quote.recipient}</p>
          <p>
            Bridge fee: {formatTokenAmount(quote.bridgeFeeRaw, route.inputToken.decimals)}{' '}
            {route.inputToken.symbol}. Integrator fee: 0.
          </p>
          <p>
            Source gas estimate: {quote.sourceGasEstimateRaw} gas units, excluding approvals.
            Network cost is not included in this quote.
          </p>
          <p>
            Estimated delivery: {quote.expectedFillSeconds} seconds. Fill deadline:{' '}
            {new Date(Number(quote.fillDeadline) * 1000).toLocaleTimeString()}.
          </p>
          <p>
            Refund destination if applicable: {quote.refundRecipient} on chain {quote.refundChainId}
            . Refund timing is not guaranteed.
          </p>
          <p>
            Quote expires at {new Date(quote.expiresAtMs).toLocaleTimeString()}. Bridge signing is
            not enabled yet.
          </p>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
