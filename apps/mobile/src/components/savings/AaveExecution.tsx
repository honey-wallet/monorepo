import {
  type AaveExecutionConfiguration,
  type AaveIntent,
  type AaveReviewContext,
  type AaveSigningRequest,
  type OperationRecovery,
  validateAaveReview,
} from '@honey-wallet/api-client';
import * as Crypto from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, Text, TextInput, View } from 'react-native';
import { OperationHistory } from '@/components/activity/OperationHistory';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable } from '@/components/sheets/Details';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { aaveDisplayAmount, aaveRawAmount, signReviewedAave } from '@/lib/aave-execution';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles } from '@/theme';

type Pending = {
  key: string;
  intent: AaveIntent;
  configuration: AaveExecutionConfiguration;
  accountId: string;
  signer: string;
};
/** Visible only for the explicitly configured execution network. All shown results
 * come from authenticated recovery; public market APY never enables execution. */
export function AaveExecution() {
  const wallet = useActiveWallet();
  return <AaveExecutionForWallet key={wallet.id} />;
}
function AaveExecutionForWallet() {
  const styles = useStyles();
  const wallet = useActiveWallet();
  const session = backendSession.useValue();
  const [configuration, setConfiguration] = useState<AaveExecutionConfiguration | null>(null);
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [operation, setOperation] = useState<OperationRecovery | null>(null);
  const [review, setReview] = useState<{
    signing: AaveSigningRequest;
    context: AaveReviewContext;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const locked = useRef(false);
  const id = operation?.operation.id;
  const sessionWalletId = session.profile?.wallet.id;
  useFocusEffect(
    useCallback(() => {
      let live = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const epoch = ++generation.current;
      const poll = async () => {
        if (!live || AppState.currentState !== 'active') return;
        const token = backendSessionToken();
        try {
          if (id && token && sessionWalletId) {
            const result = await api.operation(token, id, { signal: controller.signal });
            if (live) setOperation(result);
            if (['succeeded', 'failed'].includes(result.operation.state)) return;
          } else if (!id) {
            const c = await api.aaveExecution({ signal: controller.signal });
            if (live) setConfiguration(c);
          }
        } catch {
          if (live && id)
            setError('Status could not be refreshed. Keep this operation ID and check again.');
        }
        if (live && id) timer = setTimeout(() => void poll(), 5000);
      };
      void poll();
      const listener = AppState.addEventListener('change', (state) => {
        if (state === 'background') {
          generation.current++;
          setReview(null);
        }
        if (state === 'active') {
          clearTimeout(timer);
          void poll();
        }
      });
      return () => {
        live = false;
        controller.abort();
        clearTimeout(timer);
        listener.remove();
        if (generation.current === epoch) generation.current++;
        setReview(null);
      };
    }, [id, sessionWalletId]),
  );
  const current = () =>
    pending?.accountId === wallet.id &&
    pending.signer.toLowerCase() === session.profile?.wallet.address.toLowerCase();
  async function run(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not complete the request.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function create(action: 'supply' | 'withdraw') {
    const token = backendSessionToken();
    if (!configuration || !token || !session.profile)
      throw new Error('Sign in with this wallet first.');
    if (
      session.profile.wallet.chainId !== `eip155:${configuration.chainId}` ||
      session.profile.wallet.address.toLowerCase() !== wallet.address.toLowerCase()
    )
      throw new Error('Select the configured execution network and wallet.');
    const p = pending ?? {
      key: Crypto.randomUUID(),
      intent: {
        action,
        amountRaw: aaveRawAmount(amount, configuration.decimals),
        maximumNetworkFeeRaw: aaveRawAmount(fee, 18),
      },
      configuration,
      accountId: wallet.id,
      signer: wallet.address,
    };
    if (p.accountId !== wallet.id)
      throw new Error('Switch back to the wallet that created this operation.');
    setPending(p); // Keep this idempotency key after an ambiguous create response.
    const result = await api.createAaveOperation(token, p.key, p.intent);
    setOperation(result);
  }
  async function loadReview() {
    const token = backendSessionToken();
    if (!token || !pending || !operation?.preparation || !current())
      throw new Error('Sign in with the original wallet.');
    const epoch = generation.current;
    const signing = await api.aaveSigningRequest(token, operation.operation.id);
    const context: AaveReviewContext = {
      configuration: pending.configuration,
      intent: pending.intent,
      signer: pending.signer,
      operationId: operation.operation.id,
      operationVersion: operation.operation.version,
      planHash: operation.preparation.hash,
    };
    validateAaveReview(signing, context);
    if (generation.current === epoch && backendSessionToken() === token)
      setReview({ signing, context });
  }
  async function sign() {
    if (!review || !pending || !current()) throw new Error('Review the transaction again.');
    const epoch = generation.current;
    const r = review;
    setReview(null); // A timeout never leaves an automatic resend action enabled.
    const result = await signReviewedAave(
      r.signing,
      r.context,
      pending.accountId,
      () => generation.current === epoch,
    );
    if (generation.current === epoch) setOperation(result);
  }
  async function resume(saved: OperationRecovery) {
    if (locked.current) throw new Error('An operation is already being reviewed.');
    const token = backendSessionToken();
    if (
      !token ||
      !configuration ||
      saved.operation.walletId !== sessionWalletId ||
      saved.operation.state !== 'awaiting_signature' ||
      saved.submission !== null ||
      saved.preparation?.expired
    )
      throw new Error('Request is unavailable for review.');
    const epoch = generation.current;
    const recovered = await api.aaveIntent(token, saved.operation.id);
    if (
      generation.current !== epoch ||
      backendSessionToken() !== token ||
      recovered.signer !== wallet.address.toLowerCase() ||
      recovered.chainId !== configuration.chainId ||
      recovered.asset !== configuration.asset ||
      recovered.registryRevision !== configuration.registryRevision ||
      recovered.feePolicyRevision !== configuration.feePolicyRevision
    )
      throw new Error('Wallet or execution policy changed.');
    setReview(null);
    setPending({
      key: Crypto.randomUUID(),
      intent: recovered.intent,
      configuration,
      accountId: wallet.id,
      signer: recovered.signer,
    });
    setOperation(saved);
  }
  if (wallet.demo || wallet.watchOnly || wallet.kind !== 'wallet') return null;
  if (!configuration) return <OperationHistory />;
  const status = operation?.operation.state;
  const terminal = status === 'succeeded' || status === 'failed';
  return (
    <View style={{ gap: 12 }}>
      {operation ? null : <OperationHistory onResume={resume} />}
      <View style={styles.card}>
        <Text style={styles.title}>Aave · local test network</Text>
        <Text style={styles.note}>
          Chain {configuration.chainId}. This flow uses test funds. Production deposits are not
          enabled.
        </Text>
        <Text selectable style={styles.address}>
          Asset {configuration.asset}
        </Text>
        {!session.profile ? (
          <PillButton label="Sign in to continue" onPress={() => router.push('/wallet-sign-in')} />
        ) : null}
        {!pending ? (
          <>
            <Text style={styles.note}>Token amount</Text>
            <TextInput
              accessibilityLabel="Aave token amount"
              style={styles.input}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              editable={!busy}
            />
            <Text style={styles.note}>Maximum total network fee (ETH)</Text>
            <TextInput
              accessibilityLabel="Maximum Aave network fee in ETH"
              style={styles.input}
              value={fee}
              onChangeText={setFee}
              keyboardType="decimal-pad"
              editable={!busy}
            />
            <PillButton
              label="Prepare deposit"
              disabled={busy || !session.profile}
              onPress={() => void run(() => create('supply'))}
            />
            <PillButton
              label="Prepare withdrawal"
              variant="secondary"
              disabled={busy || !session.profile}
              onPress={() => void run(() => create('withdraw'))}
            />
          </>
        ) : !operation ? (
          <PillButton
            label="Recover preparation request"
            disabled={busy}
            onPress={() => void run(() => create(pending.intent.action))}
          />
        ) : null}
        {operation ? (
          <>
            <Text accessibilityLiveRegion="polite" style={styles.note}>
              {status === 'succeeded'
                ? 'Finalized on the test network'
                : status === 'unknown'
                  ? 'Checking the transaction outcome'
                  : status === 'confirming'
                    ? 'Included; waiting for finality'
                    : status === 'failed'
                      ? 'Operation failed'
                      : status === 'signed'
                        ? 'Signed; waiting for execution'
                        : status === 'awaiting_signature'
                          ? 'Ready for review'
                          : 'Preparing transaction'}
            </Text>
            <Text selectable style={styles.address}>
              Operation {operation.operation.id}
            </Text>
            {operation.submission?.transactionHashes.map((h) => (
              <Text selectable key={h} style={styles.address}>
                Transaction {h}
              </Text>
            ))}
            {status === 'awaiting_signature' && !operation.preparation?.expired && !review ? (
              <PillButton
                label="Review transaction"
                disabled={busy || !current()}
                onPress={() => void run(loadReview)}
              />
            ) : null}
            {operation.preparation?.expired && status === 'awaiting_signature' ? (
              <Text style={styles.note}>This unsigned request expired. Prepare a new request.</Text>
            ) : null}
          </>
        ) : null}
        {review ? (
          <>
            <Text style={styles.title}>
              {pending?.intent.action === 'supply' ? 'Review deposit' : 'Review withdrawal'}
            </Text>
            <Text style={styles.note}>
              Amount:{' '}
              {pending ? aaveDisplayAmount(pending.intent.amountRaw, configuration.decimals) : ''}{' '}
              tokens
            </Text>
            <Text selectable style={styles.address}>
              Recipient {review.signing.prepared.plan.signer}
            </Text>
            <Text style={styles.note}>
              Maximum total gas fee:{' '}
              {aaveDisplayAmount(review.signing.prepared.plan.maximumNetworkFeeRaw, 18)} ETH. App
              and provider fees: 0. {review.signing.prepared.plan.steps.length} transactions.
            </Text>
            {review.signing.prepared.plan.steps.map((s) => (
              <Text selectable style={styles.address} key={`${s.to}-${s.data}`}>
                {s.purpose} · {s.to}
              </Text>
            ))}
            <Text style={styles.note}>
              Approvals use the exact amount. An approval can remain if a later transaction cannot
              execute. Signature requests expire after two minutes; broadcast transactions can still
              settle later.
            </Text>
            <PillButton label="Confirm and sign" disabled={busy} onPress={() => void run(sign)} />
            <PillButton
              label="Cancel review"
              variant="secondary"
              disabled={busy}
              onPress={() => {
                generation.current++;
                setReview(null);
              }}
            />
          </>
        ) : null}
        {terminal || (status === 'awaiting_signature' && operation?.preparation?.expired) ? (
          <PillButton
            label="New request"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              generation.current++;
              setPending(null);
              setOperation(null);
              setReview(null);
            }}
          />
        ) : null}
        {status === 'succeeded' && operation ? (
          <SuccessPage
            compact
            title="Finalized on the test network"
            detail="Aave execution completed. These are local test transactions."
            rows={[
              {
                label: 'Operation',
                value: <Copyable value={operation.operation.id} toast="Operation ID copied" />,
              },
              {
                label: 'Wallet',
                value: (
                  <Copyable
                    value={pending?.signer ?? wallet.address}
                    toast="Wallet address copied"
                  />
                ),
              },
              ...(operation.submission?.transactionHashes.map((hash, n) => ({
                label: `Transaction ${n + 1}`,
                value: <Copyable value={hash} toast="Transaction hash copied" />,
              })) ?? []),
            ]}
            onDone={() => {
              generation.current++;
              setPending(null);
              setOperation(null);
              setReview(null);
            }}
            share={`Local Aave test operation ${operation.operation.id}`}
          />
        ) : null}
        {operation ? (
          <PillButton
            label="View all requests"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              generation.current++;
              setPending(null);
              setOperation(null);
              setReview(null);
            }}
          />
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
const useStyles = makeStyles((c) => ({
  card: { backgroundColor: c.card, borderRadius: 20, padding: 18, gap: 12 },
  title: { fontSize: 17, color: c.text },
  note: { fontSize: 15, lineHeight: 21, color: c.textSecondary },
  address: { fontSize: 12, color: c.textSecondary },
  input: { backgroundColor: c.raised, borderRadius: 12, padding: 12, color: c.text, fontSize: 18 },
  error: { fontSize: 15, color: c.error },
}));
