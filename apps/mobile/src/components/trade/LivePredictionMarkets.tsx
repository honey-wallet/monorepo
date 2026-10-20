import type { PolymarketCatalog, PolymarketMarket } from '@honey-wallet/api-client';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { api } from '@/lib/api';
import { predictionMarketRows } from '@/lib/polymarket-discovery';
import { makeStyles, radius } from '@/theme';

type LoadState = 'loading' | 'ready' | 'error' | 'paused';

/** Live Polymarket catalog metadata, displayed separately from the sample trade preview. */
export function LivePredictionMarkets() {
  const styles = useStyles();
  const [catalog, setCatalog] = useState<PolymarketCatalog | null>(null);
  const [markets, setMarkets] = useState<PolymarketMarket[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const flight = useRef<AbortController | null>(null);
  const focused = useRef(false);
  const retry = useRef<{ cursor: string | null; append: boolean }>({ cursor: null, append: false });

  const fetchPage = useCallback(async (cursor: string | null, append: boolean, epoch: number) => {
    if (!focused.current || epoch !== generation.current) return;
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    if (append) setLoadingMore(true);
    else {
      setState('loading');
    }
    retry.current = { cursor, append };
    try {
      const page = await api.polymarketCatalog({ signal: controller.signal }, cursor ?? undefined);
      if (controller.signal.aborted || epoch !== generation.current) return;
      setCatalog(page);
      setMarkets((current) =>
        append
          ? [
              ...current,
              ...page.markets.filter((item) => !current.some((old) => old.id === item.id)),
            ]
          : page.markets,
      );
      setState('ready');
    } catch {
      if (!controller.signal.aborted && epoch === generation.current) setState('error');
    } finally {
      if (!controller.signal.aborted && epoch === generation.current) {
        flight.current = null;
        setLoadingMore(false);
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      const suspend = () => {
        focused.current = false;
        generation.current++;
        flight.current?.abort();
        flight.current = null;
        setLoadingMore(false);
        setState('paused');
      };
      const start = () => {
        focused.current = true;
        const epoch = ++generation.current;
        flight.current?.abort();
        flight.current = null;
        setLoadingMore(false);
        setMarkets([]);
        setCatalog(null);
        void fetchPage(null, false, epoch);
      };
      if (AppState.currentState === 'active') start();
      const listener = AppState.addEventListener('change', (next) =>
        next === 'active' ? start() : suspend(),
      );
      return () => {
        suspend();
        listener.remove();
      };
    }, [fetchPage]),
  );

  const loadMore = () => {
    if (!catalog?.nextCursor || loadingMore || !focused.current) return;
    void fetchPage(catalog.nextCursor, true, generation.current);
  };
  const rows = catalog ? predictionMarketRows({ ...catalog, markets }) : [];

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Live Polymarket discovery</Text>
      <Text style={styles.note}>
        Public market descriptions only. This catalog does not show wallet eligibility or enable
        trading.
      </Text>
      {state === 'loading' && !catalog ? (
        <Text style={styles.note}>Loading public markets…</Text>
      ) : null}
      {state === 'paused' ? <Text style={styles.note}>Market discovery paused.</Text> : null}
      {state === 'error' ? (
        <Text accessibilityLiveRegion="polite" style={styles.note}>
          Live market data is unavailable{catalog ? '; showing the last fetched page.' : '.'}
        </Text>
      ) : null}
      {state === 'error' ? (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            void fetchPage(retry.current.cursor, retry.current.append, generation.current)
          }
          style={styles.more}
        >
          <Text style={styles.moreText}>Retry market data</Text>
        </Pressable>
      ) : null}
      {catalog?.dataStatus === 'stale' ? (
        <Text accessibilityLiveRegion="polite" style={styles.note}>
          Catalog data may be out of date (fetched {Math.floor(catalog.ageMs / 1000)}s ago).
        </Text>
      ) : null}
      {catalog?.sourceTruncated ? (
        <Text style={styles.note}>
          The upstream catalog is bounded; additional source markets may be omitted.
        </Text>
      ) : null}
      {rows.map((market) => (
        <View key={market.id} style={styles.card}>
          <Text style={styles.question}>{market.question}</Text>
          {market.slug ? (
            <Text selectable style={styles.meta}>
              /{market.slug}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            {market.closed ? 'Closed' : market.active ? 'Active' : 'Inactive'}
          </Text>
          <Text style={styles.meta}>Read-only catalog entry · trading unavailable</Text>
        </View>
      ))}
      {catalog && rows.length === 0 ? (
        <Text style={styles.note}>No catalog markets were returned.</Text>
      ) : null}
      {catalog?.nextCursor ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: loadingMore, busy: loadingMore }}
          disabled={loadingMore}
          onPress={loadMore}
          style={styles.more}
        >
          <Text style={styles.moreText}>{loadingMore ? 'Loading more…' : 'Load more markets'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  section: { padding: 20, gap: 12 },
  heading: { color: c.text, fontSize: 18, fontWeight: '600' },
  note: { color: c.textSecondary, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: c.card, ...radius(16), padding: 16, gap: 6 },
  question: { color: c.text, fontSize: 16, lineHeight: 22 },
  meta: { color: c.textSecondary, fontSize: 13 },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  moreText: { color: c.text, fontSize: 15, fontWeight: '600' },
}));
