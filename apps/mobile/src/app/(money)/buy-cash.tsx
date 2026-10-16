import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { IconSwap } from '@/components/motion/IconSwap';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, useFirstLoad } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { FailurePage } from '@/components/sheets/FailurePage';
import { closeSheet, SHEET, SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { finishDemo, SuccessPage } from '@/components/sheets/SuccessPage';
import { applyKey, Keypad, TypedAmount } from '@/components/wallet/Keypad';
import { LiveProposedPage } from '@/components/wallet/MultisigParts';
import { EmptyState, TokenIcon } from '@/components/wallet/parts';
import { success, tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { formatBalance, formatPrice, formatUsd, MARKET, marketOf } from '@/lib/mock-wallet';
import { type ProposalAction, propose, useSigner } from '@/lib/multisig';
import { markFunded, useOnboarding } from '@/lib/onboarding';
import { followFix, useFailure } from '@/lib/outcomes';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, useTheme } from '@/theme';

type Page = 'amount' | 'review' | 'done' | 'failed';
const PAGES: Page[] = ['amount', 'review', 'done', 'failed'];
type Method = 'card' | 'bank';

/** Placeholder payment methods and provider fees. TODO: a real on/off-ramp provider. */
const METHODS: Record<Method, { label: string; icon: 'card' | 'bank'; fee: number }> = {
  card: { label: 'Debit card •••• 4242', icon: 'card', fee: 0.0249 },
  bank: { label: 'Bank account •••• 6789', icon: 'bank', fee: 0.005 },
};
const QUICK = [50, 100, 250];

/** Buy crypto with cash, or sell it for cash: amount, then a review. Demo only. */
export default function BuyCashSheet() {
  const {
    symbol: initial,
    mode,
    amount: preset,
  } = useLocalSearchParams<{ symbol?: string; mode?: string; amount?: string }>();
  const selling = mode === 'sell';
  const styles = useStyles();
  const c = useTheme();

  // Buy anything on the market; sell only what you hold (a shared wallet, its own).
  const signer = useSigner();
  // What the wallet in use holds; a new wallet holds nothing until its first deposit.
  const view = useWalletView();
  const owned = signer.multisig
    ? signer.multisig.holdings.map((h) => ({ symbol: h.symbol, amount: h.amount }))
    : view.tokens.filter((t) => !t.hidden);
  // The rate comes from the market feed.
  const loading = useFirstLoad(LOADS.market);
  const symbols = selling ? owned.map((t) => t.symbol) : MARKET.map((t) => t.symbol);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [symbol, setSymbol] = useState(
    initial && symbols.includes(initial) ? initial : selling ? symbols[0] : 'ETH',
  );
  // A preset amount (Home's $25 / $50 / $100) goes straight to the review.
  const [amount, setAmount] = useState(preset ?? '');
  const [method, setMethod] = useState<Method>('card');
  const [picking, setPicking] = useState(false);
  const [page, setPage] = useState<Page>(preset ? 'review' : 'amount');
  const [area, setArea] = useState(0);

  const price = marketOf(symbol)?.price ?? 1;
  const held = owned.find((t) => t.symbol === symbol);
  const value = Number(amount) || 0;
  const onboarding = useOnboarding();
  const tokenValue = value / price;
  const fee = value * METHODS[method].fee;
  // Value holdings at the same price as the quote, so Max always fits.
  const heldUsd = (held?.amount ?? 0) * price;
  const insufficient = selling && value > heldUsd + 1e-9;
  const ready = value > 0 && !insufficient;
  const label = !value ? 'Enter an amount' : insufficient ? 'Insufficient balance' : 'Continue';
  const verb = selling ? 'Sell' : 'Buy';

  const go = (next: Page) => {
    tap();
    setPage(next);
  };

  const pick = (next: string) => {
    tap();
    setSymbol(next);
    setPicking(false);
  };

  // Selling from a shared wallet is proposed; buying into one needs no approval.
  const sellAction: ProposalAction = { type: 'sell', symbol, amount: tokenValue, usd: value };
  const outcome = useFailure(selling ? 'sell' : 'buy');
  const confirm = () => {
    if (outcome.attempt()) {
      setPage('failed');
      return;
    }
    success();
    if (selling && signer.multisig) {
      const { proposal, executed } = propose(signer.walletId, sellAction);
      if (!executed) setProposalId(proposal.id);
    }
    setPage('done');
  };
  const finish = () => {
    // A new wallet's first purchase is its first deposit: the balance appears.
    if (!selling && !onboarding.funded) {
      tap();
      closeSheet();
      markFunded(value);
      return;
    }
    finishDemo(selling ? 'nothing was sold' : 'nothing was bought');
  };

  const quick = selling
    ? [...QUICK.map((q) => ({ label: `$${q}`, value: String(q) })), maxChip(heldUsd)]
    : QUICK.map((q) => ({ label: `$${q}`, value: String(q) }));

  // Nothing held means nothing to sell: offer buying instead of an empty token list.
  if (selling && symbols.length === 0) {
    return (
      <SheetScreen title="Sell" size="fill">
        <EmptyState
          icon="sell"
          title="Nothing to sell yet"
          hint={
            signer.multisig
              ? `This shared wallet doesn't hold any tokens on ${signer.multisig.network.name} yet.`
              : 'Tokens you buy or receive can be sold for cash here.'
          }
          action={{ label: 'Buy crypto', onPress: () => router.replace('/buy-cash') }}
        />
      </SheetScreen>
    );
  }

  return (
    // Each page keeps its own button so it slides in with that page's content.
    <SheetScreen
      title={page === 'review' ? `Review ${verb.toLowerCase()}` : verb}
      size="fill"
      onBack={page === 'review' ? () => go('amount') : undefined}
    >
      <View style={styles.flex} onLayout={(e) => setArea(e.nativeEvent.layout.height)}>
        <ContentSwap id={page} index={PAGES.indexOf(page)}>
          <View style={{ height: area }}>
            {page === 'failed' && outcome.failure ? (
              <FailurePage
                failure={outcome.failure}
                rows={[
                  {
                    label: selling ? 'Selling' : 'Buying',
                    value: `${formatUsd(value)} of ${symbol}`,
                  },
                  { label: selling ? 'To' : 'With', value: METHODS[method].label },
                ]}
                onRetry={() => {
                  tap();
                  if (outcome.failure && followFix(outcome.failure)) return;
                  // Over the limit: change the amount; anything else: back to the review,
                  // where the payment method can change too.
                  setPage(outcome.failure?.kind === 'limit' ? 'amount' : 'review');
                }}
                onClose={() => {
                  tap();
                  closeSheet();
                }}
              />
            ) : page === 'done' && proposalId ? (
              <LiveProposedPage proposalId={proposalId} onDone={finish} />
            ) : page === 'done' ? (
              <SuccessPage
                title={selling ? 'Sold' : 'Bought'}
                amount={{
                  symbol,
                  text: `${formatBalance(selling ? tokenValue : (value - fee) / price)} ${symbol}`,
                }}
                rows={[
                  {
                    label: selling ? 'You get' : 'You paid',
                    value: formatUsd(selling ? value - fee : value),
                  },
                  { label: 'Fee', value: formatUsd(fee) },
                  { label: selling ? 'To' : 'With', value: METHODS[method].label },
                ]}
                onDone={finish}
              />
            ) : page === 'amount' ? (
              <>
                <View style={styles.tokenBar}>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`Token: ${symbol}. Change token`}
                    accessibilityState={{ expanded: picking }}
                    onPress={() => {
                      tap();
                      setPicking((v) => !v);
                    }}
                    style={styles.pill}
                  >
                    <TokenIcon symbol={symbol} size={26} />
                    <Text style={styles.pillLabel}>{symbol}</Text>
                    <AccordionChevron open={picking} size={12} color={c.textSecondary} />
                  </PressableScale>
                </View>
                <Accordion open={picking}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.chooser}
                  >
                    {symbols.map((s) => (
                      <PressableScale
                        key={s}
                        accessibilityRole="button"
                        accessibilityState={{ selected: s === symbol }}
                        onPress={() => pick(s)}
                        style={[styles.choice, s === symbol && styles.choiceActive]}
                      >
                        <TokenIcon symbol={s} size={22} />
                        <Text style={styles.choiceLabel}>{s}</Text>
                      </PressableScale>
                    ))}
                  </ScrollView>
                </Accordion>

                <View style={styles.amountArea}>
                  <TypedAmount value={amount} prefix="$" size={amount.length > 8 ? 44 : 60} />
                  {loading ? (
                    <View style={styles.convertLine}>
                      <SkeletonBar width={120} height={14} />
                    </View>
                  ) : (
                    <TextSwap
                      text={`≈ ${formatBalance(tokenValue)} ${symbol}`}
                      style={styles.convert}
                    />
                  )}
                  {selling && held && loading ? (
                    <SkeletonBar width={170} height={12} />
                  ) : selling && held ? (
                    <Text style={styles.held}>
                      You have {formatBalance(held.amount)} {symbol} ({formatUsd(heldUsd)})
                    </Text>
                  ) : null}
                </View>

                <View style={styles.quick}>
                  {quick.map((q) => (
                    <PressableScale
                      key={q.label}
                      accessibilityRole="button"
                      onPress={() => {
                        tap();
                        setAmount(q.value);
                      }}
                      style={[styles.chip, amount === q.value && styles.chipActive]}
                    >
                      <Text style={styles.chipLabel}>{q.label}</Text>
                    </PressableScale>
                  ))}
                </View>

                <PressableRow
                  accessibilityRole="button"
                  accessibilityLabel={`${selling ? 'Receive to' : 'Pay with'} ${METHODS[method].label}. Change`}
                  onPress={() => {
                    tap();
                    setMethod((m) => (m === 'card' ? 'bank' : 'card'));
                  }}
                  style={styles.method}
                >
                  <View style={styles.methodIcon}>
                    <IconSwap name={METHODS[method].icon} size={18} color={c.accentText} />
                  </View>
                  <View style={styles.flex}>
                    <Text style={styles.methodHint}>{selling ? 'Receive to' : 'Pay with'}</Text>
                    <TextSwap text={METHODS[method].label} style={styles.methodLabel} />
                  </View>
                  <Icon name="chevronRight" size={14} color={c.textSecondary} />
                </PressableRow>

                <Keypad onKey={(key) => setAmount((a) => applyKey(a, key, 2))} />
                <PillButton
                  label={label}
                  disabled={!ready}
                  onPress={() => go('review')}
                  style={styles.cta}
                />
              </>
            ) : (
              <>
                <View style={styles.summary}>
                  <TokenIcon symbol={symbol} size={48} />
                  <Text style={styles.summaryLabel}>
                    {selling ? `You're selling` : `You're buying`}
                  </Text>
                  <Text style={styles.summaryAmount} adjustsFontSizeToFit numberOfLines={1}>
                    {formatBalance(selling ? tokenValue : (value - fee) / price)} {symbol}
                  </Text>
                </View>
                <View style={styles.rule} />
                <View style={styles.rows}>
                  <StatRow label="Rate" value={`1 ${symbol} = ${formatPrice(price)}`} />
                  <StatRow
                    label={selling ? 'Receive to' : 'Pay with'}
                    value={
                      <View style={styles.inline}>
                        <Icon name={METHODS[method].icon} size={15} color={c.textSecondary} />
                        <Text style={styles.rowValue}>{METHODS[method].label}</Text>
                      </View>
                    }
                  />
                  <StatRow
                    label={`Provider fee (${(METHODS[method].fee * 100).toFixed(2)}%)`}
                    value={formatUsd(fee)}
                  />
                  <StatRow label="Network cost" value="<$0.01" />
                  {selling && signer.rule(sellAction) ? (
                    <StatRow label="Shared wallet" value={signer.rule(sellAction)} />
                  ) : null}
                  <StatRow
                    label={selling ? 'You receive' : 'Total'}
                    value={
                      <Text style={styles.total}>{formatUsd(selling ? value - fee : value)}</Text>
                    }
                  />
                </View>
                <View style={styles.flex} />
                <Text style={styles.note}>
                  Prices move. The final amount is set when your order goes through.
                </Text>
                <PillButton
                  label={selling ? signer.cta('Sell now', sellAction) : 'Buy now'}
                  onPress={confirm}
                  style={styles.cta}
                />
              </>
            )}
          </View>
        </ContentSwap>
      </View>
    </SheetScreen>
  );
}

