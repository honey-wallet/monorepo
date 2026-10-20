import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { PressableScale } from '@/components/motion/PressableScale';
import { SkeletonBar, useFirstLoad } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { SHEET, SheetScreen } from '@/components/sheets/Sheet';
import { FlowTray } from '@/components/sheets/Tray';
import { ExecutionUnavailable } from '@/components/trade/ExecutionUnavailable';
import { LeverageSlider } from '@/components/trade/LeverageSlider';
import { MarketIcon } from '@/components/trade/MarketIcon';
import { OrderBar } from '@/components/trade/OrderBar';
import { applyKey, Keypad, PercentChips, TypedAmount } from '@/components/wallet/Keypad';
import { Change, EmptyState } from '@/components/wallet/parts';
import { demoLabel } from '@/lib/demo-money-copy';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { formatPrice, formatUsd } from '@/lib/mock-wallet';
import { liquidationPrice, type PerpSide, perpMarket } from '@/lib/perps';
import { TRADING_CASH } from '@/lib/predict';
import { useTradeModeAllowed } from '@/lib/trade-modes';
import { PERP_LEVERAGE_STEPS, useTradePrefs } from '@/lib/trade-prefs';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, radius, useTheme } from '@/theme';

/** Trading fee on the position's size (placeholder, Hyperliquid-like taker fee). */
const FEE = 0.00045;
const unavailableAction = () => undefined;

/**
 * Preview a perps order, after FOMO's buy flow and Polymarket's perps sheet: the
 * market up top, Long or Short, a big dollar amount you type (your margin), leverage,
 * quick shares of your cash, and the position it buys with its liquidation price.
 */
