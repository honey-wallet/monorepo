import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/wallet/Sheet';
import { finishDemo, SuccessPage } from '@/components/wallet/SuccessPage';
import { AmountCard, Risk, type Side, SideToggle, Summary } from '@/components/wallet/TradeForm';
import { success } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { PREDICT_MARKETS, predictMarket, yesPrice } from '@/lib/predict';
import { useTradeModeAllowed } from '@/lib/trade-modes';
import { formatShare, useTradePrefs } from '@/lib/trade-prefs';
import { makeStyles } from '@/theme';

/** Buy Yes/No (or Up/Down) shares in one prediction market, or one outcome of it. */
function PredictOrderSheet() {
  const { predictPrice: priceFormat } = useTradePrefs();
  const styles = useStyles();
  const params = useLocalSearchParams<{ id?: string; outcome?: string; side?: Side }>();
  const market = predictMarket(params.id ?? '') ?? PREDICT_MARKETS[0];
  const outcome =
    market.kind === 'multi'
      ? (market.outcomes.find((o) => o.id === params.outcome) ?? market.outcomes[0])
      : undefined;
  const sides: [Side, Side] = market.kind === 'updown' ? ['Up', 'Down'] : ['Yes', 'No'];
  const [side, setSide] = useState<Side>(
    params.side && sides.includes(params.side) ? params.side : sides[0],
  );
  const [amount, setAmount] = useState('');
  const [bought, setBought] = useState(false);
  const value = Number(amount) || 0;
  const yes = yesPrice(market, outcome?.id);
  const price = side === sides[0] ? yes : 1 - yes;
  const what = outcome ? `${outcome.label}: ${side}` : side;

  if (bought) {
    return (
      <SheetScreen
        size="fill"
        title={market.question}
        footer={
          <PillButton
            label="Done"
            onPress={() => finishDemo(`bought ${what} on “${market.question}”`)}
          />
        }
      >
        <SuccessPage
          title={`Bought ${side}`}
          detail={`${(value / price).toFixed(2)} shares${outcome ? ` of ${outcome.label}` : ''}. Pays ${formatUsd(value / price)} if you're right.`}
        />
      </SheetScreen>
    );
  }

  return (
    <SheetScreen
      size="fill"
      title={market.kind === 'updown' ? `${market.question} · ${market.window}` : market.question}
      footer={
        <PillButton
          label={value ? `Buy ${side}` : 'Enter an amount'}
          disabled={!value}
          onPress={() => {
            success();
            setBought(true);
          }}
        />
      }
    >
      {outcome && <Text style={styles.outcome}>{outcome.label}</Text>}
      <SideToggle options={sides} value={side} onChange={setSide} />
      <AmountCard label="Amount" unit="USDC" value={amount} onChange={setAmount} surface="raised" />
      <Summary
        rows={[
          ['Price per share', formatShare(price, priceFormat)],
          ['Shares', value ? (value / price).toFixed(2) : '—'],
          [`Payout if ${side}`, value ? formatUsd(value / price) : '—'],
        ]}
      />
      <Risk text="Each share pays $1 if you're right and nothing if you're wrong." />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  outcome: {
    color: c.accentText,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
}));

/** Shared wallets can't use this product (see `lib/trade-modes.ts`); links land on Trade. */
export default function PredictOrderSheetRoute() {
  return useTradeModeAllowed('Predict') ? <PredictOrderSheet /> : <Redirect href="/trade" />;
}
