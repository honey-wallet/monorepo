import {
  formatTokenAmount,
  parseTokenAmount,
  type SwapQuote,
  type SwapQuoteConfiguration,
  validateSwapQuote,
} from '@honey-wallet/api-client';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { AcrossQuotes } from '@/components/trade/AcrossQuotes';
import { SwapExecution } from '@/components/trade/SwapExecution';
import { EmptyState } from '@/components/wallet/parts';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles } from '@/theme';

/** Live quotes never enter the scripted demo review or acquire a wallet key. */
export function LiveSwapQuotes() {
  const wallet = useActiveWallet();
  return (
    <View>
      <WalletSwapQuotes key={wallet.id} />
      <AcrossQuotes />
    </View>
  );
}
function WalletSwapQuotes() {
  const styles = useStyles(),
    wallet = useActiveWallet(),
    session = backendSession.useValue();
  const [config, setConfig] = useState<SwapQuoteConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState(''),
    [output, setOutput] = useState('');
  const [amount, setAmount] = useState(''),
    [slippage, setSlippage] = useState('50');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    locked = useRef(false),
    flight = useRef<AbortController | null>(null);
  const sessionWalletId = session.profile?.wallet.id;
  useFocusEffect(
    useCallback(() => {
      let live = true;
      const abort = new AbortController();
      generation.current++;
      setQuote(null);
      setLoading(true);
      void api
        .swapConfiguration({ signal: abort.signal })
        .then((c) => {
          if (!live || sessionWalletId !== backendSession.get().profile?.wallet.id) return;
          setConfig(c);
          setInput(c.tokens[0]?.address ?? '');
          setOutput(c.tokens[1]?.address ?? '');
        })
        .catch(() => {
          if (live) setConfig(null);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
      const listener = AppState.addEventListener('change', (s) => {
        if (s !== 'active') {
          generation.current++;
          flight.current?.abort();
          setQuote(null);
        }
      });
      return () => {
        live = false;
        generation.current++;
        abort.abort();
        flight.current?.abort();
        listener.remove();
        setQuote(null);
      };
    }, [sessionWalletId]),
  );
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(() => setQuote(null), Math.max(0, quote.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [quote]);
  const change = (update: () => void) => {
    generation.current++;
    flight.current?.abort();
    setQuote(null);
    setError(null);
    update();
  };
  const sell = config?.tokens.find((t) => t.address === input),
    buy = config?.tokens.find((t) => t.address === output);
  const signedIn =
    !!config &&
    session.profile?.wallet.chainId === `eip155:${config.chainId}` &&
    session.profile?.wallet.address.toLowerCase() === wallet.address.toLowerCase();
  async function fetchQuote() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setQuote(null);
    setError(null);
    const epoch = ++generation.current,
      token = backendSessionToken();
    const abort = new AbortController();
    flight.current = abort;
    try {
      if (!config || !sell || !token || !signedIn)
        throw new Error('Sign in with this wallet on the quote network.');
      if (!/^(0|[1-9][0-9]{0,3})$/.test(slippage) || Number(slippage) > 1000)
        throw new Error('Use 0–1000 basis points for slippage.');
      const request = {
        tokenIn: input,
        tokenOut: output,
        amountRaw: parseTokenAmount(amount, sell.decimals),
        slippageBps: Number(slippage),
      };
      const result = await api.swapQuote(token, request, { signal: abort.signal });
      validateSwapQuote(result, config, request, wallet.address);
      if (epoch === generation.current && token === backendSessionToken()) setQuote(result);
    } catch (e) {
      if (epoch === generation.current)
        setError(e instanceof Error ? e.message : 'Quote unavailable.');
    } finally {
      locked.current = false;
      setBusy(false);
      if (flight.current === abort) flight.current = null;
    }
  }
  if (loading) return <Text style={styles.note}>Checking swap availability…</Text>;
  if (!config)
    return (
      <EmptyState
        compact
        icon="trade"
        title="Live swaps are unavailable"
        hint="Quotes aren't available for this network yet."
      />
    );
  if (wallet.kind !== 'wallet' || wallet.watchOnly)
    return (
      <EmptyState
        compact
        icon="trade"
        title="Choose a signing wallet"
        hint="This quote flow is for an individual EVM wallet."
      />
    );
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Uniswap quote · chain {config.chainId}</Text>
      {!signedIn ? (
        <PillButton
          label="Sign in on this network"
          onPress={() => router.push('/wallet-sign-in')}
        />
      ) : null}
      {(['Pay', 'Receive'] as const).map((label) => (
        <View key={label} style={styles.group}>
          <Text style={styles.note}>{label}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.tokens}>
              {config.tokens.map((t) => {
                const selected = (label === 'Pay' ? input : output) === t.address;
                return (
                  <Pressable
                    key={t.address}
                    accessibilityRole="radio"
                    accessibilityLabel={`${label} ${t.symbol}, ${t.address}`}
                    accessibilityState={{ selected }}
                    disabled={busy}
                    onPress={() =>
                      change(() => (label === 'Pay' ? setInput(t.address) : setOutput(t.address)))
                    }
                    style={[styles.token, selected && styles.selected]}
                  >
                    <Text style={styles.tokenLabel}>{t.symbol}</Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>
      ))}
      <TextInput
        accessibilityLabel="Swap input token amount"
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={(v) => change(() => setAmount(v))}
        editable={!busy}
        placeholder={`Amount in ${sell?.symbol ?? 'tokens'}`}
        style={styles.input}
      />
      <Text style={styles.note}>Slippage in basis points · 50 = 0.5%</Text>
      <TextInput
        accessibilityLabel="Swap slippage basis points"
        keyboardType="number-pad"
        value={slippage}
        onChangeText={(v) => change(() => setSlippage(v))}
        editable={!busy}
        style={styles.input}
      />
      <PillButton
        label={busy ? 'Requesting quote…' : 'Get quote'}
        disabled={busy || !signedIn || input === output || !amount}
        onPress={() => void fetchQuote()}
      />
      {quote && buy ? (
        <View style={styles.group}>
          <Text style={styles.title}>
            Estimated receive: {formatTokenAmount(quote.netOutputRaw, buy.decimals)} {buy.symbol}
          </Text>
          <Text style={styles.note}>
            Quoted minimum: {formatTokenAmount(quote.minimumOutputRaw, buy.decimals)} {buy.symbol}
          </Text>
          {quote.fees.map((f) => (
            <Text selectable key={f.recipient} style={styles.note}>
              Integrator fee: {formatTokenAmount(f.amountRaw, buy.decimals)} {buy.symbol} ({f.bps}{' '}
              bps) to {f.recipient}
            </Text>
          ))}
          {quote.fees.length === 0 ? <Text style={styles.note}>Integrator fee: 0</Text> : null}
          <Text style={styles.note}>
            Swap gas estimate: {formatTokenAmount(quote.swapGasEstimateRaw, 18)} native units.
            Approval gas is additional.
          </Text>
          <Text style={styles.note}>
            Received {new Date(quote.receivedAtMs).toLocaleTimeString()}. Expires after 30 seconds.
            Execution availability is checked separately below.
          </Text>
        </View>
      ) : null}
      <SwapExecution key={sessionWalletId ?? 'signed-out'} quote={quote} />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
const useStyles = makeStyles((c) => ({
  card: { padding: 18, gap: 14, backgroundColor: c.card, borderRadius: 20 },
  group: { gap: 8 },
  title: { fontSize: 17, color: c.text },
  note: { fontSize: 14, lineHeight: 20, color: c.textSecondary },
  input: { backgroundColor: c.raised, padding: 12, borderRadius: 12, fontSize: 18, color: c.text },
  tokens: { flexDirection: 'row', gap: 8 },
  token: { padding: 10, borderWidth: 1, borderColor: c.raised, borderRadius: 12 },
  selected: { borderColor: c.text },
  tokenLabel: { color: c.text, fontSize: 15 },
  error: { color: c.error, fontSize: 14 },
}));
