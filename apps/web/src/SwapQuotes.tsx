import {
  formatTokenAmount,
  parseTokenAmount,
  type SwapQuote,
  type SwapQuoteConfiguration,
  validateSwapQuote,
  type WalletProfile,
} from '@honey-wallet/api-client';
import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';

export default function SwapQuotes({ token, profile }: { token: string; profile: WalletProfile }) {
  const [config, setConfig] = useState<SwapQuoteConfiguration | null>(null);
  const [input, setInput] = useState(''),
    [output, setOutput] = useState('');
  const [amount, setAmount] = useState(''),
    [slippage, setSlippage] = useState('50');
  const [quote, setQuote] = useState<SwapQuote | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    flight = useRef<AbortController | null>(null),
    locked = useRef(false);
  useEffect(() => {
    if (!token) return;
    const abort = new AbortController();
    generation.current++;
    setQuote(null);
    setConfig(null);
    void api
      .swapConfiguration({ signal: abort.signal })
      .then((c) => {
        if (abort.signal.aborted) return;
        setConfig(c);
        setInput(c.tokens[0]?.address ?? '');
        setOutput(c.tokens[1]?.address ?? '');
      })
      .catch(() => {});
    const hide = () => {
      if (document.hidden) {
        generation.current++;
        flight.current?.abort();
        setQuote(null);
      }
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      generation.current++;
      abort.abort();
      flight.current?.abort();
      document.removeEventListener('visibilitychange', hide);
    };
  }, [token]);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(() => setQuote(null), Math.max(0, quote.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [quote]);
  const change = (fn: () => void) => {
    generation.current++;
    flight.current?.abort();
    setQuote(null);
    setError(null);
    fn();
  };
  const sell = config?.tokens.find((t) => t.address === input),
    buy = config?.tokens.find((t) => t.address === output);
  async function request() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setQuote(null);
    const epoch = ++generation.current;
    const abort = new AbortController();
    flight.current = abort;
    try {
      if (!config || !sell || profile.wallet.chainId !== `eip155:${config.chainId}`)
        throw new Error('Sign in on the configured quote network.');
      if (!/^(0|[1-9][0-9]{0,3})$/.test(slippage) || Number(slippage) > 1000)
        throw new Error('Slippage must be 0–1000 basis points.');
      const r = {
        tokenIn: input,
        tokenOut: output,
        amountRaw: parseTokenAmount(amount, sell.decimals),
        slippageBps: Number(slippage),
      };
      const q = await api.swapQuote(token, r, { signal: abort.signal });
      validateSwapQuote(q, config, r, profile.wallet.address);
      if (generation.current === epoch) setQuote(q);
    } catch (e) {
      if (generation.current === epoch)
        setError(e instanceof Error ? e.message : 'Quote unavailable.');
    } finally {
      locked.current = false;
      setBusy(false);
      if (flight.current === abort) flight.current = null;
    }
  }
  if (!config) return <p>Live swap quotes are not available.</p>;
  return (
    <section aria-label="Live swap quotes">
      <p>Uniswap quote · chain {config.chainId}</p>
      <label>
        Pay token
        <select
          value={input}
          disabled={busy}
          onChange={(e) => change(() => setInput(e.target.value))}
        >
          {config.tokens.map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol} · {t.address}
            </option>
          ))}
        </select>
      </label>
      <label>
        Receive token
        <select
          value={output}
          disabled={busy}
          onChange={(e) => change(() => setOutput(e.target.value))}
        >
          {config.tokens.map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol} · {t.address}
            </option>
          ))}
        </select>
      </label>
      <label>
        Amount
        <input
          inputMode="decimal"
          value={amount}
          disabled={busy}
          onChange={(e) => change(() => setAmount(e.target.value))}
        />
      </label>
      <label>
        Slippage (basis points; 50 = 0.5%)
        <input
          inputMode="numeric"
          value={slippage}
          disabled={busy}
          onChange={(e) => change(() => setSlippage(e.target.value))}
        />
      </label>
      <button
        type="button"
        disabled={
          busy ||
          !amount ||
          input === output ||
          profile.wallet.chainId !== `eip155:${config.chainId}`
        }
        onClick={() => void request()}
      >
        {busy ? 'Requesting quote…' : 'Get quote'}
      </button>
      {quote && buy ? (
        <div aria-live="polite">
          <p>
            Estimated receive: {formatTokenAmount(quote.netOutputRaw, buy.decimals)} {buy.symbol}
          </p>
          <p>
            Quoted minimum: {formatTokenAmount(quote.minimumOutputRaw, buy.decimals)} {buy.symbol}
          </p>
          {quote.fees.map((f) => (
            <p key={f.recipient}>
              Integrator fee: {formatTokenAmount(f.amountRaw, buy.decimals)} {buy.symbol} ({f.bps}{' '}
              bps) to {f.recipient}
            </p>
          ))}
          {quote.fees.length === 0 ? <p>Integrator fee: 0</p> : null}
          <p>
            Swap gas estimate: {formatTokenAmount(quote.swapGasEstimateRaw, 18)} native units,
            excluding approvals.
          </p>
          <p>Quote expires after 30 seconds. Swap signing is not enabled yet.</p>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
