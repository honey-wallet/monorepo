import { View } from 'react-native';
import { closeSheet, SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { ChainPicker } from '@/components/wallet/ChainPicker';
import { copyText } from '@/lib/copy';
import { receiveAddresses } from '@/lib/receive';
import { useActiveWallet } from '@/lib/wallets';

/** Copy address: the chain icons under Home's wallet name open this, one row per chain. */
export default function AddressesSheet() {
  const wallet = useActiveWallet();
  const list = receiveAddresses(wallet);
  if (!list.length)
    return (
      <SheetScreen title="Receive unavailable">
        <SheetText>Create or import a wallet before receiving funds.</SheetText>
      </SheetScreen>
    );
  return (
    <SheetScreen title="Copy address">
      <View>
        <ChainPicker
          entries={list}
          showAddress
          onPick={(family) => {
            const entry = list.find((e) => e.family === family);
            if (!entry) return;
            void copyText(entry.address, 'Address copied');
            closeSheet();
          }}
        />
      </View>
    </SheetScreen>
  );
}
