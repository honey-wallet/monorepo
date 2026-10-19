import {
  type AcrossConfiguration,
  type AcrossQuote,
  formatTokenAmount,
  parseTokenAmount,
  validateAcrossQuote,
} from '@honey-wallet/api-client';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { AcrossExecution } from '@/components/trade/AcrossExecution';
import { EmptyState } from '@/components/wallet/parts';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles } from '@/theme';

/** Read-only quote display. No wallet key, approval or transaction signing. */
export function AcrossQuotes() {
  const wallet = useActiveWallet(),
    session = backendSession.useValue();
  return (
    <WalletAcrossQuotes
      key={`${wallet.id}:${session.profile?.wallet.id ?? ''}:${session.expiresAt ?? ''}`}
    />
  );
}
function WalletAcrossQuotes() {
  const styles = useStyles(),
    wallet = useActiveWallet(),
    session = backendSession.useValue();
  const [config, setConfig] = useState<AcrossConfiguration | null>(null),
    [loading, setLoading] = useState(true);
  const [routeId, setRouteId] = useState(''),
    [amount, setAmount] = useState(''),
    [minimum, setMinimum] = useState('');
  const [recipient, setRecipient] = useState(wallet.address.toLowerCase());
  const [quote, setQuote] = useState<AcrossQuote | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    flight = useRef<AbortController | null>(null);
  useFocusEffect(
    useCallback(() => {
      const abort = new AbortController();
      generation.current++;
      setLoading(true);
      setConfig(null);
      setQuote(null);
      setError(null);
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
      const listener = AppState.addEventListener('change', (state) => {
        if (state !== 'active') {
          generation.current++;
          flight.current?.abort();
          flight.current = null;
          setBusy(false);
          setQuote(null);
        }
      });
      return () => {
        generation.current++;
        abort.abort();
        flight.current?.abort();
        flight.current = null;
        listener.remove();
        setQuote(null);
        setBusy(false);
      };
    }, []),
  );
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
  const route = config?.routes.find((r) => r.id === routeId);
  const signedIn =
    !!config &&
    session.profile?.wallet.chainId === `eip155:${config.sourceChainId}` &&
    session.profile.wallet.address.toLowerCase() === wallet.address.toLowerCase();
  function change(update: () => void) {
    generation.current++;
    flight.current?.abort();
    flight.current = null;
    setBusy(false);
    setQuote(null);
    setError(null);
    update();
  }
  async function requestQuote() {
    if (flight.current) return;
    const abort = new AbortController(),
      epoch = ++generation.current,
      token = backendSessionToken();
    flight.current = abort;
    setBusy(true);
    setQuote(null);
    setError(null);
    try {
      if (!config || !route || !signedIn || !token)
        throw new Error('Sign in with this wallet on the bridge source network.');
      const input = {
        routeId,
        amountRaw: parseTokenAmount(amount, route.inputToken.decimals),
        minimumOutputRaw: parseTokenAmount(minimum, route.outputToken.decimals),
        recipient: recipient.toLowerCase(),
      };
      const result = await api.acrossQuote(token, input, { signal: abort.signal });
      validateAcrossQuote(result, config, input, wallet.address);
      if (epoch === generation.current && token === backendSessionToken() && !abort.signal.aborted)
        setQuote(result);
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
  if (loading) return <Text style={styles.note}>Checking bridge availability…</Text>;
  if (!config || !route)
    return (
      <EmptyState
        compact
        icon="trade"
        title="Live bridges are unavailable"
        hint="Bridge quotes aren't available for this network yet."
      />
    );
  if (wallet.kind !== 'wallet' || wallet.watchOnly)
    return (
      <EmptyState
        compact
        icon="trade"
        title="Choose a signing wallet"
        hint="Bridge quotes are available for an individual EVM wallet."
      />
    );
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Across bridge · source chain {config.sourceChainId}</Text>
      {!signedIn ? (
        <PillButton
          label="Sign in on this network"
          onPress={() => router.push('/wallet-sign-in')}
        />
      ) : null}
      <Text style={styles.note}>Bridge route</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.routes}>
          {config.routes.map((r) => (
            <Pressable
              key={r.id}
              accessibilityRole="radio"
              accessibilityLabel={`${r.inputToken.symbol} to chain ${r.destinationChainId}, ${r.id}`}
              accessibilityState={{ selected: routeId === r.id }}
              disabled={busy}
              onPress={() => change(() => setRouteId(r.id))}
              style={[styles.route, routeId === r.id && styles.selected]}
            >
              <Text style={styles.routeLabel}>
                {r.inputToken.symbol} → chain {r.destinationChainId}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      <Text style={styles.note}>
        Allowed amount: {formatTokenAmount(route.minimumInputRaw, route.inputToken.decimals)}–
        {formatTokenAmount(route.maximumInputRaw, route.inputToken.decimals)}{' '}
        {route.inputToken.symbol}. Maximum bridge fee: {route.maximumBridgeFeeBps / 100}%.
      </Text>
      <TextInput
        accessibilityLabel="Bridge amount"
        placeholder={`Amount in ${route.inputToken.symbol}`}
        keyboardType="decimal-pad"
        value={amount}
        editable={!busy}
        onChangeText={(v) => change(() => setAmount(v))}
        style={styles.input}
      />
      <TextInput
        accessibilityLabel="Minimum to receive"
        placeholder={`Minimum ${route.outputToken.symbol} to receive`}
        keyboardType="decimal-pad"
        value={minimum}
        editable={!busy}
        onChangeText={(v) => change(() => setMinimum(v))}
        style={styles.input}
      />
      <Text style={styles.note}>Destination recipient</Text>
      <TextInput
        accessibilityLabel="Destination recipient"
        autoCapitalize="none"
        autoCorrect={false}
        value={recipient}
        editable={!busy}
        onChangeText={(v) => change(() => setRecipient(v))}
        style={styles.input}
      />
      <PillButton
        label={busy ? 'Requesting bridge quote…' : 'Get bridge quote'}
        disabled={busy || !signedIn || !amount || !minimum || !recipient}
        onPress={() => void requestQuote()}
      />
      {quote ? (
        <View style={styles.group}>
          <Text style={styles.title}>
            Quoted minimum: {formatTokenAmount(quote.minimumOutputRaw, route.outputToken.decimals)}{' '}
            {route.outputToken.symbol} on chain {quote.destinationChainId}
          </Text>
          <Text selectable style={styles.note}>
            Recipient: {quote.recipient}
          </Text>
          <Text style={styles.note}>
            Bridge fee: {formatTokenAmount(quote.bridgeFeeRaw, route.inputToken.decimals)}{' '}
            {route.inputToken.symbol}. Integrator fee: 0.
          </Text>
          <Text style={styles.note}>
            Source gas estimate: {quote.sourceGasEstimateRaw} gas units, excluding approvals.
            Network cost is not included in this quote.
          </Text>
          <Text style={styles.note}>
            Estimated delivery: {quote.expectedFillSeconds} seconds. Fill deadline:{' '}
            {new Date(Number(quote.fillDeadline) * 1000).toLocaleTimeString()}.
          </Text>
          <Text selectable style={styles.note}>
            Refund destination if applicable: {quote.refundRecipient} on chain {quote.refundChainId}
            . Refund timing is not guaranteed.
          </Text>
          <Text style={styles.note}>
            Quote expires at {new Date(quote.expiresAtMs).toLocaleTimeString()}. Bridge signing is
            not enabled yet.
          </Text>
        </View>
      ) : null}
      <AcrossExecution quote={quote} />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
const useStyles = makeStyles((c) => ({
  card: { padding: 18, gap: 14, backgroundColor: c.card, borderRadius: 20, marginTop: 16 },
  group: { gap: 8 },
  title: { fontSize: 15, color: c.textSecondary },
  note: { fontSize: 14, lineHeight: 20, color: c.textSecondary },
  input: { backgroundColor: c.raised, padding: 12, borderRadius: 12, fontSize: 18, color: c.text },
  routes: { flexDirection: 'row', gap: 8 },
  route: { padding: 10, borderWidth: 1, borderColor: c.raised, borderRadius: 12 },
  selected: { borderColor: c.text },
  routeLabel: { color: c.text, fontSize: 15 },
  error: { color: c.error, fontSize: 14 },
}));
