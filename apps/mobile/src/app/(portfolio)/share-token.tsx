import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useRef, useState } from 'react';
import type { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { TokenShareCard } from '@/components/home/TokenShareCard';
import { Toggle } from '@/components/motion/Toggle';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { EmptyState } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { formatBalance, formatUsd, MARKET, RANGES, type Range, series } from '@/lib/mock-wallet';
import { showToast } from '@/lib/toast';
import { useWalletView } from '@/lib/wallet-view';

/**
 * Share a token's price as an image card. Your holding is left off unless you turn it
 * on, so only the market price leaves the phone by default.
 */
export default function ShareTokenSheet() {
  const params = useLocalSearchParams<{ symbol?: string; range?: Range }>();
  const symbol = params.symbol ?? 'ETH';
  const range = params.range && RANGES.includes(params.range) ? params.range : '1D';
  const market = MARKET.find((t) => t.symbol === symbol);
  const { tokens } = useWalletView();
  const held = tokens.find((t) => t.symbol === symbol);
  const [showHolding, setShowHolding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const card = useRef<View>(null);
  if (!market) {
    return (
      <SheetScreen>
        <EmptyState
          icon="warning"
          title="Nothing to share"
          hint={`Honey doesn't have prices for ${symbol} yet.`}
          action={{ label: 'Close', onPress: () => router.back() }}
        />
      </SheetScreen>
    );
  }

  const data = series(symbol, range, market.price, range === '1D' ? market.change : undefined);
  const change = ((market.price - data[0]) / data[0]) * 100;

  const share = async () => {
    tap();
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        showToast("Sharing isn't available on this device");
        return;
      }
      const uri = await captureRef(card, { format: 'png', quality: 1 });
      await Sharing.shareAsync(uri, {
        mimeType: 'image/png',
        dialogTitle: `Share ${market.name}`,
        UTI: 'public.png',
      });
    } catch {
      showToast("Couldn't create the image. Try again.");
    } finally {
      setSharing(false);
    }
  };

  return (
    <SheetScreen
      title={`Share ${market.name}`}
      footer={
        <PillButton label={sharing ? 'Preparing…' : 'Share'} disabled={sharing} onPress={share} />
      }
    >
      <TokenShareCard
        ref={card}
        symbol={symbol}
        name={market.name}
        price={market.price}
        change={change}
        range={range}
        data={data}
        holding={
          showHolding && held
            ? { amount: formatBalance(held.amount), value: formatUsd(held.usd) }
            : undefined
        }
      />
      {held ? (
        <SheetRow
          title="Show my balance"
          subtitle={`Add what you hold in ${symbol} to the image`}
          accessory={
            <Toggle
              accessibilityLabel="Show my balance"
              value={showHolding}
              onValueChange={(on) => {
                tap();
                setShowHolding(on);
              }}
            />
          }
        />
      ) : null}
    </SheetScreen>
  );
}
