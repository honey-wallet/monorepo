import { Text, View } from 'react-native';
import { TokenIcon } from '@/components/wallet/parts';
import type { PerpMarket } from '@/lib/perps';

/** A perps market's logo: the coin logo for crypto, else a monogram on its brand colour. */
export function MarketIcon({ market, size = 40 }: { market: PerpMarket; size?: number }) {
  if (!market.monogram) return <TokenIcon symbol={market.symbol} size={size} />;
  const { text, color } = market.monogram;
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: color,
      }}
    >
      <Text
        style={{
          color: '#FFFFFF',
          fontSize: size * (text.length > 2 ? 0.3 : 0.38),
          fontWeight: '700',
          letterSpacing: -0.3,
        }}
      >
        {text}
      </Text>
    </View>
  );
}
