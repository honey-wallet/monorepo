import { type EarnCatalog, formatEarnApy } from '@honey-wallet/api-client';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { SheetHeader, SheetScreen } from '@/components/sheets/Sheet';
import { TabScreen } from '@/components/wallet/TabScreen';
import { api } from '@/lib/api';
import { makeStyles, radius } from '@/theme';
import { AaveExecution } from './AaveExecution';
import { MorphoExecution } from './MorphoExecution';

export function LiveSavingsScreen() {
  return (
    <TabScreen title="Savings">
      <LiveEarnMarkets />
    </TabScreen>
  );
}
export function LiveEarnSheet({ symbol }: { symbol?: string }) {
  return (
    <SheetScreen>
      <SheetHeader title="Earn markets" />
      <LiveEarnMarkets symbol={symbol} />
    </SheetScreen>
  );
}
/** Public indexed observations. No balance, guaranteed return or executable action is inferred. */
export function LiveEarnMarkets({ symbol }: { symbol?: string }) {
  const styles = useStyles();
  const [catalog, setCatalog] = useState<EarnCatalog | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'paused'>('loading');
  useFocusEffect(
    useCallback(() => {
      let cancel: (() => void) | undefined;
      const stop = () => {
        cancel?.();
        cancel = undefined;
        setState('paused');
      };
      const start = () => {
        stop();
        cancel = api.subscribeEarnCatalog({ onCatalog: setCatalog, onState: setState });
      };
      if (AppState.currentState === 'active') start();
      const listener = AppState.addEventListener('change', (next) =>
        next === 'active' ? start() : stop(),
      );
      return () => {
        stop();
        listener.remove();
      };
    }, []),
  );
  const products =
    catalog?.products.filter((p) => !symbol || p.observation?.asset.symbol === symbol) ?? [];
  return (
    <View style={styles.section}>
      <AaveExecution />
      <MorphoExecution />
      <Text style={styles.heading}>Earn markets</Text>
      <Text style={styles.note}>
        Savings positions are not connected yet. These rates describe the markets, not your wallet's
        earnings.
      </Text>
      {state === 'loading' && !catalog ? (
        <SkeletonBar width="100%" height={80} radius={20} />
      ) : null}
      {state === 'error' ? (
        <Text accessibilityLiveRegion="polite" style={styles.note}>
          Market updates are unavailable. Previously fetched rates may be out of date.
        </Text>
      ) : null}
      {state === 'paused' ? <Text style={styles.note}>Market updates paused.</Text> : null}
      {catalog?.status === 'not_configured' ? (
        <Text style={styles.note}>Earn markets are not available yet.</Text>
      ) : null}
      {catalog && catalog.status !== 'not_configured' && products.length === 0 ? (
        <Text style={styles.note}>No market data for this asset.</Text>
      ) : null}
      {products.map((p) => (
        <View key={p.id} style={styles.card}>
          <Text style={styles.title}>{p.label}</Text>
          <Text style={styles.note}>
            {p.protocol === 'aave_v3' ? 'Aave V3' : 'Morpho Vault V2'} · Chain {p.chainId}
          </Text>
          <Text style={styles.rate}>
            {p.observation?.supplyApy
              ? formatEarnApy(p.observation.supplyApy.fraction)
              : 'Rate unavailable'}
          </Text>
          <Text style={styles.note}>
            {p.protocol === 'morpho_vault_v2'
              ? 'Past-day APY · after vault fees'
              : 'Current supply APY'}{' '}
            · excludes rewards
          </Text>
          <Text style={styles.note}>
            {p.status === 'fresh' && state === 'ready'
              ? `Fetched ${Math.floor((p.ageMs ?? 0) / 1000)}s ago`
              : p.status === 'unavailable'
                ? 'Market data unavailable'
                : 'Data may be out of date'}
          </Text>
          <Text selectable style={styles.address}>
            {p.contractAddress}
          </Text>
          {p.observation?.restrictions.paused ||
          p.observation?.restrictions.frozen ||
          p.observation?.restrictions.supplyCapReached ||
          p.observation?.restrictions.gated ? (
            <Text style={styles.note}>This market reports a restriction.</Text>
          ) : null}
        </View>
      ))}
      <Text style={styles.note}>
        Deposits and withdrawals are not available yet. Rates vary; indexed liquidity is not a
        withdrawal guarantee.
      </Text>
    </View>
  );
}
const useStyles = makeStyles((c) => ({
  section: { padding: 20, gap: 12 },
  heading: { color: c.textSecondary, fontSize: 15 },
  card: { backgroundColor: c.card, ...radius(20), padding: 18, gap: 8 },
  title: { color: c.text, fontSize: 17 },
  rate: { color: c.text, fontSize: 24, fontVariant: ['tabular-nums'] },
  note: { color: c.textSecondary, fontSize: 15, lineHeight: 21 },
  address: { color: c.textSecondary, fontSize: 12 },
}));
