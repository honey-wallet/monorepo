import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { showErrorToast, showToast } from '@/lib/toast';
import { isWalletConnectUri, pairWalletConnect } from '@/lib/walletconnect';

/**
 * honeywallet://wc?uri=… : how a site on the phone hands a WalletConnect link to Honey
 * (the "open in wallet" button). Pairing only starts the conversation; the site still
 * has to be approved in the approval screen before it sees anything.
 */
export default function WalletConnectLink() {
  const { uri } = useLocalSearchParams<{ uri?: string }>();
  useEffect(() => {
    if (!uri || !isWalletConnectUri(uri)) {
      if (uri) showErrorToast('Not a WalletConnect link');
      return;
    }
    showToast('Connecting…');
    pairWalletConnect(uri).catch(() => showErrorToast('Link expired'));
  }, [uri]);
  return <Redirect href="/home" />;
}
