import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, useFirstLoad } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { FailurePage } from '@/components/sheets/FailurePage';
import { closeSheet, SHEET, SheetScreen } from '@/components/sheets/Sheet';
import { finishDemo, SuccessPage } from '@/components/sheets/SuccessPage';
import { FlowTray, InlineTray } from '@/components/sheets/Tray';
import { OrderBar } from '@/components/trade/OrderBar';
import { MarketIcon } from '@/components/trade/PredictFeed';
import type { Side } from '@/components/trade/TradeForm';
import { applyKey, Keypad, TypedAmount, trimNumber } from '@/components/wallet/Keypad';
import { EmptyState } from '@/components/wallet/parts';
import { success, tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { formatUsd } from '@/lib/mock-wallet';
import { leaveSheetTo } from '@/lib/navigation';
import { followFix, useFailure } from '@/lib/outcomes';
import { isWeb } from '@/lib/platform';
import { PREDICT_MARKETS, predictMarket, TRADING_CASH, yesPrice } from '@/lib/predict';
import { useTradeModeAllowed } from '@/lib/trade-modes';
import { formatShare, useTradePrefs } from '@/lib/trade-prefs';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, useTheme } from '@/theme';

/** Quick amounts, added to what's typed, as Polymarket's +$1 / +$5 / +$10 / +$100. */
const QUICK = [1, 5, 10, 100];

/**
 * Buy into a prediction market, after Polymarket's trade sheet: Buy (or Sell) at the
 * top, the market and the answer you're backing, a big dollar amount you type, Yes or
 * No with their prices, quick amounts, and what you'd win. Ends on the success burst.
 */