function PerpOrderSheet() {
  const styles = useStyles();
  const c = useTheme();
  const params = useLocalSearchParams<{ symbol?: string; side?: string }>();
  const symbol = params.symbol ?? 'BTC';
  const market = perpMarket(symbol);
  const [side, setSide] = useState<PerpSide>(params.side === 'Short' ? 'Short' : 'Long');
  const [amount, setAmount] = useState('');
  // Prices come from the perps feed; your cash, from the wallet.
  const view = useWalletView();
  const pricesLoading = useFirstLoad(LOADS.perpsMarkets);
  const cashLoading = useFirstLoad(LOADS.balances(view.wallet.id));

  const max = market?.maxLeverage ?? 1;
  // Leverage stops: 1x, the usual steps below the market's max, then the max itself.
  const stops = [1, ...PERP_LEVERAGE_STEPS.filter((n) => n < max), max];
  const options = stops.map((n) => `${n}x`);
  // Start on the default leverage from Perps settings, or the market's max if lower.
  const prefs = useTradePrefs();
  const preferred = `${prefs.perpLeverage}x`;
  const [leverage, setLeverage] = useState(
    options.includes(preferred) ? preferred : options[options.length - 1],
  );

  if (!market) {
    return (
      <SheetScreen title={symbol} size="fill">
        <EmptyState
          icon="warning"
          title="Market not found"
          hint={`Honey doesn't offer a ${symbol} perpetual yet.`}
        />
      </SheetScreen>
    );
  }

  // Placeholder balance for the visual preview only; no wallet funds are read here.
  const cash = view.empty ? 0 : TRADING_CASH;
  const value = Number(amount) || 0;
  const multiple = Number(leverage.replace(/\D/g, '')) || 1;
  const size = value * multiple;
  const liquidation = liquidationPrice(market.price, multiple, side);
  const tooMuch = value > cash + 1e-9;

  return (
    <FlowTray>
      <SheetScreen size="fill">
        <View style={styles.flex}>
          {/* Back, and Long or Short as a compact pill; the market under them (review:
              bring the toggle back). */}
          {/*
          <OrderBar>
            <Text style={[styles.orderTitle, { color: side === 'Long' ? c.success : c.error }]}>
              {side}
            </Text>
          </OrderBar>
          */}
          <OrderBar>
            <View style={styles.sides} accessibilityRole="radiogroup">
              {(['Long', 'Short'] as const).map((s) => {
                const active = s === side;
                const color = s === 'Long' ? c.success : c.error;
                return (
                  <PressableScale
                    key={s}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      tap();
                      setSide(s);
                    }}
                    style={[styles.side, active && { backgroundColor: color }]}
                  >
                    <Text style={[styles.sideLabel, active && styles.sideLabelOn]}>{s}</Text>
                  </PressableScale>
                );
              })}
            </View>
          </OrderBar>
          <View style={styles.market}>
            <MarketIcon market={market} size={40} />
            <View style={styles.flex}>
              <Text style={styles.symbol}>{market.symbol}</Text>
              <View style={styles.priceRow}>
                {pricesLoading ? (
                  <SkeletonBar width={110} height={12} />
                ) : (
                  <>
                    <Text style={styles.meta}>{formatPrice(market.price)}</Text>
                    <Change value={market.change} size={14} />
                  </>
                )}
              </View>
            </View>
          </View>

          {/* Your margin and its illustrative position size. */}
          <View style={styles.amountArea}>
            <TypedAmount value={amount} prefix="$" size={64} />
            <Text style={[styles.hint, tooMuch && styles.error]}>
              {tooMuch
                ? demoLabel(
                    `Amount exceeds sample balance ${formatUsd(cash)}`,
                    `You have ${formatUsd(cash)} to trade`,
                  )
                : value
                  ? demoLabel(
                      `${formatUsd(size)} illustrative size · Liq. ${formatPrice(liquidation)}`,
                      `${formatUsd(size)} position · Liq. ${formatPrice(liquidation)}`,
                    )
                  : demoLabel(
                      `${multiple}x ${side.toLowerCase()} preview · ${market.name}`,
                      `${multiple}x ${side.toLowerCase()} on ${market.name}`,
                    )}
            </Text>
          </View>

          <LeverageSlider stops={stops} value={multiple} onChange={(n) => setLeverage(`${n}x`)} />
          <PercentChips balance={cash} decimals={2} onPick={setAmount} style={styles.shares} />
          <Keypad keyHeight={52} onKey={(key) => setAmount((a) => applyKey(a, key, 2))} />
          <View style={styles.footNote}>
            {cashLoading ? (
              <SkeletonBar width={100} height={12} />
            ) : (
              <Text style={styles.meta}>
                {demoLabel(`Sample balance ${formatUsd(cash)}`, `${formatUsd(cash)} available`)}
              </Text>
            )}
            <Text style={styles.meta}>
              {demoLabel(
                `Illustrative fee ${formatUsd(size * FEE)}`,
                `Fee ${formatUsd(size * FEE)}`,
              )}
            </Text>
          </View>
          <ExecutionUnavailable message="Prices and balance figures are indicative previews; account balance and fees are not verified. Hyperliquid order placement is unavailable, so no funds will move or position open." />
          <PillButton
            label={demoLabel(
              'Order placement unavailable',
              `${side} ${market.symbol} · ${multiple}x`,
            )}
            disabled
            onPress={unavailableAction}
            style={styles.cta}
          />
        </View>
      </SheetScreen>
    </FlowTray>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  market: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  symbol: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  priceRow: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  meta: {
    color: c.textSecondary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  sides: {
    flexDirection: 'row',
    padding: 3,
    ...radius(19),
    backgroundColor: c.card,
  },
  orderTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  side: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sideLabel: {
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  sideLabelOn: {
    color: '#FFFFFF',
  },
  amountArea: {
    flex: 1,
    // The amount keeps its room in a short window (the 600px popup).
    minHeight: 96,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  hint: {
    color: c.textSecondary,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  error: {
    color: c.error,
  },
  shares: {
    marginTop: 14,
  },
  footNote: {
    marginTop: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  cta: {
    marginTop: SHEET.footerGap,
  },
}));

/** Shared wallets can't use this product (see `lib/trade-modes.ts`); links land on Trade. */
export default function PerpOrderSheetRoute() {
  return useTradeModeAllowed('Perps') ? <PerpOrderSheet /> : <Redirect href="/trade" />;
}
