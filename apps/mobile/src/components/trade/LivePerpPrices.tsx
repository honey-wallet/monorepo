import type { PriceConnectionState, PriceSnapshot } from '@honey-wallet/api-client';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { api } from '@/lib/api';
import { makeStyles, radius } from '@/theme';

/** Public venue prices, isolated from the demo chart, positions and order calculator. */
export function LivePerpPrices({ query = '', symbol }: { query?: string; symbol?: string }) {
  const styles = useStyles();
  const [snapshot, setSnapshot] = useState<PriceSnapshot | null>(null);
  const [state, setState] = useState<PriceConnectionState | 'unavailable' | 'paused'>('connecting');
  useFocusEffect(
    useCallback(() => {
      let stop: (() => void) | undefined;
      let controller: AbortController | undefined;
      const suspend = () => {
        controller?.abort();
        stop?.();
        stop = undefined;
        setSnapshot((value) => (value ? { ...value, stale: true } : null));
        setState('paused');
      };
      const start = () => {
        suspend();
        const current = new AbortController();
        controller = current;
        setState('connecting');
        api
          .capabilities({ signal: current.signal })
          .then((capabilities) => {
            if (current.signal.aborted) return;
            const feature = capabilities.features.find((f) => f.id === 'price_stream');
            if (!feature || !['available', 'stale', 'warming_up'].includes(feature.reason)) {
              setState('unavailable');
              return;
            }
            stop = api.subscribePrices({ onSnapshot: setSnapshot, onState: setState });
          })
          .catch(() => {
            if (!current.signal.aborted) setState('unavailable');
          });
      };
      if (AppState.currentState === 'active') start();
      const listener = AppState.addEventListener('change', (next) => {
        if (next === 'active') start();
        else suspend();
      });
      return () => {
        suspend();
        listener.remove();
      };
    }, []),
  );
  const prices =
    snapshot?.prices.filter(
      (price) =>
        (!symbol || price.symbol === symbol) &&
        price.symbol.toLowerCase().includes(query.trim().toLowerCase()),
    ) ?? [];
  const label =
    state === 'live'
      ? 'Live · Hyperliquid'
      : state === 'stale'
        ? 'Prices are out of date'
        : state === 'unavailable'
          ? 'Market prices are unavailable'
          : state === 'paused'
            ? 'Market prices paused'
            : 'Connecting to market prices…';
  return (
    <View style={styles.section}>
      <Text accessibilityLiveRegion="polite" style={styles.label}>
        {label}
      </Text>
      {prices.map((price) => (
        <View key={price.instrumentId} style={styles.card}>
          <Text style={styles.symbol}>{price.symbol}</Text>
          <Text selectable style={styles.price}>
            {price.price} {price.quoteUnit}
          </Text>
          {snapshot?.stale ? <Text style={styles.label}>Stale</Text> : null}
        </View>
      ))}
      {snapshot && prices.length === 0 ? (
        <Text style={styles.label}>No live price for this market.</Text>
      ) : null}
      <Text style={styles.label}>
        Indicative mid or last-trade prices. Trading and account positions are not available yet.
      </Text>
    </View>
  );
}
const useStyles = makeStyles((c) => ({
  section: { padding: 20, gap: 12 },
  card: { backgroundColor: c.card, ...radius(20), padding: 18, gap: 8 },
  label: { color: c.textSecondary, fontSize: 15, lineHeight: 21 },
  symbol: { color: c.text, fontSize: 17 },
  price: { color: c.text, fontSize: 22, fontVariant: ['tabular-nums'] },
}));
