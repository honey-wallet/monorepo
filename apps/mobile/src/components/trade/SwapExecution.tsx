import {
  formatTokenAmount,
  type OperationRecovery,
  parseTokenAmount,
  type SwapExecutionConfiguration,
  type SwapIntent,
  type SwapQuote,
  type SwapReviewContext,
  type SwapReviewRequest,
  type SwapSigningRequest,
  validateSwapQuote,
  validateSwapReview,
} from '@honey-wallet/api-client';
import * as Crypto from 'expo-crypto';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, Text, TextInput, View } from 'react-native';
import { OperationHistory } from '@/components/activity/OperationHistory';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable } from '@/components/sheets/Details';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { signReviewedSwap, signReviewedSwapPermit } from '@/lib/uniswap-execution';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles } from '@/theme';

type Pending = {
  key: string;
  intent: SwapIntent;
  configuration: SwapExecutionConfiguration;
  signer: string;
  accountId: string;
};
/** Mounted beside live quotes; explicit local execution config gates all actions. */
export function SwapExecution({ quote }: { quote: SwapQuote | null }) {
  const styles = useStyles(),
    wallet = useActiveWallet(),
    session = backendSession.useValue();
  const [config, setConfig] = useState<SwapExecutionConfiguration | null>(null),
    [fee, setFee] = useState('');
  const [pending, setPending] = useState<Pending | null>(null),
    [operation, setOperation] = useState<OperationRecovery | null>(null);
  const [review, setReview] = useState<SwapReviewRequest | null>(null),
    [signing, setSigning] = useState<SwapSigningRequest | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    locked = useRef(false),
    id = operation?.operation.id,
    sessionWallet = session.profile?.wallet.id;
  useFocusEffect(
    useCallback(() => {
      let live = true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const epoch = ++generation.current;
      const poll = async () => {
        if (!live || AppState.currentState !== 'active') return;
        const token = backendSessionToken();
        try {
          if (!id) {
            const c = await api.swapExecution({ signal: controller.signal });
            if (live) setConfig(c);
          } else if (token && sessionWallet) {
            const o = await api.operation(token, id, { signal: controller.signal });
            if (live && token === backendSessionToken()) setOperation(o);
            if (['succeeded', 'failed'].includes(o.operation.state)) return;
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
          setReview(null);
          setSigning(null);
        } else {
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
        setSigning(null);
      };
    }, [id, sessionWallet]),
  );
  async function run(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Swap request failed.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function owner() {
    const p = backendSession.get().profile,
      token = backendSessionToken();
    if (
      !token ||
      p?.wallet.address.toLowerCase() !== wallet.address.toLowerCase() ||
      p.wallet.chainId !== 'eip155:31337'
    )
      throw new Error('Sign in with this wallet on the local test network.');
    return token;
  }
  async function create() {
    const token = owner(),
      epoch = generation.current;
    if (!config) throw new Error('Execution unavailable.');
    let p = pending;
    if (!p) {
      if (!quote) throw new Error('Refresh the quote first.');
      validateSwapQuote(
        quote,
        config.quote,
        {
          tokenIn: quote.tokenIn,
          tokenOut: quote.tokenOut,
          amountRaw: quote.amountInRaw,
          slippageBps: quote.slippageBps,
        },
        wallet.address,
      );
      p = {
        key: Crypto.randomUUID(),
        intent: {
          tokenIn: quote.tokenIn,
          tokenOut: quote.tokenOut,
          amountRaw: quote.amountInRaw,
          slippageBps: String(quote.slippageBps),
          minimumOutputRaw: quote.minimumOutputRaw,
          deadline: String(Math.floor(Date.now() / 1000) + 300),
          maximumNetworkFeeRaw: parseTokenAmount(fee, 18),
        },
        configuration: config,
        accountId: wallet.id,
        signer: wallet.address,
      };
      setPending(p);
    }
    const o = await api.createSwapOperation(token, p.key, p.intent);
    if (epoch === generation.current && token === backendSessionToken()) setOperation(o);
  }
  function context(r: SwapReviewRequest): SwapReviewContext {
    if (!pending || pending.accountId !== wallet.id)
      throw new Error('Reopen the original request.');
    return {
      configuration: pending.configuration,
      intent: pending.intent,
      signer: pending.signer,
      operationId: r.operationId,
      reviewHash: r.reviewHash,
    };
  }
  async function loadReview() {
    const token = owner(),
      epoch = generation.current;
    if (!id) throw new Error('Missing request.');
    const r = await api.swapReview(token, id);
    validateSwapReview(r, context(r));
    let s: SwapSigningRequest | null = null;
    if (operation?.operation.state === 'awaiting_signature')
      s = await api.swapSigningRequest(token, id);
    if (epoch === generation.current && token === backendSessionToken()) {
      setReview(r);
      setSigning(s);
    }
  }
  async function confirm() {
    const token = owner(),
      epoch = generation.current;
    if (!review || !pending) throw new Error('Review again.');
    const r = review,
      s = signing,
      c = context(r);
    setReview(null);
    setSigning(null);
    const valid = () =>
      generation.current === epoch &&
      AppState.currentState === 'active' &&
      backendSessionToken() === token;
    const o = s
      ? await signReviewedSwap(s, c, pending.accountId, valid)
      : await signReviewedSwapPermit(r, c, pending.accountId, valid);
    if (valid()) setOperation(o);
  }
  async function resume(o: OperationRecovery) {
    if (locked.current) throw new Error('Finish the current review first.');
    const token = owner(),
      epoch = generation.current;
    if (
      !config ||
      o.operation.walletId !== sessionWallet ||
      o.submission ||
      !['created', 'awaiting_permit', 'building_swap', 'awaiting_signature'].includes(
        o.operation.state,
      )
    )
      throw new Error('Request cannot be resumed.');
    const i = await api.swapIntent(token, o.operation.id);
    if (
      epoch !== generation.current ||
      token !== backendSessionToken() ||
      i.signer !== wallet.address.toLowerCase() ||
      i.registryRevision !== config.quote.registryRevision ||
      i.feePolicyRevision !== config.quote.feePolicyRevision
    )
      throw new Error('Wallet or policy changed.');
    setPending({
      key: Crypto.randomUUID(),
      intent: i.intent,
      configuration: config,
      signer: i.signer,
      accountId: wallet.id,
    });
    setReview(null);
    setSigning(null);
    setOperation(o);
  }
  if (!config || wallet.demo || wallet.watchOnly || wallet.kind !== 'wallet') return null;
  const state = operation?.operation.state,
    r = review?.review;
  const tokenIn = config.quote.tokens.find((t) => t.address === pending?.intent.tokenIn);
  const tokenOut = config.quote.tokens.find((t) => t.address === pending?.intent.tokenOut);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Swap · local test network</Text>
      <Text style={styles.note}>
        Test funds only. Review token permission first, then the transaction and network fee.
      </Text>
      {!operation ? <OperationHistory onResume={resume} resumeProvider="uniswap" /> : null}
      {!pending ? (
        <>
          <Text style={styles.note}>Maximum total network fee (ETH)</Text>
          <TextInput
            accessibilityLabel="Maximum swap network fee in ETH"
            style={styles.input}
            value={fee}
            onChangeText={setFee}
            keyboardType="decimal-pad"
            editable={!busy}
          />
        </>
      ) : null}
      {!operation ? (
        <PillButton
          label={pending ? 'Retry request' : 'Prepare swap review'}
          disabled={busy || (!quote && !pending)}
          onPress={() => void run(create)}
        />
      ) : null}
      {operation ? (
        <>
          <Copyable value={operation.operation.id} toast="Request ID copied" />
          <Text style={styles.note}>Status: {state?.replaceAll('_', ' ')}</Text>
          <PillButton
            label="Refresh status"
            variant="secondary"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const token = owner();
                const result = await api.operation(token, operation.operation.id);
                if (token === backendSessionToken()) setOperation(result);
              })
            }
          />
        </>
      ) : null}
      {state === 'awaiting_permit' || state === 'awaiting_signature' ? (
        <PillButton
          label="Review swap"
          variant="secondary"
          disabled={busy}
          onPress={() => void run(loadReview)}
        />
      ) : null}
      {r ? (
        <>
          <Text selectable style={styles.note}>
            Spend at most {formatTokenAmount(r.authority.maximumInputRaw, tokenIn?.decimals ?? 0)}{' '}
            {tokenIn?.symbol ?? 'base units'}. Receive at least{' '}
            {formatTokenAmount(r.authority.minimumOutputRaw, tokenOut?.decimals ?? 0)}{' '}
            {tokenOut?.symbol ?? 'base units'}. Recipient: {r.authority.owner}.
          </Text>
          <Text style={styles.note}>
            Deadline: {new Date(r.expiresAtMs).toLocaleTimeString()}. Network fee limit:{' '}
            {formatTokenAmount(
              signing?.prepared.plan.maximumNetworkFeeRaw ?? r.maximumNetworkFeeRaw,
              18,
            )}{' '}
            ETH.
          </Text>
          {r.authority.fees.map((f) => (
            <Text selectable key={f.recipient} style={styles.note}>
              Output fee: up to {f.maximumBps} bps plus {f.maximumRoundingRaw} base-unit rounding to{' '}
              {f.recipient}. Actual amount can change.
            </Text>
          ))}
          {r.authority.fees.length === 0 ? (
            <Text style={styles.note}>Integrator fee: 0.</Text>
          ) : null}
          {r.permit && !signing ? (
            <Text selectable style={styles.note}>
              Permit2 may allow router {r.permit.spender} to spend {r.permit.amountRaw} token base
              units until {new Date(Number(r.permit.expiration) * 1000).toLocaleString()}.
              Permission alone does not complete a swap.
            </Text>
          ) : null}
          <PillButton
            label={
              signing
                ? `Confirm ${signing.prepared.plan.steps.length} transaction(s)`
                : 'Confirm token permission'
            }
            disabled={busy}
            onPress={() => void run(confirm)}
          />
        </>
      ) : null}
      {operation?.submission?.transactionHashes.map((h) => (
        <Copyable key={h} value={h} toast="Transaction hash copied" />
      )) ?? null}
      {state === 'succeeded' && operation ? (
        <SuccessPage
          compact
          title="Swap finalized on the test network"
          detail="These are local test transactions."
          rows={[
            {
              label: 'Request',
              value: <Copyable value={operation.operation.id} toast="Request ID copied" />,
            },
            {
              label: 'Wallet',
              value: (
                <Copyable value={pending?.signer ?? wallet.address} toast="Wallet address copied" />
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
            setSigning(null);
            setError(null);
          }}
          share={`Local Uniswap test request ${operation.operation.id}`}
        />
      ) : null}
      {state === 'unknown' ? (
        <Text style={styles.note}>
          Outcome pending. Check status before creating another trade.
        </Text>
      ) : null}
      {state === 'failed' ||
      (!operation?.submission &&
        pending &&
        Number(pending.intent.deadline) * 1000 <= Date.now()) ? (
        <PillButton
          label="Start a new review"
          variant="secondary"
          disabled={busy}
          onPress={() => {
            generation.current++;
            setPending(null);
            setOperation(null);
            setReview(null);
            setSigning(null);
            setError(null);
          }}
        />
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
  card: { backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 12 },
  title: { color: c.text, fontSize: 17, fontWeight: '600' },
  note: { color: c.textSecondary, fontSize: 13, lineHeight: 19 },
  input: { backgroundColor: c.raised, borderRadius: 12, padding: 12, color: c.text },
  error: { color: c.text, fontSize: 13 },
}));
