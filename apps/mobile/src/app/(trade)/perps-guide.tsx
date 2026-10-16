import { Redirect } from 'expo-router';
import { ClosePositionArt, LongShortArt, PickPerpArt } from '@/components/trade/PerpsGuideArt';
import { Guide } from '@/components/wallet/Guide';
import { useTradeModeAllowed } from '@/lib/trade-modes';

/** How Perps work, in three steps; shown the first time Perps opens. */
function PerpsGuideSheet() {
  return (
    <Guide
      steps={[
        {
          title: 'Pick a market',
          body: 'Crypto, stocks, indices and commodities, all settled in USDC. You trade the price; you never hold the asset itself.',
          art: <PickPerpArt />,
        },
        {
          title: 'Go long or short',
          body: 'Long if you think the price will rise, short if you think it will fall. Leverage multiplies your gains and your losses.',
          art: <LongShortArt />,
        },
        {
          title: 'Close when you like',
          body: 'Take a profit or cut a loss any time. If the price moves too far against you, the position closes on its own and you lose that margin.',
          note: "Perps are high risk and aren't available in every country.",
          art: <ClosePositionArt />,
        },
      ]}
    />
  );
}

/** Shared wallets can't use this product (see `lib/trade-modes.ts`); links land on Trade. */
export default function PerpsGuideSheetRoute() {
  return useTradeModeAllowed('Perps') ? <PerpsGuideSheet /> : <Redirect href="/trade" />;
}
