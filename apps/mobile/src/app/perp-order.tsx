import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { MarketIcon } from '@/components/wallet/MarketIcon';
import { EmptyState } from '@/components/wallet/parts';
import { SheetScreen } from '@/components/wallet/Sheet';
import { finishDemo, SuccessPage } from '@/components/wallet/SuccessPage';
import {
  AmountCard,
  FieldLabel,
  MarketPill,
  OptionChips,
  Risk,
  SideToggle,
  Summary,
} from '@/components/wallet/TradeForm';
import { success } from '@/lib/haptics';
import { formatPrice, formatUsd } from '@/lib/mock-wallet';
import { liquidationPrice, perpMarket } from '@/lib/perps';
import { PERP_LEVERAGE_STEPS, useTradePrefs } from '@/lib/trade-prefs';
import { makeStyles } from '@/theme';

type Side = 'Long' | 'Short';

/** Open a perps position: side, margin and leverage, with size and liquidation price. */
export default function PerpOrderSheet() {
  const styles = useStyles();
  const params = useLocalSearchParams<{ symbol?: string; side?: string }>();
  const symbol = params.symbol ?? 'BTC';
  const market = perpMarket(symbol);
  const [side, setSide] = useState<Side>(params.side === 'Short' ? 'Short' : 'Long');
  const [amount, setAmount] = useState('');
  const [opened, setOpened] = useState(false);

  const max = market?.maxLeverage ?? 1;
  const options = [
    ...PERP_LEVERAGE_STEPS.filter((n) => n < max).map((n) => `${n}x`),
    `Max ${max}x`,
  ];
  // Start on the default leverage from Perps settings, or the market's max if lower.
  const prefs = useTradePrefs();
  const preferred = `${prefs.perpLeverage}x`;
  const [leverage, setLeverage] = useState(
    options.includes(preferred) ? preferred : options[options.length - 1],
  );

  if (!market) {
    return (
      <SheetScreen title={`${symbol}-PERP`} size="fill">
        <EmptyState
          icon="warning"
          title="Market not found"
          hint={`Honey doesn't offer a ${symbol} perpetual yet.`}
        />
      </SheetScreen>
    );
  }

  const value = Number(amount) || 0;
  const multiple = Number(leverage.replace(/\D/g, '')) || 1;
  const liquidation = liquidationPrice(market.price, multiple, side);

  if (opened) {
    return (
      <SheetScreen
        title={`${symbol}-PERP`}
        size="fill"
        footer={
          <PillButton
            label="Done"
            onPress={() => finishDemo(`opened a ${multiple}x ${symbol} ${side.toLowerCase()}`)}
          />
        }
      >
        <SuccessPage
          title={`${side} opened`}
          detail={`${formatUsd(value * multiple)} of ${symbol} at ${multiple}x, from ${formatUsd(value)} margin.`}
        />
      </SheetScreen>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <SheetScreen
        title={`${symbol}-PERP`}
        size="fill"
        footer={
          <PillButton
            label={value ? `Open ${side.toLowerCase()}` : 'Enter an amount'}
            disabled={!value}
            onPress={() => {
              success();
              setOpened(true);
            }}
          />
        }
      >
        <MarketPill
          symbol={symbol}
          label={market.name}
          price={market.price}
          leading={<MarketIcon market={market} size={32} />}
          surface="raised"
          chevron={false}
        />
        <SideToggle options={['Long', 'Short']} value={side} onChange={setSide} />
        <AmountCard
          label="Margin"
          unit="USDC"
          value={amount}
          onChange={setAmount}
          surface="raised"
        />
        <FieldLabel>Leverage</FieldLabel>
        <OptionChips options={options} value={leverage} onChange={setLeverage} />
        <Summary
          rows={[
            ['Position size', value ? formatUsd(value * multiple) : '—'],
            ['Entry price', formatPrice(market.price)],
            ['Liquidation price', value ? formatPrice(liquidation) : '—'],
            ['Funding (1h)', `${market.funding.toFixed(4)}%`],
            ['Margin mode', prefs.marginMode],
            ['Max slippage', prefs.perpSlippage],
          ]}
        />
        <Risk text="Leverage multiplies losses. You can lose your whole margin." />
      </SheetScreen>
    </KeyboardAvoidingView>
  );
}

const useStyles = makeStyles(() => ({
  flex: {
    flex: 1,
  },
}));
