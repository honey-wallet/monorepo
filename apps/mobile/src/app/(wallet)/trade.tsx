import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Text, useWindowDimensions, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { useErrorShake } from '@/components/motion/ErrorShake';
import { MatrixLoader } from '@/components/motion/MatrixLoader';
import { PanelReveal } from '@/components/motion/PanelReveal';
import { PressableScale } from '@/components/motion/PressableScale';
import { ShimmerText } from '@/components/motion/ShimmerText';
import { SkeletonBar, useFirstLoad } from '@/components/motion/Skeleton';
import { Sticky } from '@/components/motion/Sticky';
import { TextSwap } from '@/components/motion/TextSwap';
import { UnderlineTabs } from '@/components/motion/UnderlineTabs';
import { PillButton } from '@/components/onboarding/PillButton';
import { PerpsMarkets } from '@/components/trade/PerpsMarkets';
import { PredictFeed } from '@/components/trade/PredictFeed';
import { SwapReview } from '@/components/trade/SwapReview';
import {
  AmountCard,
  FieldLabel,
  MarketPill,
  OptionChips,
  Risk,
  type Side,
  SideToggle,
  Summary,
} from '@/components/trade/TradeForm';
import { HeaderActions } from '@/components/wallet/HeaderActions';
import {
  applyKey,
  Keypad,
  PercentChips,
  TypedAmount,
  trimNumber,
} from '@/components/wallet/Keypad';
import { EmptyState, HeaderIconButton, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { TabScreen } from '@/components/wallet/TabScreen';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import {
  type Chain,
  formatBalance,
  formatPrice,
  formatUsd,
  holdingAmount,
  priceOf,
} from '@/lib/mock-wallet';
import { type Multisig, useSigner } from '@/lib/multisig';
import { goBackOr } from '@/lib/navigation';
import type { TradeMode } from '@/lib/settings';
import { type TokenRef, updateSwap, useSwap } from '@/lib/swap';
import { showDemoToast } from '@/lib/toast';
import { useTradeModes } from '@/lib/trade-modes';
import { EXPIRIES, type Expiry, useTradePrefs } from '@/lib/trade-prefs';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, useTheme } from '@/theme';

/**
 * Trading, kept simple: Swap (which also bridges across networks), Perps and
 * Predict. Futures and Options are switched off for now (see AVAILABLE_TRADE_MODES).
 * Each product is one short form; nothing executes yet, so final actions confirm with
 * a demo toast.
 */
export default function TradeScreen() {
  const styles = useStyles();
  // `?mode=Perps` opens a specific product, e.g. from a deep link.
  const params = useLocalSearchParams<{ mode?: TradeMode }>();
  // A shared wallet only swaps; products it can't use can't be opened, even by link.
  const tabs = useTradeModes();
  const [picked, setPicked] = useState<TradeMode>(
    params.mode && tabs.includes(params.mode) ? params.mode : tabs[0],
  );
  // A link that names a product switches to it, even with Trade already open (only
  // when the link changes, so tapping another tab isn't undone).
  const shown = useRef(tabs);
  shown.current = tabs;
  useEffect(() => {
    if (params.mode && shown.current.includes(params.mode)) setPicked(params.mode);
  }, [params.mode]);
  // If the open tab was just hidden, fall back to the first one still shown.
  const mode = tabs.includes(picked) ? picked : tabs[0];
  const [query, setQuery] = useState('');
  return (
    // Trade is a focused flow with no tab bar; Back returns to where you came from. Its
    // top bar matches Search's: a search field, then the balance and settings.
    <TabScreen tabBar={false}>
      <View style={styles.top}>
        <HeaderIconButton bare icon="chevronLeft" label="Back" onPress={() => goBackOr('/home')} />
        <View style={styles.flex}>
          <SearchField
            value={mode === 'Swap' ? '' : query}
            onChangeText={setQuery}
            placeholder={mode === 'Swap' ? 'Search tokens' : 'Search markets'}
            // On Swap, searching means picking the token to buy.
            onFocus={
              mode === 'Swap'
                ? () => {
                    Keyboard.dismiss();
                    tap();
                    router.push({ pathname: '/token-picker', params: { side: 'buy' } });
                  }
                : undefined
            }
          />
        </View>
        <HeaderActions
          settingsLabel={`${mode} settings`}
          onSettings={() =>
            mode === 'Swap'
              ? router.push('/swap-settings')
              : router.push({ pathname: '/trade-settings', params: { mode } })
          }
        />
      </View>
      {/* The products you've chosen, sharing the row equally; edit them from settings.
          With a single product there's nothing to switch between, so no tabs. */}
      {tabs.length > 1 && (
        <Sticky id="trade-tabs">
          <View style={styles.modes}>
            <UnderlineTabs options={tabs} value={mode} onChange={setPicked} />
          </View>
        </Sticky>
      )}
      <ContentSwap id={mode} index={tabs.indexOf(mode)} fill={mode === 'Swap'}>
        {mode === 'Swap' && <SwapForm />}
        {mode === 'Perps' && <PerpsMarkets query={query} onClearQuery={() => setQuery('')} />}
        {mode === 'Futures' && <FuturesForm />}
        {mode === 'Options' && <OptionsForm />}
        {mode === 'Predict' && <PredictFeed query={query} onClearQuery={() => setQuery('')} />}
      </ContentSwap>
    </TabScreen>
  );
}