function PredictOrderSheet() {
  const { predictPrice } = useTradePrefs();
  const styles = useStyles();
  const c = useTheme();
  const params = useLocalSearchParams<{ id?: string; outcome?: string; side?: Side }>();
  // A link to a market that's gone gets a not-found page, not some other market.
  const found = params.id ? predictMarket(params.id) : PREDICT_MARKETS[0];
  const market = found ?? PREDICT_MARKETS[0];
  const outcome =
    market.kind === 'multi'
      ? (market.outcomes.find((o) => o.id === params.outcome) ?? market.outcomes[0])
      : undefined;
  const sides: [Side, Side] = market.kind === 'updown' ? ['Up', 'Down'] : ['Yes', 'No'];
  const [side, setSide] = useState<Side>(
    params.side && sides.includes(params.side) ? params.side : sides[0],
  );
  const [mode, setMode] = useState<'Buy' | 'Sell'>('Buy');
  const [amount, setAmount] = useState('');
  const [bought, setBought] = useState(false);
  const result = useFailure('predict');
  // Prices come from the markets feed; your cash, from the wallet.
  const view = useWalletView();
  const pricesLoading = useFirstLoad(LOADS.predictFeed);
  const cashLoading = useFirstLoad(LOADS.balances(view.wallet.id));

  if (!found) {
    return (
      <SheetScreen size="fill">
        <EmptyState
          icon="search"
          title="Market not found"
          hint="It may have closed or been removed."
          action={{
            label: 'Browse markets',
            onPress: () => {
              leaveSheetTo({ pathname: '/trade', params: { mode: 'Predict' } }, { navigate: true });
            },
          }}
        />
      </SheetScreen>
    );
  }

  // A new wallet has no cash to trade until its first deposit.
  const cash = view.empty ? 0 : TRADING_CASH;
  const value = Number(amount) || 0;
  const yes = yesPrice(market, outcome?.id);
  const price = side === sides[0] ? yes : 1 - yes;
  const shares = value / price;
  const up = side === sides[0];
  const tone = up ? c.success : c.error;
  const tooMuch = value > cash + 1e-9;
  const what = outcome ? outcome.label : market.question;

  return (
    <FlowTray>
      <SheetScreen size="fill">
        <View style={styles.flex}>
          {/* Back, and Buy or Sell as a small pill toggle (review: bring the toggle back). */}
          {/*
          <OrderBar>
            <Text style={styles.orderTitle}>{`Buy ${side}`}</Text>
          </OrderBar>
          */}
          <OrderBar>
            <View style={styles.modes} accessibilityRole="radiogroup">
              {(['Buy', 'Sell'] as const).map((m) => (
                <PressableScale
                  key={m}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: mode === m }}
                  onPress={() => {
                    tap();
                    setMode(m);
                  }}
                  style={[styles.mode, mode === m && styles.modeActive]}
                >
                  <Text style={[styles.modeLabel, mode === m && styles.modeLabelActive]}>{m}</Text>
                </PressableScale>
              ))}
            </View>
          </OrderBar>

          {/* The market and the answer you're backing */}
          <View style={styles.market}>
            <MarketIcon market={market} size={44} />
            <View style={styles.flex}>
              <Text style={styles.marketQuestion} numberOfLines={1}>
                {market.kind === 'updown' ? `${market.question} ${market.window}` : market.question}
              </Text>
              <Text style={styles.marketPick} numberOfLines={1}>
                {outcome ? `${outcome.label} · ` : ''}
                <Text style={{ color: tone }}>{side}</Text>
              </Text>
            </View>
          </View>
          {/* What Buy (or Sell) means here, in one line (review: "why Buy?"). */}
          <Text style={styles.explain}>
            {mode === 'Buy'
              ? isWeb
                ? // Shorter in the popup (review): the line that matters.
                  `${formatShare(price, predictPrice)} a share, pays $1 if ${side} wins.`
                : `You buy ${side} shares at ${formatShare(price, predictPrice)} each. Each pays $1 if ${side} is right; sell any time before it closes.`
              : `You sell ${side} shares you hold at ${formatShare(price, predictPrice)} each, any time before the market closes.`}
          </Text>

          {mode === 'Sell' ? (
            <View style={styles.flex}>
              <EmptyState
                icon="predict"
                title="No shares to sell"
                hint={`Buy ${sides[0]} or ${sides[1]} first; you can sell them here any time before the market closes.`}
                action={{ label: `Buy ${side}`, onPress: () => setMode('Buy') }}
              />
            </View>
          ) : (
            // No cash still shows the form, so you can try it out (review); its
            // button then says Add money.
            /* ) : cash <= 0 ? (
            <View style={styles.flex}>
              <EmptyState
                icon="wallet"
                title="No cash to trade yet"
                hint="Add USDC to your wallet, then come back to back an answer."
                action={{
                  label: 'Add money',
                  onPress: () =>
                    router.replace({ pathname: '/buy-cash', params: { symbol: 'USDC' } }),
                }}
              />
            </View>
            */
            <>
              <View style={styles.amountArea}>
                <TypedAmount value={amount} prefix="$" size={56} />
                {cashLoading && !value ? (
                  <View style={styles.hintLine}>
                    <SkeletonBar width={110} height={12} />
                  </View>
                ) : (
                  <Text
                    style={[
                      styles.hint,
                      value > 0 && !tooMuch && styles.win,
                      tooMuch && styles.error,
                    ]}
                  >
                    {tooMuch
                      ? `You have ${formatUsd(cash)} to trade`
                      : value
                        ? `To win ${formatUsd(shares)}`
                        : `${formatUsd(cash)} available`}
                  </Text>
                )}
              </View>

              {/* Yes or No, each with its price */}
              <View style={styles.sides}>
                {sides.map((s, i) => {
                  const active = s === side;
                  const color = i === 0 ? c.success : c.error;
                  return (
                    <PressableScale
                      key={s}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      onPress={() => {
                        tap();
                        setSide(s);
                      }}
                      style={[styles.side, active && { backgroundColor: `${color}22` }]}
                    >
                      {pricesLoading ? (
                        <View style={styles.sidePrice}>
                          <Text style={[styles.sideLabel, active && { color }]}>{s}</Text>
                          <SkeletonBar width={32} height={12} />
                        </View>
                      ) : (
                        <Text style={[styles.sideLabel, active && { color }]}>
                          {s} {formatShare(i === 0 ? yes : 1 - yes, predictPrice)}
                        </Text>
                      )}
                    </PressableScale>
                  );
                })}
              </View>

              <View style={styles.quick}>
                {QUICK.map((q) => (
                  <PressableScale
                    key={q}
                    accessibilityRole="button"
                    accessibilityLabel={`Add $${q}`}
                    onPress={() => {
                      tap();
                      setAmount((a) => trimNumber((Number(a) || 0) + q, 2));
                    }}
                    style={styles.chip}
                  >
                    <Text style={styles.chipLabel}>+${q}</Text>
                  </PressableScale>
                ))}
              </View>

              <Keypad keyHeight={54} onKey={(key) => setAmount((a) => applyKey(a, key, 2))} />
              {cash <= 0 ? (
                <PillButton
                  label="Add money"
                  onPress={() =>
                    router.replace({ pathname: '/buy-cash', params: { symbol: 'USDC' } })
                  }
                  style={styles.cta}
                />
              ) : (
                <PillButton
                  label={!value ? 'Enter an amount' : tooMuch ? 'Not enough cash' : `Buy ${side}`}
                  disabled={!value || tooMuch}
                  onPress={() => {
                    if (result.attempt()) return;
                    success();
                    setBought(true);
                  }}
                  style={styles.cta}
                />
              )}
            </>
          )}
        </View>
      </SheetScreen>
      {/* The result rises in a tray over the order (Family's pattern). */}
      <InlineTray
        onClose={() =>
          result.failure ? result.clear() : finishDemo(`bought ${side} on “${market.question}”`)
        }
      >
        {result.failure ? (
          <SheetScreen>
            <FailurePage
              compact
              failure={result.failure}
              rows={[
                { label: 'Buying', value: `${side} · ${formatUsd(value)}` },
                { label: 'Market', value: what },
              ]}
              onRetry={() => {
                tap();
                if (result.failure && followFix(result.failure)) return;
                result.clear();
              }}
              onClose={() => {
                tap();
                closeSheet();
              }}
            />
          </SheetScreen>
        ) : bought ? (
          <SheetScreen>
            <SuccessPage
              compact
              title={`Bought ${side}`}
              detail={what}
              rows={[
                { label: 'Shares', value: shares.toFixed(2) },
                { label: 'Avg. price', value: formatShare(price, predictPrice) },
                { label: 'To win', value: formatUsd(shares) },
              ]}
              onDone={() => finishDemo(`bought ${side} on “${market.question}”`)}
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
  explain: {
    marginTop: 10,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 19,
  },
  orderTitle: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  modes: {
    flexDirection: 'row',
    gap: 6,
  },
  mode: {
    height: 34,
    paddingHorizontal: 16,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeActive: {
    backgroundColor: c.raised,
  },
  modeLabel: {
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  modeLabelActive: {
    color: c.text,
  },
  market: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  marketQuestion: {
    color: c.textSecondary,
    fontSize: 14,
  },
  marketPick: {
    marginTop: 2,
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  amountArea: {
    flex: 1,
    // The amount keeps its room in a short window (the 600px popup).
    minHeight: 88,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  hint: {
    color: c.textSecondary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  // The hint's line height, with a bar in it while your cash loads.
  hintLine: {
    height: 20,
    justifyContent: 'center',
  },
  sidePrice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  win: {
    color: c.success,
    fontWeight: '500',
  },
  error: {
    color: c.error,
  },
  sides: {
    flexDirection: 'row',
    gap: 8,
    padding: 4,
    borderRadius: 16,
    backgroundColor: c.card,
  },
  side: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sideLabel: {
    color: c.textSecondary,
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  quick: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 8,
  },
  chip: {
    flex: 1,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  chipLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
}));

/** Shared wallets can't use this product (see `lib/trade-modes.ts`); links land on Trade. */
export default function PredictOrderSheetRoute() {
  return useTradeModeAllowed('Predict') ? <PredictOrderSheet /> : <Redirect href="/trade" />;
}