function maxChip(usd: number) {
  // Round down to the cent so Max never asks for more than you hold.
  const cents = Math.floor(usd * 100) / 100;
  return { label: 'Max', value: String(cents) };
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  tokenBar: {
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingLeft: 6,
    paddingRight: 12,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  pillLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  chooser: {
    gap: 8,
    paddingTop: 10,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingLeft: 6,
    paddingRight: 12,
    borderRadius: 18,
    backgroundColor: c.raised,
  },
  choiceActive: {
    backgroundColor: c.accentSurface,
  },
  choiceLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
  amountArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  convert: {
    color: c.textSecondary,
    fontSize: 16,
  },
  // The conversion line's height, with a bar in it while the rate loads.
  convertLine: {
    height: 20,
    justifyContent: 'center',
  },
  held: {
    color: c.textSecondary,
    fontSize: 13,
  },
  quick: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  chip: {
    minWidth: 72,
    height: 36,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.divider,
  },
  chipActive: {
    borderColor: c.primary,
    backgroundColor: c.accentSurface,
  },
  chipLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
  method: {
    marginTop: 12,
    marginHorizontal: -SHEET.gutter,
    paddingHorizontal: SHEET.gutter,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  methodIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  methodHint: {
    color: c.textSecondary,
    fontSize: 13,
  },
  methodLabel: {
    marginTop: 1,
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
  summary: {
    alignItems: 'center',
    paddingTop: 22,
    paddingBottom: 24,
    gap: 6,
  },
  summaryLabel: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
  },
  summaryAmount: {
    color: c.text,
    fontSize: 40,
    fontWeight: '500',
    letterSpacing: -1,
  },
  rule: {
    height: 1,
    backgroundColor: c.divider,
  },
  rows: {
    paddingTop: 12,
    gap: 4,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowValue: {
    color: c.text,
    fontSize: 16,
  },
  total: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  note: {
    marginBottom: 6,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
}));