// ---------------------------------------------------------------------------
// Swap

/** How long a fresh quote takes before the rate shows. */
const QUOTE_MS = 700;

/**
 * The swap pair for a shared wallet: kept if both sides are on its network, else its
 * largest balance into USDC (or ETH, if that's what it holds most of).
 */
function onNetwork(pair: ReturnType<typeof useSwap>, multisig: Multisig) {
  const chain = multisig.network.name as Chain;
  if (pair.sell.chain === chain && pair.buy.chain === chain) return pair;
  const sell = multisig.holdings[0]?.symbol ?? 'ETH';
  return {
    ...pair,
    sell: { symbol: sell, chain },
    buy: { symbol: sell === 'USDC' ? 'ETH' : 'USDC', chain },
  };
}

function SwapForm() {
  const styles = useStyles();
  const c = useTheme();
  const stored = useSwap();
  // A shared wallet swaps only on its own network, from its own balances.
  const { multisig, walletId } = useSigner();
  // A new wallet holds nothing until its first deposit.
  const { empty } = useWalletView();
  const balancesLoading = useFirstLoad(LOADS.balances(walletId));
  const pricesLoading = useFirstLoad(LOADS.market);
  const pair = multisig ? onNetwork(stored, multisig) : stored;
  const sell = pair.sell.symbol;
  const buy = pair.buy.symbol;
  // The typed amount belongs to the token being sold; picking another clears it.
  const sellKey = `${sell}-${pair.sell.chain}`;
  const [entry, setEntry] = useState({ key: sellKey, amount: '' });
  const amount = entry.key === sellKey ? entry.amount : '';
  const setAmount = (next: string | ((prev: string) => string)) =>
    setEntry({ key: sellKey, amount: typeof next === 'function' ? next(amount) : next });
  const balance = multisig
    ? (multisig.holdings.find((h) => h.symbol === sell && h.chain === pair.sell.chain)?.amount ?? 0)
    : empty
      ? 0
      : holdingAmount(sell, pair.sell.chain);
  // Nothing at all to swap from (a new wallet, or an unfunded shared one).
  const nothing = multisig ? !multisig.holdings.some((h) => h.amount > 0) : empty;
  const bridging = pair.sell.chain !== pair.buy.chain;
  // You type either side: what you sell (in the token or in dollars), or exactly what
  // you want to get, and the other side is worked out. Below, `value` is always the
  // sell amount in the token and `out` the buy amount.
  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const [unit, setUnit] = useState<'token' | 'usd'>('token');
  const price = priceOf(sell) || 1;
  const typed = Number(amount) || 0;
  const rate = priceOf(sell) / (priceOf(buy) || 1);
  const value = side === 'buy' ? typed / rate : unit === 'usd' ? typed / price : typed;
  const out = side === 'buy' ? typed : value * rate;
  const usd = value * price;
  const sellTyped = unit === 'usd' ? trimNumber(usd, 2) : trimNumber(value, 8);
  const flipUnit = () => {
    tap();
    // Converts whichever side was typed into the sell amount in the other unit.
    if (typed) setAmount(unit === 'usd' ? trimNumber(value, 8) : trimNumber(usd, 2));
    setSide('sell');
    setUnit(unit === 'usd' ? 'token' : 'usd');
  };
  /** Makes one side the one you type into, carrying over what it showed. */
  const edit = (next: 'sell' | 'buy') => {
    if (next === side) return;
    tap();
    if (typed) setAmount(next === 'buy' ? trimNumber(out, 8) : sellTyped);
    setSide(next);
  };
  /** Sets the sell amount (percent chips, the balance), switching back to typing it. */
  const setSellAmount = (next: string) => {
    setSide('sell');
    setAmount(next);
  };
  const tooMuch = value > balance;
  const route = bridging ? 'Across + Uniswap' : 'Uniswap';
  const networkCost = bridging ? '$1.20' : '$0.42';
  const [reviewing, setReviewing] = useState(false);
  // The form lives in the tab's scroll view, so nothing squeezes it: when the cards,
  // the quote details and the keypad don't fit above the home indicator, the keys
  // shrink by the overflow (to a floor), and grow back into any spare room.
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const root = useRef<View>(null);
  const [keyHeight, setKeyHeight] = useState<number>(KEY_MAX);
  const [spare, setSpare] = useState(0);
  const fit = () =>
    root.current?.measureInWindow((_x, y, _w, h) => {
      const over = y + h - (windowHeight - insets.bottom - SCREEN_BOTTOM);
      if (over > 0.5) setKeyHeight((k) => Math.max(KEY_MIN, k - Math.ceil(over / 4)));
    });
  useEffect(() => {
    if (spare > 1 && keyHeight < KEY_MAX) {
      setKeyHeight((k) => Math.min(KEY_MAX, k + Math.floor(spare / 4)));
    }
  }, [spare, keyHeight]);

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
    setSide('sell');
    updateSwap({ sell: pair.buy, buy: pair.sell });
  };

  if (nothing) {
    return (
      <EmptyState
        icon="trade"
        title="Nothing to swap yet"
        hint={
          multisig
            ? `Send tokens on ${multisig.network.name} to this shared wallet, then swap them here.`
            : 'Add money or receive tokens first, then swap them here.'
        }
        action={
          multisig
            ? { label: 'Receive', onPress: () => router.push('/receive') }
            : { label: 'Add money', onPress: () => router.push('/buy-cash') }
        }
      />
    );
  }

  return (
    <View ref={root} style={styles.flex} onLayout={fit}>
      <View>
        <View style={[styles.card, side === 'buy' && styles.cardIdle]}>
          <Text style={styles.cardLabel}>Sell</Text>
          <Animated.View style={[styles.cardRow, shakeStyle]}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Type the amount to sell"
              accessibilityState={{ selected: side === 'sell' }}
              scaleTo={1}
              onPress={() => edit('sell')}
              style={styles.flex}
            >
              {side === 'sell' ? (
                <TypedAmount
                  value={amount}
                  prefix={unit === 'usd' ? '$' : ''}
                  size={40}
                  align="left"
                />
              ) : (
                <TextSwap
                  text={value ? `${unit === 'usd' ? '$' : ''}${sellTyped}` : '0'}
                  style={[styles.amountOut, !value && styles.placeholder]}
                />
              )}
            </PressableScale>
            <TokenPill side="sell" token={pair.sell} />
          </Animated.View>
          <View style={styles.cardRow}>
            {/* The other unit; tapping it switches what you type in (dollars or token). */}
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={unit === 'usd' ? `Type in ${sell}` : 'Type in dollars'}
              hitSlop={10}
              onPress={flipUnit}
              style={styles.convert}
            >
              <Icon name="expand" size={12} color={c.textSecondary} />
              <TextSwap
                text={unit === 'usd' ? `${formatBalance(value)} ${sell}` : formatUsd(usd)}
                style={styles.meta}
              />
            </PressableScale>
            {/* Tapping the balance sells all of it, like Max. */}
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`Balance ${balance} ${sell}`}
              accessibilityHint="Enters your whole balance"
              hitSlop={10}
              onPress={() => {
                tap();
                setSellAmount(
                  unit === 'usd' ? trimNumber(balance * price, 2) : trimNumber(balance, 8),
                );
              }}
            >
              {balancesLoading ? (
                <SkeletonBar width={80} height={12} />
              ) : (
                <TextSwap
                  text={
                    !balance
                      ? `No ${sell}`
                      : unit === 'usd'
                        ? formatUsd(balance * price)
                        : `${balance} ${sell}`
                  }
                  style={[styles.meta, tooMuch && styles.error]}
                />
              )}
            </PressableScale>
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

        <View style={[styles.card, styles.stacked, side === 'sell' && styles.cardIdle]}>
          <Text style={styles.cardLabel}>Buy</Text>
          <View style={styles.cardRow}>
            {/* Tap to type exactly how much you want; Sell works out what it costs. */}
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`Type the amount of ${buy} to get`}
              accessibilityState={{ selected: side === 'buy' }}
              scaleTo={1}
              onPress={() => edit('buy')}
              style={styles.flex}
            >
              {side === 'buy' ? (
                <TypedAmount value={amount} size={40} align="left" />
              ) : (
                <TextSwap
                  text={out ? Number(out.toPrecision(6)).toString() : '0'}
                  style={[styles.amountOut, !out && styles.placeholder]}
                />
              )}
            </PressableScale>
            <TokenPill side="buy" token={pair.buy} />
          </View>
          {quoting ? (
            <View style={styles.quoting}>
              <MatrixLoader dot={3} />
              <ShimmerText text="Finding best route" style={styles.meta} />
            </View>
          ) : pricesLoading ? (
            <View style={styles.metaLine}>
              <SkeletonBar width={140} height={12} />
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

      {/* As in Uniswap: cards at the top, keypad and button at the bottom, open space
          between. When the quote details open there's less room, so the keys shrink to
          fit (down to a floor) rather than pushing the button off the bottom. */}
      <View style={styles.flex} onLayout={(e) => setSpare(e.nativeEvent.layout.height)} />
      <PercentChips
        balance={unit === 'usd' ? balance * price : balance}
        decimals={unit === 'usd' ? 2 : 8}
        onPick={setSellAmount}
        style={styles.percents}
      />
      <Keypad
        keyHeight={keyHeight}
        onKey={(key) =>
          setAmount((v) => applyKey(v, key, side === 'sell' && unit === 'usd' ? 2 : 8))
        }
      />

      {/* None of the token being sold: the next step is getting some, not typing. */}
      {!balance && !balancesLoading ? (
        <PillButton
          label={multisig ? `Receive ${sell}` : `Buy ${sell}`}
          onPress={() => {
            tap();
            router.push(
              multisig ? '/receive' : { pathname: '/buy-cash', params: { symbol: sell } },
            );
          }}
          style={styles.swapCta}
        />
      ) : (
        <PillButton
          label={!value ? 'Enter an amount' : tooMuch ? `Not enough ${sell}` : 'Review swap'}
          disabled={!value || tooMuch}
          onPress={() => {
            tap();
            setReviewing(true);
          }}
          style={styles.swapCta}
        />
      )}

      <SwapReview
        visible={reviewing}
        pay={{
          amount: trimNumber(value, 8),
          symbol: sell,
          chain: pair.sell.chain,
          usd: formatUsd(usd),
        }}
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
  const loading = useFirstLoad(LOADS.market);
  return (
    <>
      <MarketPill symbol="ETH" label="ETH Futures" price={priceOf('ETH')} />
      <SideToggle options={['Long', 'Short']} value={side} onChange={setSide} />
      <FieldLabel>Expiry</FieldLabel>
      <OptionChips options={EXPIRIES} value={expiry} onChange={setExpiry} />
      <AmountCard label="Amount" unit="USDC" value={amount} onChange={setAmount} />
      <Summary
        loading={loading}
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
  const loading = useFirstLoad(LOADS.market);
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
        loading={loading}
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
const KEY_MAX = 60;
const KEY_MIN = 42;
/** Matches the tab screen's padding under its content (no tab bar on Trade). */
const SCREEN_BOTTOM = 8;

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  top: {
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
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
  // The side you're not typing into: outlined rather than filled, as in Uniswap.
  cardIdle: {
    borderWidth: 1,
    borderColor: c.card,
    backgroundColor: 'transparent',
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
  convert: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  meta: {
    color: c.textSecondary,
    fontSize: 14,
  },
  // A placeholder bar on a 14pt text line, so the card keeps its height.
  metaLine: {
    height: 18,
    justifyContent: 'center',
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
