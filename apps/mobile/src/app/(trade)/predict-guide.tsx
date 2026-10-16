import { Redirect } from 'expo-router';
import { GetPaidArt, PickMarketArt, PlaceTradeArt } from '@/components/trade/PredictGuideArt';
import { Guide } from '@/components/wallet/Guide';
import { useTradeModeAllowed } from '@/lib/trade-modes';

/** How Predict works, in three steps; shown the first time Predict opens. */
function PredictGuideSheet() {
  return (
    <Guide
      steps={[
        {
          title: 'Pick a market',
          body: 'Buy Yes or No on what you think will happen. Prices move as people trade.',
          art: <PickMarketArt />,
        },
        {
          title: 'Place a trade',
          body: 'Each share costs between 1¢ and 99¢. The price is roughly the chance it happens, so cheaper shares pay out more.',
          art: <PlaceTradeArt />,
        },
        {
          title: "Get paid if you're right",
          body: 'Sell your shares any time, or hold until the market ends. Winning shares pay $1 each; losing shares pay nothing.',
          note: "Prediction markets aren't available in every country.",
          art: <GetPaidArt />,
        },
      ]}
    />
  );
}

/** Shared wallets can't use this product (see `lib/trade-modes.ts`); links land on Trade. */
export default function PredictGuideSheetRoute() {
  return useTradeModeAllowed('Predict') ? <PredictGuideSheet /> : <Redirect href="/trade" />;
}
