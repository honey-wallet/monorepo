import { View } from 'react-native';
import { closeSheet, SheetScreen } from '@/components/sheets/Sheet';
import { ChainPicker } from '@/components/wallet/ChainPicker';
import { DeploymentList } from '@/components/wallet/MultisigParts';
import { copyText } from '@/lib/copy';
import { useMultisigDeployments } from '@/lib/multisig';
import { receiveAddresses } from '@/lib/receive';
import { useActiveWallet } from '@/lib/wallets';

/** Copy address: the chain icons under Home's wallet name open this, one row per chain. */
export default function AddressesSheet() {
  const wallet = useActiveWallet();
  const list = receiveAddresses(wallet);
  // A shared wallet: one row per chain it's deployed on, each with its own address.
  const deployments = useMultisigDeployments(wallet.id);
  if (deployments.length) {
    return (
      <SheetScreen title="Copy address">
        <DeploymentList
          deployments={deployments}
          onPick={(d) => {
            void copyText(d.address, 'Address copied');
            closeSheet();
          }}
        />
      </SheetScreen>
    );
  }
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
