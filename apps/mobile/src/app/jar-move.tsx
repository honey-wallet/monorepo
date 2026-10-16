import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { applyKey, Keypad, PercentChips, TypedAmount } from '@/components/wallet/Keypad';
import { LiveProposedPage } from '@/components/wallet/MultisigParts';
import { TokenIcon } from '@/components/wallet/parts';
import { SHEET, SheetScreen } from '@/components/wallet/Sheet';
import { finishDemo, SuccessPage } from '@/components/wallet/SuccessPage';
import { success } from '@/lib/haptics';
import { jars, usdValue, useJars } from '@/lib/jars';
import { formatUsd, TOKENS } from '@/lib/mock-wallet';
import { type ProposalAction, propose, useSigner } from '@/lib/multisig';
import { makeStyles } from '@/theme';

/**
 * Add funds to a Honey Jar, or take some out. From a shared wallet it's proposed
 * like any other payment.
 */
export default function JarMoveSheet() {
  const { id = '', mode = 'add' } = useLocalSearchParams<{
    id: string;
    mode?: 'add' | 'withdraw';
  }>();
  const styles = useStyles();
  const jar = useJars().find((j) => j.id === id);
  const signer = useSigner();
  const [amount, setAmount] = useState('');
  const [done, setDone] = useState(false);
  const [proposalId, setProposalId] = useState<string | null>(null);
  if (!jar) return null;

  const adding = mode === 'add';
  const wallet = signer.multisig
    ? signer.multisig.holdings
        .filter((h) => h.symbol === jar.symbol)
        .reduce((sum, h) => sum + h.amount, 0)
    : (TOKENS.find((t) => t.symbol === jar.symbol)?.amount ?? 0);
  // Adding draws on the wallet; withdrawing, on what's in the jar.
  const available = adding ? wallet : jar.saved;
  const value = Number(amount) || 0;
  const tooMuch = value > available + 1e-9;
  const action: ProposalAction = {
    type: adding ? 'jarAdd' : 'jarWithdraw',
    jar: jar.name,
    symbol: jar.symbol,
    amount: value,
    usd: usdValue(jar.symbol, value),
  };
  const verb = adding ? 'Add' : 'Withdraw';

  const confirm = () => {
    success();
    const { proposal, executed } = signer.multisig
      ? propose(signer.walletId, action)
      : { proposal: null, executed: true };
    if (executed) {
      jars.set((list) =>
        list.map((j) =>
          j.id === jar.id ? { ...j, saved: Math.max(0, j.saved + (adding ? value : -value)) } : j,
        ),
      );
    } else if (proposal) setProposalId(proposal.id);
    setDone(true);
  };
  const finish = () => finishDemo(adding ? 'nothing was added' : 'nothing was withdrawn');

  return (
    <SheetScreen title={`${verb} ${adding ? 'to' : 'from'} ${jar.name}`} size="fill">
      <ContentSwap id={done ? 'done' : 'amount'} index={done ? 1 : 0} fill>
        {done && proposalId ? (
          <LiveProposedPage proposalId={proposalId} onDone={finish} />
        ) : done ? (
          <SuccessPage
            title={adding ? 'Added' : 'Withdrawn'}
            detail={`${amount} ${jar.symbol} ${adding ? 'is now in' : 'came out of'} ${jar.name}.`}
            onDone={finish}
          />
        ) : (
          <View style={styles.flex}>
            <View style={styles.amountArea}>
              <TokenIcon symbol={jar.symbol} size={36} />
              <TypedAmount value={amount} size={52} />
              <TextSwap
                text={
                  value
                    ? `≈ ${formatUsd(usdValue(jar.symbol, value))}`
                    : `${adding ? 'Wallet' : 'In jar'}: ${available} ${jar.symbol}`
                }
                style={[styles.hint, tooMuch && styles.error]}
              />
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
      </ContentSwap>
    </SheetScreen>
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
