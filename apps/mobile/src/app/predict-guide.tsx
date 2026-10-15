import { Guide } from '@/components/wallet/Guide';
import { GetPaidArt, PickMarketArt, PlaceTradeArt } from '@/components/wallet/PredictGuideArt';

/** How Predict works, in three steps; shown the first time Predict opens. */
export default function PredictGuideSheet() {
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
