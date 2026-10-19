import {
  type MorphoExecutionConfiguration,
  type MorphoIntent,
  type MorphoQuote,
  type MorphoReviewContext,
  type MorphoSigningRequest,
  morphoIntentFromQuote,
  type OperationRecovery,
  validateMorphoReview,
} from '@honey-wallet/api-client';
import * as Crypto from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, Text, TextInput, View } from 'react-native';
import { OperationHistory } from '@/components/activity/OperationHistory';
import { PillButton } from '@/components/onboarding/PillButton';
import { Copyable } from '@/components/sheets/Details';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { api } from '@/lib/api';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import {
  earnDisplayAmount as morphoDisplayAmount,
  earnRawAmount as morphoRawAmount,
} from '@/lib/earn-amount';
import { signReviewedMorpho } from '@/lib/morpho-execution';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles } from '@/theme';

type Pending = {
  key: string;
  intent: MorphoIntent;
  configuration: MorphoExecutionConfiguration;
  accountId: string;
  signer: string;
};
/** Visible only for the explicitly configured execution network. All shown results
 * come from authenticated recovery; public market APY never enables execution. */
export function MorphoExecution() {
  const wallet = useActiveWallet();
  return <MorphoExecutionForWallet key={wallet.id} />;
}
function MorphoExecutionForWallet() {
  const styles = useStyles();
  const wallet = useActiveWallet();
  const session = backendSession.useValue();
  const [configuration, setConfiguration] = useState<MorphoExecutionConfiguration | null>(null);
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [quote, setQuote] = useState<MorphoQuote | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [operation, setOperation] = useState<OperationRecovery | null>(null);
  const [review, setReview] = useState<{
    signing: MorphoSigningRequest;
    context: MorphoReviewContext;
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
            const c = await api.morphoExecution({ signal: controller.signal });
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
          setQuote(null);
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
  async function loadQuote(action: 'deposit' | 'redeem') {
    const token = backendSessionToken(),
      epoch = generation.current;
    if (
      !token ||
      !configuration ||
      session.profile?.wallet.address.toLowerCase() !== wallet.address.toLowerCase()
    )
      throw new Error('Sign in with this wallet first.');
    setQuote(null);
    const result = await api.morphoQuote(token, {
      action,
      amountRaw: morphoRawAmount(
        amount,
        action === 'deposit' ? configuration.assetDecimals : configuration.shareDecimals,
      ),
    });
    if (epoch === generation.current && token === backendSessionToken()) setQuote(result);
  }
  async function create(action: 'deposit' | 'redeem') {
    const token = backendSessionToken();
    if (!configuration || !token || !session.profile)
      throw new Error('Sign in with this wallet first.');
    if (
      session.profile.wallet.chainId !== `eip155:${configuration.chainId}` ||
      session.profile.wallet.address.toLowerCase() !== wallet.address.toLowerCase()
    )
      throw new Error('Select the configured execution network and wallet.');
    if (!pending && (!quote || quote.action !== action))
      throw new Error('Refresh the quote first.');
    const p = pending ?? {
      key: Crypto.randomUUID(),
      intent: morphoIntentFromQuote(quote as MorphoQuote, configuration, wallet.address, {
        slippageBps: 10,
        acknowledgeUnprotectedOutput: action === 'redeem' && acknowledged,
        maximumNetworkFeeRaw: morphoRawAmount(fee, 18),
      }),
      configuration,
      accountId: wallet.id,
      signer: wallet.address,
    };
    if (p.accountId !== wallet.id)
      throw new Error('Switch back to the wallet that created this operation.');
    setPending(p); // Keep this idempotency key after an ambiguous create response.
    const result = await api.createMorphoOperation(token, p.key, p.intent);
    setOperation(result);
  }
  async function loadReview() {
    const token = backendSessionToken();
    if (!token || !pending || !operation?.preparation || !current())
      throw new Error('Sign in with the original wallet.');
    const epoch = generation.current;
    const signing = await api.morphoSigningRequest(token, operation.operation.id);
    const context: MorphoReviewContext = {
      configuration: pending.configuration,
      intent: pending.intent,
      signer: pending.signer,
      operationId: operation.operation.id,
      operationVersion: operation.operation.version,
      planHash: operation.preparation.hash,
    };
    validateMorphoReview(signing, context);
    if (generation.current === epoch && backendSessionToken() === token)
      setReview({ signing, context });
  }
  async function sign() {
    if (!review || !pending || !current()) throw new Error('Review the transaction again.');
    const epoch = generation.current;
    const r = review;
    setReview(null); // A timeout never leaves an automatic resend action enabled.
    const result = await signReviewedMorpho(
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
    const recovered = await api.morphoIntent(token, saved.operation.id);
    if (
      generation.current !== epoch ||
      backendSessionToken() !== token ||
      recovered.signer !== wallet.address.toLowerCase() ||
      recovered.chainId !== configuration.chainId ||
      recovered.asset !== configuration.asset ||
      recovered.intent.vault !== configuration.vault ||
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
  if (!configuration) return null;
  const status = operation?.operation.state;
  const terminal = status === 'succeeded' || status === 'failed';
  return (
    <View style={{ gap: 12 }}>
      {operation ? null : <OperationHistory onResume={resume} resumeProvider="morpho_vault_v2" />}
      <View style={styles.card}>
        <Text style={styles.title}>Morpho · local test network</Text>
        <Text style={styles.note}>
          Chain {configuration.chainId}. This flow uses test funds. Production deposits are not
          enabled.
        </Text>
        <Text selectable style={styles.address}>
          Vault {configuration.vault}
          {'\n'}Asset {configuration.asset}
        </Text>
        {!session.profile ? (
          <PillButton label="Sign in to continue" onPress={() => router.push('/wallet-sign-in')} />
        ) : null}
        {!pending ? (
          <>
            <Text style={styles.note}>
              Token amount for deposit, or vault shares for redemption
            </Text>
            <TextInput
              accessibilityLabel="Morpho token amount or shares"
              style={styles.input}
              value={amount}
              onChangeText={(value) => {
                setAmount(value);
                setQuote(null);
              }}
              keyboardType="decimal-pad"
              editable={!busy}
            />
            <Text style={styles.note}>Maximum total network fee (ETH)</Text>
            <TextInput
              accessibilityLabel="Maximum Morpho network fee in ETH"
              style={styles.input}
              value={fee}
              onChangeText={setFee}
              keyboardType="decimal-pad"
              editable={!busy}
            />
            <PillButton
              label="Quote deposit"
              disabled={busy || !session.profile}
              onPress={() => void run(() => loadQuote('deposit'))}
            />
            <PillButton
              label="Quote share redemption"
              variant="secondary"
              disabled={busy || !session.profile}
              onPress={() => void run(() => loadQuote('redeem'))}
            />
            {quote ? (
              <>
                <Text style={styles.note}>
                  Estimated output:{' '}
                  {quote.action === 'deposit'
                    ? `${morphoDisplayAmount(quote.previewSharesRaw, configuration.shareDecimals)} shares`
                    : `${morphoDisplayAmount(quote.previewAssetsRaw, configuration.assetDecimals)} tokens`}
                  . Quotes expire after 30 seconds.
                </Text>
                {quote.action === 'deposit' ? (
                  <Text style={styles.note}>Minimum shares are set 0.1% below this estimate.</Text>
                ) : (
                  <>
                    <Text style={styles.note}>
                      Redemption spends the exact shares entered. The contract has no minimum payout
                      protection; the token amount may change before execution.
                    </Text>
                    <PillButton
                      label={
                        acknowledged ? 'Payout risk acknowledged' : 'Acknowledge variable payout'
                      }
                      variant="secondary"
                      disabled={busy}
                      onPress={() => setAcknowledged((v) => !v)}
                    />
                  </>
                )}
                <PillButton
                  label="Prepare quoted transaction"
                  disabled={busy || (quote.action === 'redeem' && !acknowledged)}
                  onPress={() => void run(() => create(quote.action))}
                />
              </>
            ) : null}
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
              {pending?.intent.action === 'deposit' ? 'Review deposit' : 'Review withdrawal'}
            </Text>
            <Text style={styles.note}>
              Amount:{' '}
              {pending
                ? morphoDisplayAmount(
                    pending.intent.amountRaw,
                    pending.intent.action === 'deposit'
                      ? configuration.assetDecimals
                      : configuration.shareDecimals,
                  )
                : ''}{' '}
              {pending?.intent.action === 'deposit' ? 'tokens' : 'shares'}
            </Text>
            <Text selectable style={styles.address}>
              Recipient {review.signing.prepared.plan.signer}
            </Text>
            <Text style={styles.note}>
              Maximum total gas fee:{' '}
              {morphoDisplayAmount(review.signing.prepared.plan.maximumNetworkFeeRaw, 18)} ETH. App
              referral fee: 0. {review.signing.prepared.plan.steps.length} transactions.
            </Text>
            <Text style={styles.note}>
              {pending?.intent.minimumSharesRaw
                ? `Minimum shares: ${morphoDisplayAmount(pending.intent.minimumSharesRaw, configuration.shareDecimals)}`
                : 'No minimum token payout. You acknowledged variable redemption output.'}
            </Text>
            <Text style={styles.note}>
              Vault performance fee:{' '}
              {morphoDisplayAmount((BigInt(configuration.performanceFeeWad) * 100n).toString(), 18)}
              %. Management fee annualized at 365 days:{' '}
              {morphoDisplayAmount(
                (BigInt(configuration.managementFeePerSecondWad) * 31536000n * 100n).toString(),
                18,
              )}
              %. These vault fees affect share value.
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
              setQuote(null);
              setAcknowledged(false);
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
            detail="Morpho execution completed. These are local test transactions."
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
              setQuote(null);
              setAcknowledged(false);
              setPending(null);
              setOperation(null);
              setReview(null);
            }}
            share={`Local Morpho test operation ${operation.operation.id}`}
          />
        ) : null}
        {operation ? (
          <PillButton
            label="View all requests"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              generation.current++;
              setQuote(null);
              setAcknowledged(false);
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
