import {
  type AcrossExecutionConfiguration,
  type AcrossIntent,
  type AcrossQuote,
  type AcrossReviewContext,
  type AcrossSigningRequest,
  formatTokenAmount,
  type OperationRecovery,
  parseTokenAmount,
  type VerifiedBridgeDelivery,
  validateAcrossQuote,
  validateAcrossSigning,
} from '@honey-wallet/api-client';
import * as Crypto from 'expo-crypto';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Text, TextInput, View } from 'react-native';
import { OperationHistory } from '@/components/activity/OperationHistory';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable } from '@/components/sheets/Details';
import { signReviewedAcross } from '@/lib/across-execution';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius } from '@/theme';

type Pending = {
  key: string;
  intent: AcrossIntent;
  configuration: AcrossExecutionConfiguration;
  signer: string;
  accountId: string;
};
async function readRecovery(token: string, id: string, signal: AbortSignal) {
  const [value, status] = await Promise.all([
    api.operation(token, id, { signal }),
    api.bridgeStatus(token, id, { signal }).catch(() => null),
  ]);
  const delivery = status?.verifiedDelivery ?? null;
  if (delivery && delivery.sourceTransactionHash !== value.submission?.transactionHashes.at(-1))
    throw new Error('Bridge evidence does not match the source transaction.');
  return { value, delivery };
}
/** Explicit local-fork registry only. Source finality never means destination delivery. */
export function AcrossExecution({ quote }: { quote: AcrossQuote | null }) {
  const styles = useStyles(),
    wallet = useActiveWallet(),
    session = backendSession.useValue();
  const [config, setConfig] = useState<AcrossExecutionConfiguration | null>(null),
    [fee, setFee] = useState('');
  const [pending, setPending] = useState<Pending | null>(null),
    [operation, setOperation] = useState<OperationRecovery | null>(null);
  const [delivery, setDelivery] = useState<VerifiedBridgeDelivery | null>(null);
  const [signing, setSigning] = useState<AcrossSigningRequest | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    locked = useRef(false),
    flight = useRef<AbortController | null>(null),
    id = operation?.operation.id,
    sessionWallet = session.profile?.wallet.id;
  useFocusEffect(
    useCallback(() => {
      let live = true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      generation.current++;
      const poll = async () => {
        if (!live || AppState.currentState !== 'active') return;
        const token = backendSessionToken();
        try {
          if (!id) {
            const c = await api.acrossExecution({ signal: controller.signal });
            if (live && !controller.signal.aborted) setConfig(c);
          } else if (token && sessionWallet) {
            const { value, delivery } = await readRecovery(token, id, controller.signal);
            if (value.operation.walletId !== sessionWallet) throw new Error('Wallet mismatch');
            if (live && token === backendSessionToken()) {
              setOperation(value);
              setDelivery(delivery);
            }
            if (['succeeded', 'failed'].includes(value.operation.state)) return;
          }
        } catch {
          if (live && id) setError('Status unavailable. Keep the request ID and refresh.');
        }
        if (live && id) timer = setTimeout(() => void poll(), 5000);
      };
      void poll();
      const listener = AppState.addEventListener('change', (state) => {
        if (state !== 'active') {
          generation.current++;
          clearTimeout(timer);
          flight.current?.abort();
          setSigning(null);
        } else {
          clearTimeout(timer);
          void poll();
        }
      });
      return () => {
        live = false;
        generation.current++;
        controller.abort();
        flight.current?.abort();
        clearTimeout(timer);
        listener.remove();
        setSigning(null);
      };
    }, [id, sessionWallet]),
  );
  useEffect(() => {
    if (!signing) return;
    if (
      operation?.operation.state !== 'awaiting_signature' ||
      operation.operation.version !== signing.operationVersion ||
      operation.preparation?.hash !== signing.planHash
    ) {
      generation.current++;
      setSigning(null);
      return;
    }
    const timer = setTimeout(
      () => {
        setSigning(null);
        setError('Review expired. Check the request status before starting again.');
      },
      Math.max(0, signing.review.expiresAtMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [signing, operation]);
  function owner() {
    const p = backendSession.get().profile,
      token = backendSessionToken();
    if (
      !token ||
      !p ||
      p.wallet.id !== sessionWallet ||
      p.wallet.address.toLowerCase() !== wallet.address.toLowerCase() ||
      p.wallet.chainId !== 'eip155:31337'
    )
      throw new Error('Sign in with this wallet on the local test network.');
    return token;
  }
  async function run(fn: (signal: AbortSignal) => Promise<void>, rethrow = false) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    flight.current = controller;
    const epoch = generation.current;
    try {
      await fn(controller.signal);
    } catch (e) {
      if (epoch === generation.current && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Bridge request failed.');
      if (rethrow) throw e;
    } finally {
      if (flight.current === controller) flight.current = null;
      locked.current = false;
      setBusy(false);
    }
  }
  async function create(signal: AbortSignal) {
    const token = owner(),
      epoch = generation.current;
    if (!config) throw new Error('Execution unavailable.');
    let p = pending;
    if (!p) {
      if (!quote) throw new Error('Refresh the bridge quote first.');
      validateAcrossQuote(
        quote,
        config.quote,
        {
          routeId: quote.routeId,
          amountRaw: quote.inputAmountRaw,
          minimumOutputRaw: quote.minimumOutputRaw,
          recipient: quote.recipient,
        },
        wallet.address,
      );
      p = {
        key: Crypto.randomUUID(),
        intent: {
          quoteId: quote.quoteId,
          routeId: quote.routeId,
          amountRaw: quote.inputAmountRaw,
          minimumOutputRaw: quote.minimumOutputRaw,
          recipient: quote.recipient,
          deadline: String(Math.floor(Date.now() / 1000) + 300),
          maximumNetworkFeeRaw: parseTokenAmount(fee, 18),
        },
        configuration: config,
        signer: wallet.address,
        accountId: wallet.id,
      };
      setPending(p);
    }
    const value = await api.createAcrossOperation(token, p.key, p.intent, { signal });
    if (value.operation.walletId !== sessionWallet) throw new Error('Wallet mismatch');
    if (epoch === generation.current && token === backendSessionToken() && !signal.aborted)
      setOperation(value);
  }
  function context(): AcrossReviewContext {
    if (!pending || pending.accountId !== wallet.id || !operation?.preparation)
      throw new Error('Reopen the original request.');
    return {
      configuration: pending.configuration,
      intent: pending.intent,
      signer: pending.signer,
      operationId: operation.operation.id,
      operationVersion: operation.operation.version,
      planHash: operation.preparation.hash,
    };
  }
  async function loadReview(signal: AbortSignal) {
    const token = owner(),
      epoch = generation.current;
    if (!id || operation?.operation.state !== 'awaiting_signature')
      throw new Error('Request is not ready to review.');
    const r = await api.acrossSigningRequest(token, id, { signal });
    validateAcrossSigning(r, context());
    if (epoch === generation.current && token === backendSessionToken() && !signal.aborted)
      setSigning(r);
  }
  async function confirm() {
    const token = owner(),
      epoch = generation.current;
    if (!signing || !pending) throw new Error('Review again.');
    const r = signing,
      c = context();
    setSigning(null);
    const valid = () =>
      epoch === generation.current &&
      AppState.currentState === 'active' &&
      token === backendSessionToken();
    const value = await signReviewedAcross(r, c, pending.accountId, valid);
    if (valid()) setOperation(value);
  }
  async function resume(value: OperationRecovery) {
    if (locked.current) throw new Error('Finish the current review first.');
    await run(async (signal) => {
      const token = owner(),
        epoch = generation.current;
      if (
        !config ||
        value.operation.walletId !== sessionWallet ||
        value.operation.action !== 'bridge' ||
        value.submission ||
        !['created', 'awaiting_signature'].includes(value.operation.state)
      )
        throw new Error('Request cannot be resumed.');
      const intent = await api.acrossIntent(token, value.operation.id, { signal });
      if (
        epoch !== generation.current ||
        token !== backendSessionToken() ||
        intent.signer !== wallet.address.toLowerCase() ||
        intent.registryRevision !== config.quote.registryRevision
      )
        throw new Error('Wallet or policy changed.');
      setPending({
        key: Crypto.randomUUID(),
        intent: intent.intent,
        configuration: config,
        signer: intent.signer,
        accountId: wallet.id,
      });
      setSigning(null);
      setDelivery(null);
      setOperation(value);
    }, true);
  }
  if (!config || wallet.demo || wallet.watchOnly || wallet.kind !== 'wallet') return null;
  const state = operation?.operation.state,
    review = signing?.review,
    route = config.quote.routes.find((r) => r.id === pending?.intent.routeId);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Bridge · local test networks</Text>
      <Text style={styles.note}>
        Test funds only. The source deposit and destination delivery are verified separately.
      </Text>
      {!operation ? <OperationHistory onResume={resume} resumeProvider="across" /> : null}
      {!pending ? (
        <>
          <Text style={styles.note}>Maximum total source network fee (ETH)</Text>
          <TextInput
            accessibilityLabel="Maximum bridge network fee in ETH"
            value={fee}
            onChangeText={setFee}
            keyboardType="decimal-pad"
            editable={!busy}
            style={styles.input}
          />
        </>
      ) : null}
      {!operation ? (
        <PillButton
          label={pending ? 'Retry same bridge request' : 'Prepare bridge review'}
          disabled={busy || (!quote && !pending)}
          onPress={() => void run(create)}
        />
      ) : null}
      {operation ? (
        <>
          <Copyable value={operation.operation.id} toast="Request ID copied" />
          <Text style={styles.note}>
            {delivery
              ? 'Destination delivery verified.'
              : state === 'bridging'
                ? 'Source finalized; destination delivery pending.'
                : state === 'succeeded'
                  ? 'Bridge settled. Refresh to load delivery evidence.'
                  : `Status: ${state?.replaceAll('_', ' ')}`}
          </Text>
          <PillButton
            label="Refresh status"
            variant="secondary"
            disabled={busy}
            onPress={() =>
              void run(async (signal) => {
                const token = owner(),
                  epoch = generation.current;
                const { value, delivery } = await readRecovery(
                  token,
                  operation.operation.id,
                  signal,
                );
                if (
                  epoch === generation.current &&
                  token === backendSessionToken() &&
                  !signal.aborted
                ) {
                  setOperation(value);
                  setDelivery(delivery);
                }
              })
            }
          />
        </>
      ) : null}
      {state === 'awaiting_signature' && !signing ? (
        <PillButton
          label="Review bridge"
          variant="secondary"
          disabled={busy}
          onPress={() => void run(loadReview)}
        />
      ) : null}
      {review && route ? (
        <View style={styles.group}>
          <Text selectable style={styles.note}>
            Deposit {formatTokenAmount(review.terms.inputAmount, route.inputToken.decimals)}{' '}
            {route.inputToken.symbol} on chain {review.terms.sourceChain}. Receive{' '}
            {formatTokenAmount(review.terms.outputAmount, route.outputToken.decimals)}{' '}
            {route.outputToken.symbol} on chain {review.terms.destinationChain}.
          </Text>
          <Text selectable style={styles.note}>
            Recipient: {review.terms.recipient}. Refund destination if applicable:{' '}
            {review.terms.depositor} on the source chain.
          </Text>
          <Text style={styles.note}>
            Bridge fee:{' '}
            {formatTokenAmount(
              (BigInt(review.terms.inputAmount) - BigInt(review.terms.outputAmount)).toString(),
              route.inputToken.decimals,
            )}{' '}
            {route.inputToken.symbol}. Integrator fee: 0.
          </Text>
          <Text style={styles.note}>
            Maximum source network fee:{' '}
            {formatTokenAmount(signing.prepared.plan.maximumNetworkFeeRaw, 18)} ETH. Review expires
            at {new Date(review.expiresAtMs).toLocaleTimeString()}. Destination fill deadline:{' '}
            {new Date(Number(review.terms.fillDeadline) * 1000).toLocaleTimeString()}.
          </Text>
          <Text selectable style={styles.note}>
            Spending contract: {review.sourceSpoke}. {signing.prepared.plan.steps.length - 1}{' '}
            approval transaction(s), limited to the deposit amount. Existing permissions may remain
            if no new approval is needed.
          </Text>
          <Text selectable style={styles.note}>
            Exclusive relayer: {review.terms.exclusiveRelayer}. Exclusivity:{' '}
            {Number(review.terms.exclusivityParameter) <= 31536000
              ? `${review.terms.exclusivityParameter} seconds after source inclusion`
              : new Date(Number(review.terms.exclusivityParameter) * 1000).toLocaleString()}
            .
          </Text>
          <PillButton
            label={`Confirm ${signing.prepared.plan.steps.length} transaction(s)`}
            disabled={busy}
            onPress={() => void run(confirm)}
          />
        </View>
      ) : null}
      {operation?.submission?.transactionHashes.map((hash) => (
        <Copyable key={hash} value={hash} toast="Source transaction hash copied" />
      )) ?? null}
      {delivery ? (
        <View>
          <Text selectable style={styles.note}>
            Verified destination delivery: {delivery.deliveredAmountRaw} base units of{' '}
            {delivery.outputToken} to {delivery.recipient} on chain {delivery.destinationChainId}.
          </Text>
          <Copyable
            value={delivery.destinationTransactionHash}
            toast="Destination transaction hash copied"
          />
        </View>
      ) : null}
      {state === 'unknown' ? (
        <Text style={styles.note}>
          Outcome pending. Check this request before creating another bridge.
        </Text>
      ) : null}
      {state === 'failed' ||
      state === 'succeeded' ||
      (!operation?.submission && operation?.preparation?.expired) ? (
        <PillButton
          label="Back to bridge quotes"
          variant="secondary"
          disabled={busy}
          onPress={() => {
            generation.current++;
            setPending(null);
            setOperation(null);
            setDelivery(null);
            setSigning(null);
            setError(null);
          }}
        />
      ) : null}
      {pending && !operation ? (
        <Text style={styles.note}>
          If the response was interrupted, retry this same request or check request history. Do not
          create another transfer until its status is known.
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
const useStyles = makeStyles((c) => ({
  card: { gap: 12, paddingTop: 16 },
  group: { gap: 10 },
  title: { fontSize: 15, color: c.textSecondary },
  note: { fontSize: 13, lineHeight: 19, color: c.textSecondary },
  input: { backgroundColor: c.raised, ...radius(12), padding: 12, color: c.text },
  error: { color: c.error, fontSize: 13 },
}));
