import type { HyperliquidPerpsAccountState } from '@honey-wallet/api-client';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { hyperliquidAccountMatchesWallet } from '@/lib/hyperliquid-account';
import { type AddedWallet, useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius } from '@/theme';

export function HyperliquidAccount() {
  const wallet = useActiveWallet();
  const session = backendSession.useValue();
  const key = [
    wallet.id,
    wallet.address.toLowerCase(),
    session.profile?.wallet.id ?? 'signed-out',
    session.profile?.wallet.address.toLowerCase() ?? '',
  ].join(':');
  return <HyperliquidAccountPanel key={key} wallet={wallet} session={session} />;
}

function HyperliquidAccountPanel({
  wallet,
  session,
}: {
  wallet: AddedWallet;
  session: ReturnType<typeof backendSession.get>;
}) {
  const styles = useStyles();
  const [account, setAccount] = useState<HyperliquidPerpsAccountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const flight = useRef<AbortController | null>(null);
  const sessionWallet = session.profile?.wallet;
  const eligible =
    !wallet.demo &&
    !wallet.watchOnly &&
    !!sessionWallet &&
    sessionWallet.id === wallet.id &&
    sessionWallet.address.toLowerCase() === wallet.address.toLowerCase();

  useFocusEffect(
    useCallback(() => {
      let live = true;
      generation.current++;
      setAccount(null);
      setError(null);
      setBusy(false);

      const clear = () => {
        generation.current++;
        flight.current?.abort();
        flight.current = null;
        if (live) {
          setAccount(null);
          setBusy(false);
        }
      };
      const listener = AppState.addEventListener('change', (state) => {
        if (state !== 'active') clear();
      });
      return () => {
        live = false;
        generation.current++;
        flight.current?.abort();
        flight.current = null;
        listener.remove();
      };
    }, []),
  );

  const current = () =>
    generation.current > 0 &&
    session.profile?.wallet.id === wallet.id &&
    session.profile.wallet.address.toLowerCase() === wallet.address.toLowerCase() &&
    backendSessionToken() !== null;

  async function loadAccount() {
    if (flight.current || busy || !eligible || AppState.currentState !== 'active') return;
    const token = backendSessionToken();
    if (!token) return;
    const epoch = ++generation.current;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await api.hyperliquidPerpsAccount(token, { signal: controller.signal });
      if (
        epoch !== generation.current ||
        controller.signal.aborted ||
        token !== backendSessionToken() ||
        !current()
      )
        return;
      if (!hyperliquidAccountMatchesWallet(result, wallet.address))
        throw new Error('Account response did not match the selected wallet.');
      setAccount(result);
    } catch (cause) {
      if (
        epoch === generation.current &&
        !controller.signal.aborted &&
        token === backendSessionToken()
      )
        setError(cause instanceof Error ? cause.message : 'Account data is unavailable.');
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (epoch === generation.current) setBusy(false);
      }
    }
  }

  const margin = account?.state.marginSummary;
  return (
    <View style={styles.section}>
      <Text style={styles.label}>Hyperliquid account</Text>
      <View style={styles.card}>
        <Text style={styles.body}>
          Read-only venue state for this signed-in wallet. Honey does not verify separate
          Hyperliquid account links here. No orders can be placed.
        </Text>
        {!eligible ? (
          <PillButton
            label="Sign in to Honey account"
            variant="secondary"
            onPress={() => router.push('/wallet-sign-in')}
          />
        ) : (
          <PillButton
            label={busy ? 'Loading account…' : account ? 'Refresh account' : 'Load account'}
            disabled={busy}
            onPress={() => void loadAccount()}
          />
        )}
        {margin && account ? (
          <View style={styles.values}>
            <Value label="Account value" value={`$${margin.accountValue}`} />
            <Value label="Open notional" value={`$${margin.totalNtlPos}`} />
            <Value label="Margin used" value={`$${margin.totalMarginUsed}`} />
            <Value label="Withdrawable" value={`$${account.state.withdrawable}`} />
            <Text style={styles.body}>Positions</Text>
            {account.state.assetPositions.length ? (
              account.state.assetPositions.map(({ position }) => (
                <View key={position.coin} style={styles.position}>
                  <Text style={styles.value}>
                    {position.coin} · {position.szi} · {position.leverage.value}x{' '}
                    {position.leverage.type}
                  </Text>
                  <Text style={styles.body}>
                    Unrealized PnL ${position.unrealizedPnl}
                    {position.liquidationPx === null
                      ? ''
                      : ` · liquidation ${position.liquidationPx}`}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.body}>No open positions reported.</Text>
            )}
            <Text style={styles.body}>
              Fetched {new Date(account.fetchedAtMs).toLocaleTimeString()}. Provider-reported
              values; refresh to check again.
            </Text>
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={styles.body}>{label}</Text>
      <Text selectable style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  section: { padding: 20, gap: 10 },
  label: { color: c.textSecondary, fontSize: 15 },
  card: { backgroundColor: c.card, ...radius(20), padding: 16, gap: 12 },
  body: { color: c.textSecondary, fontSize: 14, lineHeight: 20 },
  values: { gap: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  value: { color: c.text, fontSize: 15, fontVariant: ['tabular-nums'] },
  position: { backgroundColor: c.raised, ...radius(14), padding: 12, gap: 4 },
  error: { color: c.error, fontSize: 14, lineHeight: 20 },
}));
