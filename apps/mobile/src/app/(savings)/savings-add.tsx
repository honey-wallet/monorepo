import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { SkeletonBar, useFirstLoad } from '@/components/motion/Skeleton';
import { TextSwap } from '@/components/motion/TextSwap';
import { PillButton } from '@/components/onboarding/PillButton';
import { DemoMoneyNotice } from '@/components/savings/DemoMoneyNotice';
import { LiveEarnSheet } from '@/components/savings/LiveEarnMarkets';
import { FailurePage } from '@/components/sheets/FailurePage';
import { closeSheet, SHEET, SheetRow, SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { finishDemo, SuccessPage } from '@/components/sheets/SuccessPage';
import { FlowTray, InlineTray } from '@/components/sheets/Tray';
import { applyKey, Keypad, TypedAmount } from '@/components/wallet/Keypad';
import { TokenIcon } from '@/components/wallet/parts';
import { demoLabel } from '@/lib/demo-money-copy';
import { success, tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { formatUsd, VAULTS } from '@/lib/mock-wallet';
import { followFix, useFailure } from '@/lib/outcomes';
import { isWeb } from '@/lib/platform';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, radius, useTheme } from '@/theme';

/** Years ahead the projection looks, matching the Savings chart. */
const AHEAD = 10;

/** Placeholder ways to pay and their fees. TODO: a real on-ramp provider. */
const METHODS = {
  wallet: { label: 'USDC in your wallet', icon: 'wallet', fee: 0 },
  card: { label: 'Debit card •••• 4242', icon: 'card', fee: 0.0249 },
  bank: { label: 'Bank account •••• 6789', icon: 'bank', fee: 0.005 },
} as const;
type Method = keyof typeof METHODS;

const PAGES = ['amount', 'review', 'done', 'failed'] as const;
type Page = (typeof PAGES)[number];

/**
 * Adding money to Savings: type an amount and see what it could grow to, choose how
 * to pay, then the success burst.
 */
export default function SavingsAddSheet() {
  // Savings is phone-only for launch: a deep link lands back where it can go.
  if (isWeb) return <Redirect href="/home" />;
  return <SavingsAddSheetContent />;
}

function SavingsAddSheetContent() {
  const { wallet } = useWalletView();
  return wallet.demo ? <DemoSavingsAddSheet /> : <LiveEarnSheet />;
}

function DemoSavingsAddSheet() {
  const params = useLocalSearchParams<{ rate?: string }>();
  const styles = useStyles();
  const c = useTheme();
  // The blended rate the Savings chart projects with, so the numbers match it.
  const rate = Number(params.rate) || VAULTS.USDC.apy / 100;
  const apy = `${(rate * 100).toFixed(2)}% APY`;
  // USDC in the wallet in use; a new wallet has none until its first deposit.
  const inWallet = useWalletView()
    .tokens.filter((t) => t.symbol === 'USDC')
    .reduce((s, t) => s + t.usd, 0);
  // Without a rate from Savings, it comes from the rates feed.
  const rateLoading = useFirstLoad(LOADS.earnRates) && !params.rate;
  const [typed, setTyped] = useState('');
  const [page, setPage] = useState<Page>('amount');
  const outcome = useFailure('savings');
  const [method, setMethod] = useState<Method>('card');

  const amount = Number(typed) || 0;
  const walletEnough = inWallet >= amount;
  const fee = amount * METHODS[method].fee;
  const grown = amount * (1 + rate) ** AHEAD;
  const dollars = formatUsd(amount).replace(/\.00$/, '');
  const finish = () => finishDemo('nothing was added');

  const go = (next: Page) => {
    tap();
    // Pay from the wallet when it covers the amount; otherwise the card.
    if (next === 'review') setMethod(walletEnough ? 'wallet' : 'card');
    setPage(next);
  };

  return (
    <FlowTray>
      <SheetScreen title="Add money" size="fill">
        <DemoMoneyNotice />
        <View style={styles.flex}>
          <View style={styles.amountArea}>
            <TypedAmount value={typed} prefix="$" size={56} />
            {rateLoading ? (
              <View style={styles.hintLine}>
                <SkeletonBar width={150} height={12} />
              </View>
            ) : (
              <TextSwap
                text={
                  amount ? `≈ ${formatUsd(grown)} in ${AHEAD} years` : `Earns ${apy}, no lockup`
                }
                style={[styles.hint, amount > 0 && styles.gain]}
              />
            )}
          </View>
          <Keypad onKey={(key) => setTyped((v) => applyKey(v, key, 2))} />
          <PillButton
            label={amount ? 'Continue' : 'Enter an amount'}
            disabled={!amount}
            onPress={() => go('review')}
            style={styles.cta}
          />
        </View>
      </SheetScreen>
      {/* Review and result rise in a tray over the amount (Family's pattern). */}
      <InlineTray onClose={() => (page === 'done' ? finish() : go('amount'))}>
        {page === 'amount' ? null : (
          <>
            <DemoMoneyNotice deposit />
            <ContentSwap id={page} index={PAGES.indexOf(page)}>
              {page === 'failed' && outcome.failure ? (
                <SheetScreen>
                  <FailurePage
                    compact
                    failure={outcome.failure}
                    rows={[{ label: 'Adding', value: dollars }]}
                    onRetry={() => {
                      tap();
                      if (outcome.failure && followFix(outcome.failure)) return;
                      setPage('review');
                    }}
                    onClose={() => {
                      tap();
                      closeSheet();
                    }}
                  />
                </SheetScreen>
              ) : page === 'done' ? (
                <SheetScreen>
                  <SuccessPage
                    compact
                    title={demoLabel('Demo addition simulation', 'Added to savings')}
                    amount={{ symbol: 'USDC', text: `${amount.toLocaleString('en-US')} USDC` }}
                    detail={demoLabel(
                      'No funds were added and your wallet balance was not changed.',
                      undefined,
                    )}
                    rows={[
                      { label: 'Earning', value: apy },
                      { label: 'Paid with', value: METHODS[method].label },
                      { label: 'Withdraw', value: 'Any time' },
                    ]}
                    onDone={finish}
                  />
                </SheetScreen>
              ) : (
                <SheetScreen title="Add to savings" onBack={() => go('amount')}>
                  <View style={styles.flex}>
                    <View style={styles.hero}>
                      <Text style={styles.amount}>{dollars}</Text>
                      <Text style={[styles.hint, styles.gain]}>
                        ≈ {formatUsd(grown)} in {AHEAD} years
                      </Text>
                    </View>

                    <Text style={styles.label}>Pay with</Text>
                    <View style={styles.methods}>
                      {(Object.keys(METHODS) as Method[]).map((m) => {
                        const short = m === 'wallet' && !walletEnough;
                        return (
                          <SheetRow
                            key={m}
                            leading={
                              m === 'wallet' ? (
                                <TokenIcon symbol="USDC" size={34} />
                              ) : (
                                <View style={styles.well}>
                                  <Icon name={METHODS[m].icon} size={17} color={c.text} />
                                </View>
                              )
                            }
                            title={METHODS[m].label}
                            subtitle={
                              m === 'wallet'
                                ? !inWallet
                                  ? 'No USDC in your wallet yet'
                                  : short
                                    ? `Only ${formatUsd(inWallet)} available`
                                    : `${formatUsd(inWallet)} available`
                                : `${(METHODS[m].fee * 100).toFixed(2)}% fee`
                            }
                            accessory="check"
                            selected={method === m}
                            onPress={
                              short
                                ? undefined
                                : () => {
                                    tap();
                                    setMethod(m);
                                  }
                            }
                          />
                        );
                      })}
                    </View>

                    <View style={styles.stats}>
                      <StatRow label="Earns" value={apy} />
                      <StatRow label="Fee" value={fee ? formatUsd(fee) : 'Free'} />
                      <StatRow label="Withdraw" value="Any time, no lockup" />
                    </View>

                    <PillButton
                      label={`Add ${dollars}`}
                      onPress={() => {
                        if (outcome.attempt()) {
                          setPage('failed');
                          return;
                        }
                        success();
                        setPage('done');
                      }}
                      style={styles.cta}
                    />
                  </View>
                </SheetScreen>
              )}
            </ContentSwap>
          </>
        )}
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
  hero: {
    alignItems: 'center',
    paddingTop: 4,
    paddingBottom: 22,
  },
  amount: {
    color: c.text,
    fontSize: 44,
    fontWeight: '600',
    letterSpacing: -0.8,
    fontVariant: ['tabular-nums'],
  },
  // The hint's line height, with a bar in it while the rate loads.
  hintLine: {
    height: 20,
    justifyContent: 'center',
  },
  hint: {
    marginTop: 4,
    color: c.textSecondary,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  gain: {
    color: c.success,
  },
  label: {
    marginBottom: 8,
    marginLeft: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  methods: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    ...radius(20),
    backgroundColor: c.card,
  },
  well: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  stats: {
    marginTop: 16,
    paddingHorizontal: 2,
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
}));
