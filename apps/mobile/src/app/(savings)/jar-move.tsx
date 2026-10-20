import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { FailurePage } from '@/components/sheets/FailurePage';
import { closeSheet, SHEET, SheetScreen } from '@/components/sheets/Sheet';
import { finishDemo, SuccessPage } from '@/components/sheets/SuccessPage';
import { FlowTray, InlineTray } from '@/components/sheets/Tray';
import { applyKey, Keypad, PercentChips, TypedAmount } from '@/components/wallet/Keypad';
import { LiveProposedPage } from '@/components/wallet/MultisigParts';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { success, tap } from '@/lib/haptics';
import { moveJar, usdValue, useJars } from '@/lib/jars';
import { formatUsd } from '@/lib/mock-wallet';
import { type ProposalAction, propose, useSigner } from '@/lib/multisig';
import { followFix, useFailure } from '@/lib/outcomes';
import { isWeb } from '@/lib/platform';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles } from '@/theme';

/**
 * Add funds to a Honey Jar, or take some out. From a shared wallet it's proposed
 * like any other payment.
 */
export default function JarMoveSheet() {
  // Savings is phone-only for launch: a deep link lands back where it can go.
  if (isWeb) return <Redirect href="/home" />;
  return <JarMoveSheetContent />;
}

function JarMoveSheetContent() {
  const { id = '', mode = 'add' } = useLocalSearchParams<{
    id: string;
    mode?: 'add' | 'withdraw';
  }>();
  const styles = useStyles();
  const jar = useJars().find((j) => j.id === id);
  const signer = useSigner();
  const [amount, setAmount] = useState('');
  const outcome = useFailure('jar');
  const [done, setDone] = useState(false);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const view = useWalletView();
  if (!jar) {
    return (
      <SheetScreen size="fill">
        <EmptyState icon="search" title="Jar not found" hint="It may have been deleted." />
      </SheetScreen>
    );
  }

  const adding = mode === 'add';
  const wallet = signer.multisig
    ? signer.multisig.holdings
        .filter((h) => h.symbol === jar.symbol)
        .reduce((sum, h) => sum + h.amount, 0)
    : (view.tokens.find((t) => t.symbol === jar.symbol)?.amount ?? 0);
  // Adding draws on the wallet; withdrawing, on what's in the jar.
  const available = adding ? wallet : jar.saved;
  const value = Number(amount) || 0;
  const tooMuch = value > available + 1e-9;
  const action: ProposalAction = {
    type: adding ? 'jarAdd' : 'jarWithdraw',
    jarId: jar.id,
    jar: jar.name,
    symbol: jar.symbol,
    amount: value,
    usd: usdValue(jar.symbol, value),
  };
  const verb = adding ? 'Add' : 'Withdraw';

  const confirm = () => {
    if (outcome.attempt()) return;
    success();
    const { proposal, executed } = signer.multisig
      ? propose(signer.walletId, action)
      : { proposal: null, executed: true };
    if (executed && !signer.multisig) moveJar(jar.id, adding ? value : -value);
    else if (!executed && proposal) setProposalId(proposal.id);
    setDone(true);
  };
  const finish = () => finishDemo(adding ? 'nothing was added' : 'nothing was withdrawn');

  return (
    <FlowTray>
      <SheetScreen title={`${verb} ${adding ? 'to' : 'from'} ${jar.name}`} size="fill">
        {available <= 0 ? (
          // Nothing to move: adding needs the token first; an empty jar has nothing to take.
          <EmptyState
            icon={adding ? 'wallet' : 'target'}
            title={adding ? `No ${jar.symbol} in your wallet` : 'This jar is empty'}
            hint={
              adding
                ? signer.multisig
                  ? `Send ${jar.symbol} to this shared wallet first.`
                  : `Buy or receive ${jar.symbol}, then add it to ${jar.name}.`
                : `Add ${jar.symbol} to ${jar.name} to start saving.`
            }
            action={
              !adding
                ? { label: `Add to ${jar.name}`, onPress: () => router.setParams({ mode: 'add' }) }
                : signer.multisig
                  ? { label: 'Receive', onPress: () => router.replace('/receive') }
                  : {
                      label: `Buy ${jar.symbol}`,
                      onPress: () =>
                        router.replace({ pathname: '/buy-cash', params: { symbol: jar.symbol } }),
                    }
            }
          />
        ) : (
          <View style={styles.flex}>
            <View style={styles.amountArea}>
              <TokenIcon symbol={jar.symbol} size={36} />
              <TypedAmount value={amount} size={52} />
              <Text style={[styles.hint, tooMuch && styles.error]}>
                {value
                  ? `≈ ${formatUsd(usdValue(jar.symbol, value))}`
                  : `${adding ? 'Wallet' : 'In jar'}: ${available} ${jar.symbol}`}
              </Text>
            </View>
            {available > 0 ? (
              <PercentChips balance={available} onPick={setAmount} style={styles.chips} />
            ) : null}
            <Keypad onKey={(key) => setAmount((v) => applyKey(v, key, 6))} />
            {signer.rule(action) ? <Text style={styles.rule}>{signer.rule(action)}</Text> : null}
            <PillButton
              label={
                !value
                  ? 'Enter an amount'
                  : tooMuch
                    ? `Not enough ${jar.symbol}`
                    : signer.cta(`${verb} ${amount} ${jar.symbol}`, action)
              }
              disabled={!value || tooMuch}
              onPress={confirm}
              style={styles.cta}
            />
          </View>
        )}
      </SheetScreen>
      {/* The result rises in a tray over the order (Family's pattern). */}
      <InlineTray onClose={() => (outcome.failure ? outcome.clear() : finish())}>
        {outcome.failure ? (
          <SheetScreen>
            <FailurePage
              compact
              failure={outcome.failure}
              rows={[{ label: adding ? 'Adding' : 'Withdrawing', value: formatUsd(value) }]}
              onRetry={() => {
                tap();
                if (outcome.failure && followFix(outcome.failure)) return;
                outcome.clear();
              }}
              onClose={() => {
                tap();
                closeSheet();
              }}
            />
          </SheetScreen>
        ) : done && proposalId ? (
          <SheetScreen>
            <LiveProposedPage proposalId={proposalId} onDone={finish} compact />
          </SheetScreen>
        ) : done ? (
          <SheetScreen>
            <SuccessPage
              compact
              title={adding ? 'Added' : 'Withdrawn'}
              amount={{
                symbol: jar.symbol,
                text: `${amount} ${jar.symbol}`,
                usd: formatUsd(usdValue(jar.symbol, value)),
              }}
              detail={`${adding ? 'To' : 'From'} ${jar.name}`}
              onDone={finish}
            />
          </SheetScreen>
        ) : null}
      </InlineTray>
    </FlowTray>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  amountArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  hint: {
    color: c.textSecondary,
    fontSize: 15,
  },
  error: {
    color: c.error,
  },
  chips: {
    marginBottom: 8,
  },
  rule: {
    marginTop: 8,
    color: c.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
}));
