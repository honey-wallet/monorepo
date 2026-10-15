import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { useErrorShake } from '@/components/motion/ErrorShake';
import { MatrixLoader } from '@/components/motion/MatrixLoader';
import { PanelReveal } from '@/components/motion/PanelReveal';
import { PressableScale } from '@/components/motion/PressableScale';
import { ShimmerText } from '@/components/motion/ShimmerText';
import { TextSwap } from '@/components/motion/TextSwap';
import { UnderlineTabs } from '@/components/motion/UnderlineTabs';
import { PillButton } from '@/components/onboarding/PillButton';
import { HeaderActions } from '@/components/wallet/HeaderActions';
import { applyKey, Keypad, PercentChips, TypedAmount } from '@/components/wallet/Keypad';
import { PerpsMarkets } from '@/components/wallet/PerpsMarkets';
import { PredictFeed } from '@/components/wallet/PredictFeed';
import { HeaderIconButton, TokenIcon } from '@/components/wallet/parts';
import { SwapReview } from '@/components/wallet/SwapReview';
import { TabScreen } from '@/components/wallet/TabScreen';
import {
  AmountCard,
  FieldLabel,
  MarketPill,
  OptionChips,
  Risk,
  type Side,
  SideToggle,
  Summary,
} from '@/components/wallet/TradeForm';
import { tap } from '@/lib/haptics';
import { formatPrice, formatUsd, holdingAmount, priceOf } from '@/lib/mock-wallet';
import { goBackOr } from '@/lib/navigation';
import { TRADE_MODE_INFO, TRADE_MODES, type TradeMode, useSettings } from '@/lib/settings';
import { type TokenRef, updateSwap, useSwap } from '@/lib/swap';
import { showDemoToast } from '@/lib/toast';
import { EXPIRIES, type Expiry, useTradePrefs } from '@/lib/trade-prefs';
import { makeStyles, useTheme } from '@/theme';

/**
 * Trading, kept simple: Swap (which also bridges across networks), Perps and
 * Predict by default; the + button adds Futures and Options or reorders the tabs. Each product is one short form;
 * nothing executes yet, so final actions confirm with a demo toast.
 */

const TRADE_ICONS = Object.fromEntries(
  TRADE_MODES.map((m) => [m, TRADE_MODE_INFO[m].icon]),
) as Record<TradeMode, IconName>;

export default function TradeScreen() {
  const styles = useStyles();
  const { tradeTabs } = useSettings();
  // `?mode=Perps` opens a specific product, e.g. from a deep link.
  const params = useLocalSearchParams<{ mode?: TradeMode }>();
  const [picked, setPicked] = useState<TradeMode>(params.mode ?? tradeTabs[0]);
  // If the open tab was just hidden, fall back to the first one still shown.
  const mode = tradeTabs.includes(picked) ? picked : tradeTabs[0];
  return (
    // Trade is a focused flow with no tab bar; Back returns to where you came from.
    <TabScreen
      title="Trade"
      tabBar={false}
      leading={
        <HeaderIconButton bare icon="chevronLeft" label="Back" onPress={() => goBackOr('/home')} />
      }
      right={
        <HeaderActions
          settingsLabel={`${mode} settings`}
          onSettings={() =>
            mode === 'Swap'
              ? router.push('/swap-settings')
              : router.push({ pathname: '/trade-settings', params: { mode } })
          }
        />
      }
    >
      {/* The products you've chosen, sharing the row equally; edit them from settings. */}
      <View style={styles.modes}>
        <UnderlineTabs options={tradeTabs} value={mode} onChange={setPicked} icons={TRADE_ICONS} />
      </View>
      <ContentSwap id={mode} index={tradeTabs.indexOf(mode)} fill={mode === 'Swap'}>
        {mode === 'Swap' && <SwapForm />}
        {mode === 'Perps' && <PerpsMarkets />}
        {mode === 'Futures' && <FuturesForm />}
        {mode === 'Options' && <OptionsForm />}
        {mode === 'Predict' && <PredictFeed />}
      </ContentSwap>
    </TabScreen>
  );
}

// ---------------------------------------------------------------------------
// Swap

/** How long a fresh quote takes before the rate shows. */
const QUOTE_MS = 700;

