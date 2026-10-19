import {
  type BridgeStatusRecovery,
  bridgeStatusMessage,
  type OperationPage,
  type OperationRecovery,
} from '@honey-wallet/api-client';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable } from '@/components/sheets/Details';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles } from '@/theme';

const labels: Record<OperationRecovery['operation']['state'], string> = {
  created: 'Preparing',
  awaiting_permit: 'Awaiting token permission',
  building_swap: 'Preparing swap',
  awaiting_signature: 'Awaiting your signature',
  signed: 'Signed; awaiting execution',
  submitted: 'Submitted',
  confirming: 'Included; awaiting finality',
  bridging: 'Source finalized; delivery pending',
  succeeded: 'Finalized',
  failed: 'Failed',
  unknown: 'Outcome pending',
};
/** Ten summaries per page. Always fetch fresh owner-scoped state after sign-in;
 * no credentials or signing bytes are saved for app restart recovery. */
type Props = {
  onResume?: (operation: OperationRecovery) => Promise<void>;
  resumeProvider?: 'aave_v3' | 'morpho_vault_v2' | 'uniswap' | 'across';
};
export function OperationHistory(props: Props) {
  const profile = backendSession.useValue().profile;
  const wallet = useActiveWallet();
  const walletId =
    profile?.wallet.address.toLowerCase() === wallet.address.toLowerCase()
      ? profile.wallet.id
      : undefined;
  return <ScopedHistory key={walletId ?? 'signed-out'} {...props} walletId={walletId} />;
}
function ScopedHistory({
  onResume,
  walletId,
  resumeProvider = 'aave_v3',
}: Props & { walletId: string | undefined }) {
  const styles = useStyles();
  const [cursor, setCursor] = useState<string | undefined>();
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<OperationPage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OperationRecovery | null>(null);
  const [bridge, setBridge] = useState<BridgeStatusRecovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const resumeBusy = useRef(false);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      let controller: AbortController | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const sequence = ++generation.current;
      const stop = () => {
        controller?.abort();
        clearTimeout(timer);
      };
      const load = async () => {
        stop();
        if (!active || AppState.currentState !== 'active' || !walletId) return;
        const token = backendSessionToken();
        if (!token) return;
        const request = new AbortController();
        controller = request;
        const valid = () =>
          active &&
          !request.signal.aborted &&
          generation.current === sequence &&
          backendSessionToken() === token;
        setBusy(true);
        setError(null);
        try {
          if (selected) {
            const value = await api.operation(token, selected, { signal: request.signal });
            if (value.operation.walletId !== walletId) throw new Error('Wallet mismatch');
            const observation =
              value.operation.action === 'bridge'
                ? await api
                    .bridgeStatus(token, selected, { signal: request.signal })
                    .catch(() => null)
                : null;
            if (valid()) {
              setDetail(value);
              setBridge(observation);
              if (
                value.operation.action === 'bridge' ||
                !['succeeded', 'failed'].includes(value.operation.state)
              )
                timer = setTimeout(
                  () => void load(),
                  value.operation.action === 'bridge'
                    ? (observation?.observation?.pollAfterMs ?? 10000)
                    : 5000,
                );
            }
          } else {
            const value = await api.operations(
              token,
              { cursor, limit: 10 },
              { signal: request.signal },
            );
            if (value.items.some((i) => i.operation.walletId !== walletId))
              throw new Error('Wallet mismatch');
            if (valid()) setPage(value);
          }
        } catch {
          if (valid()) setError('Could not load your requests. Refresh to try again.');
        } finally {
          if (valid()) setBusy(false);
        }
      };
      // Refresh is an explicit user event, separate from the immutable page cursor.
      if (refresh >= 0) void load();
      const listener = AppState.addEventListener('change', (s) => {
        if (s === 'active') void load();
        else stop();
      });
      return () => {
        active = false;
        stop();
        listener.remove();
        generation.current++;
      };
    }, [walletId, cursor, selected, refresh]),
  );
  async function resume() {
    if (!onResume || !detail || resumeBusy.current) return;
    resumeBusy.current = true;
    setError(null);
    try {
      await onResume(detail);
      setSelected(null);
      setDetail(null);
      setRefresh((n) => n + 1);
    } catch {
      setError('This request cannot be resumed with the current wallet or execution policy.');
    } finally {
      resumeBusy.current = false;
    }
  }
  if (!walletId)
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Your Honey requests</Text>
        <Text style={styles.note}>Sign in to recover requests from previous sessions.</Text>
        <PillButton
          label="Sign in"
          variant="secondary"
          onPress={() => router.push('/wallet-sign-in')}
        />
      </View>
    );
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Your Honey requests</Text>
      <Text style={styles.note}>
        Requests made through Honey. This does not include all on-chain activity.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {busy && !page && !detail ? (
        <Text accessibilityLiveRegion="polite" style={styles.note}>
          Loading requests…
        </Text>
      ) : null}
      {selected ? (
        <>
          {detail && detail.operation.id === selected ? (
            <>
              <Text accessibilityLiveRegion="polite" style={styles.title}>
                {detail.operation.action === 'bridge'
                  ? bridge?.operationId === detail.operation.id
                    ? bridgeStatusMessage(bridge)
                    : 'Bridge outcome pending'
                  : labels[detail.operation.state]}
              </Text>
              {detail.operation.state === 'bridging' && !bridge?.verifiedDelivery ? (
                <Text style={styles.note}>Source finalized; destination delivery pending.</Text>
              ) : null}
              {bridge?.operationId === detail.operation.id && bridge.verifiedDelivery ? (
                <View>
                  <Text selectable style={styles.note}>
                    Verified delivery: {bridge.verifiedDelivery.deliveredAmountRaw} base units of{' '}
                    {bridge.verifiedDelivery.outputToken} to {bridge.verifiedDelivery.recipient} on
                    chain {bridge.verifiedDelivery.destinationChainId}.
                  </Text>
                  <Copyable
                    value={bridge.verifiedDelivery.destinationTransactionHash}
                    toast="Destination transaction hash copied"
                  />
                </View>
              ) : null}
              <Copyable value={detail.operation.id} toast="Operation ID copied" />
              {detail.operation.action === 'bridge' && bridge?.operationId === detail.operation.id
                ? bridge.observation?.candidates.map((candidate) => (
                    <View key={`${candidate.chainId}:${candidate.transactionHash}`}>
                      <Text style={styles.note}>
                        Reported {candidate.role === 'refund' ? 'refund' : 'destination'}{' '}
                        transaction · chain {candidate.chainId}
                      </Text>
                      <Copyable value={candidate.transactionHash} toast="Transaction hash copied" />
                    </View>
                  ))
                : null}
              {detail.preparation ? (
                <Text style={styles.note}>
                  {detail.preparation.provider} · chain {detail.preparation.chainId}
                  {detail.preparation.expired && detail.operation.state === 'awaiting_signature'
                    ? ' · unsigned request expired'
                    : ''}
                </Text>
              ) : null}
              {detail.submission?.transactionHashes.map((hash) => (
                <Copyable key={hash} value={hash} toast="Transaction hash copied" />
              ))}
              {detail.reconciliation ? (
                <Text style={styles.note}>
                  Last checked {new Date(detail.reconciliation.checkedAtMs).toLocaleTimeString()}.{' '}
                  {detail.reconciliation.transactions.filter((t) => t.inclusion?.finalized).length}{' '}
                  of {detail.reconciliation.transactions.length}{' '}
                  {detail.operation.action === 'bridge'
                    ? 'source transactions finalized; destination outcome is separate.'
                    : 'transactions finalized.'}
                </Text>
              ) : null}
              {onResume &&
              ((resumeProvider === 'across' &&
                detail.operation.action === 'bridge' &&
                detail.operation.state === 'created' &&
                detail.intentAvailable) ||
                (resumeProvider === 'uniswap' &&
                  detail.operation.action === 'swap' &&
                  ['created', 'awaiting_permit', 'building_swap'].includes(
                    detail.operation.state,
                  ) &&
                  detail.intentAvailable) ||
                (detail.operation.state === 'awaiting_signature' &&
                  detail.preparation?.provider === resumeProvider &&
                  !detail.preparation.expired)) ? (
                <PillButton
                  label="Review unsigned request"
                  disabled={busy}
                  onPress={() => void resume()}
                />
              ) : null}
            </>
          ) : null}
          <PillButton
            label="Back to requests"
            variant="secondary"
            onPress={() => {
              setSelected(null);
              setDetail(null);
            }}
          />
        </>
      ) : (
        <>
          {page?.items.length === 0 ? (
            <Text style={styles.note}>No Honey requests for this wallet yet.</Text>
          ) : null}
          {page?.items.map((item) => (
            <View style={styles.item} key={item.operation.id}>
              <Text style={styles.note}>
                {new Date(item.createdAtMs).toLocaleString()} · {item.operation.action}
              </Text>
              <PillButton
                label={
                  item.operation.action === 'bridge'
                    ? 'Check destination status'
                    : labels[item.operation.state]
                }
                variant="secondary"
                onPress={() => {
                  setDetail(null);
                  setSelected(item.operation.id);
                }}
              />
            </View>
          ))}
          {page?.nextCursor ? (
            <PillButton
              label="Older requests"
              variant="secondary"
              disabled={busy}
              onPress={() => {
                setCursor(page.nextCursor ?? undefined);
                setPage(null);
              }}
            />
          ) : null}
        </>
      )}
      <PillButton
        label={selected ? 'Refresh status' : 'Newest requests'}
        variant="secondary"
        disabled={busy}
        onPress={() => {
          if (!selected) setCursor(undefined);
          setRefresh((n) => n + 1);
        }}
      />
    </View>
  );
}
const useStyles = makeStyles((c) => ({
  card: { backgroundColor: c.card, borderRadius: 20, padding: 18, gap: 12 },
  item: { gap: 8 },
  title: { fontSize: 17, color: c.text },
  note: { fontSize: 15, lineHeight: 21, color: c.textSecondary },
  error: { fontSize: 15, color: c.error },
}));