function SwapForm() {
  const styles = useStyles();
  const c = useTheme();
  const pair = useSwap();
  const sell = pair.sell.symbol;
  const buy = pair.buy.symbol;
  // The typed amount belongs to the token being sold; picking another clears it.
  const sellKey = `${sell}-${pair.sell.chain}`;
  const [entry, setEntry] = useState({ key: sellKey, amount: '' });
  const amount = entry.key === sellKey ? entry.amount : '';
  const setAmount = (next: string | ((prev: string) => string)) =>
    setEntry({ key: sellKey, amount: typeof next === 'function' ? next(amount) : next });
  const balance = holdingAmount(sell, pair.sell.chain);
  const bridging = pair.sell.chain !== pair.buy.chain;
  const value = Number(amount) || 0;
  const rate = priceOf(sell) / (priceOf(buy) || 1);
  const out = value * rate;
  const usd = value * priceOf(sell);
  const tooMuch = value > balance;
  const route = bridging ? 'Across + Uniswap' : 'Uniswap';
  const networkCost = bridging ? '$1.20' : '$0.42';
  const [reviewing, setReviewing] = useState(false);

  // Each new amount gets a fresh quote: "Finding best route" for a moment, then the
  // rate. The details panel opens with the first quote and stays while re-quoting.
  const quoteKey = value ? `${value}-${sellKey}-${buy}-${pair.buy.chain}` : '';
  const [quoting, setQuoting] = useState(false);
  const [quoted, setQuoted] = useState(false);
  useEffect(() => {
    if (!quoteKey) {
      setQuoting(false);
      setQuoted(false);
      return;
    }
    setQuoting(true);
    const done = setTimeout(() => {
      setQuoting(false);
      setQuoted(true);
    }, QUOTE_MS);
    return () => clearTimeout(done);
  }, [quoteKey]);

  // Shake the amount once when it first runs past the balance, not on every key.
  const { shake, style: shakeStyle } = useErrorShake();
  const wasTooMuch = useRef(false);
  useEffect(() => {
    if (tooMuch && !wasTooMuch.current) shake();
    wasTooMuch.current = tooMuch;
  }, [tooMuch, shake]);

  const flip = () => {
    tap();
    updateSwap({ sell: pair.buy, buy: pair.sell });
  };

  return (
    <View style={styles.flex}>
      <View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Sell</Text>
          <Animated.View style={[styles.cardRow, shakeStyle]}>
            <View style={styles.flex}>
              <TypedAmount value={amount} size={40} align="left" />
            </View>
            <TokenPill side="sell" token={pair.sell} />
          </Animated.View>
          <View style={styles.cardRow}>
            <TextSwap text={formatUsd(usd)} style={styles.meta} />
            <Text style={[styles.meta, tooMuch && styles.error]}>
              {balance} {sell}
            </Text>
          </View>
        </View>

        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Switch tokens"
          scaleTo={0.97}
          onPress={flip}
          style={styles.flip}
        >
          <Icon name="swapVertical" size={18} color={c.text} />
        </PressableScale>

        <View style={[styles.card, styles.stacked]}>
          <Text style={styles.cardLabel}>Buy</Text>
          <View style={styles.cardRow}>
            <TextSwap
              text={out ? Number(out.toPrecision(6)).toString() : '0'}
              style={[styles.amountOut, !out && styles.placeholder]}
            />
            <TokenPill side="buy" token={pair.buy} />
          </View>
          {quoting ? (
            <View style={styles.quoting}>
              <MatrixLoader dot={3} />
              <ShimmerText text="Finding best route" style={styles.meta} />
            </View>
          ) : (
            <Text style={styles.meta}>
              1 {sell} = {Number(rate.toPrecision(6))} {buy}
              {bridging && ` · Bridges ${pair.sell.chain} → ${pair.buy.chain}`}
            </Text>
          )}
        </View>
      </View>

      <PanelReveal open={quoted} style={styles.details}>
        <DetailRow label="Route" value={route} />
        <DetailRow label="Network cost" value={networkCost} />
        <DetailRow label="Max slippage" value="Auto · 5.5%" />
        <DetailRow label="Price impact" value="<0.01%" />
      </PanelReveal>

      {/* As in Uniswap: cards at the top, keypad and button at the bottom, open space between. */}
      <View style={styles.flex} />
      <PercentChips balance={balance} onPick={setAmount} style={styles.percents} />

      <Keypad keyHeight={60} onKey={(key) => setAmount((v) => applyKey(v, key, 8))} />

      <PillButton
        label={!value ? 'Enter an amount' : tooMuch ? `Not enough ${sell}` : 'Review swap'}
        disabled={!value || tooMuch}
        onPress={() => {
          tap();
          setReviewing(true);
        }}
        style={styles.swapCta}
      />

      <SwapReview
        visible={reviewing}
        pay={{ amount, symbol: sell, chain: pair.sell.chain, usd: formatUsd(usd) }}
        get={{
          amount: Number(out.toPrecision(6)).toString(),
          symbol: buy,
          chain: pair.buy.chain,
          usd: formatUsd(out * priceOf(buy)),
        }}
        route={route}
        networkCost={networkCost}
        bridging={bridging}
        onClose={() => setReviewing(false)}
        onDone={() => {
          setReviewing(false);
          setAmount('');
        }}
      />
    </View>
  );
}

/** One line of the swap's details panel, e.g. Network cost … $0.42. */
function DetailRow({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.detailRow}>
      <Text style={styles.meta}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

/** Token pill on a swap card; opens the token picker for its side. */
function TokenPill({ side, token }: { side: 'sell' | 'buy'; token: TokenRef }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${side === 'sell' ? 'Sell' : 'Buy'} ${token.symbol} on ${token.chain}. Change token`}
      scaleTo={0.97}
      onPress={() => {
        tap();
        router.push({ pathname: '/token-picker', params: { side } });
      }}
      style={styles.tokenPill}
    >
      <TokenIcon symbol={token.symbol} chain={token.chain} size={26} ring={c.raised} />
      <Text style={styles.tokenPillLabel}>{token.symbol}</Text>
      <Icon name="chevronDown" size={12} color={c.textSecondary} />
    </PressableScale>
  );
}

// ---------------------------------------------------------------------------
// Perps / Futures / Options

const BASIS: Record<Expiry, number> = {
  'Dec 26': 1.012,
  'Mar 27': 1.028,
  'Jun 27': 1.045,
};

function FuturesForm() {
  const styles = useStyles();
  const [side, setSide] = useState<Side>('Long');
  const prefs = useTradePrefs();
  const [expiry, setExpiry] = useState<Expiry>(prefs.futuresExpiry);
  const [amount, setAmount] = useState('');
  const value = Number(amount) || 0;
  const contractPrice = priceOf('ETH') * BASIS[expiry];
  return (
    <>
      <MarketPill symbol="ETH" label="ETH Futures" price={priceOf('ETH')} />
      <SideToggle options={['Long', 'Short']} value={side} onChange={setSide} />
      <FieldLabel>Expiry</FieldLabel>
      <OptionChips options={EXPIRIES} value={expiry} onChange={setExpiry} />
      <AmountCard label="Amount" unit="USDC" value={amount} onChange={setAmount} />
      <Summary
        rows={[
          ['Contract price', formatPrice(contractPrice)],
          ['Contracts', value ? (value / contractPrice).toFixed(4) : '—'],
          ['Settles', expiry],
        ]}
      />
      <PillButton
        label={value ? `Open ${side.toLowerCase()}` : 'Enter an amount'}
        disabled={!value}
        onPress={() => showDemoToast(`opened an ETH ${expiry} ${side.toLowerCase()}`)}
        style={styles.cta}
      />
      <Risk text="Futures settle on the expiry date at the market price." />
    </>
  );
}

const STRIKES = ['$2,200', '$2,400', '$2,600'] as const;

function OptionsForm() {
  const styles = useStyles();
  const [kind, setKind] = useState<Side>('Call');
  const prefs = useTradePrefs();
  const [expiry, setExpiry] = useState<Expiry>(prefs.optionsExpiry);
  const [strike, setStrike] = useState<(typeof STRIKES)[number]>('$2,400');
  const [amount, setAmount] = useState('');
  const value = Number(amount) || 0;
  const spot = priceOf('ETH');
  const strikeValue = Number(strike.replace(/[$,]/g, ''));
  // Rough placeholder premium until an options venue supplies quotes.
  const premium = Math.max(
    spot * 0.06 + (kind === 'Call' ? 1 : -1) * (spot - strikeValue) * 0.4,
    12,
  );
  return (
    <>
      <MarketPill symbol="ETH" label="ETH Options" price={spot} />
      <SideToggle options={['Call', 'Put']} value={kind} onChange={setKind} />
      <FieldLabel>Expiry</FieldLabel>
      <OptionChips options={EXPIRIES} value={expiry} onChange={setExpiry} />
      <FieldLabel>Strike</FieldLabel>
      <OptionChips options={STRIKES} value={strike} onChange={setStrike} />
      <AmountCard label="Contracts" unit="ETH" value={amount} onChange={setAmount} />
      <Summary
        rows={[
          ['Premium', formatUsd(premium * (value || 1))],
          [
            'Break-even',
            formatPrice(kind === 'Call' ? strikeValue + premium : strikeValue - premium),
          ],
        ]}
      />
      <PillButton
        label={value ? `Buy ${kind.toLowerCase()}` : 'Enter an amount'}
        disabled={!value}
        onPress={() => showDemoToast(`bought ${amount} ETH ${strike} ${kind.toLowerCase()}`)}
        style={styles.cta}
      />
      <Risk text="Options can expire worthless. The most you can lose is the premium." />
    </>
  );
}

/** Space between the keypad and what's above and below it. */
const KEYPAD_GAP = 8;

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  modes: {
    marginBottom: 20,
  },
  card: {
    padding: 16,
    gap: 10,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  stacked: {
    marginTop: 4,
  },
  cardLabel: {
    color: c.textSecondary,
    fontSize: 15,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  amountOut: {
    flex: 1,
    color: c.text,
    fontSize: 40,
    fontWeight: '500',
  },
  placeholder: {
    color: c.placeholder,
  },
  quoting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  details: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 6,
    borderRadius: 20,
    backgroundColor: c.card,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  detailValue: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
  },
  meta: {
    color: c.textSecondary,
    fontSize: 14,
  },
  error: {
    color: c.error,
  },
  flip: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -22,
    zIndex: 1,
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
    borderWidth: 4,
    borderColor: c.canvas,
  },
  tokenPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 5,
    paddingRight: 12,
    height: 38,
    borderRadius: 19,
    backgroundColor: c.raised,
  },
  tokenPillLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  percents: {
    marginTop: 16,
    marginBottom: KEYPAD_GAP,
  },
  swapCta: {
    // Same as above the keypad, so the keys sit evenly between chips and button.
    marginTop: KEYPAD_GAP,
  },
  cta: {
    marginTop: 18,
  },
}));
