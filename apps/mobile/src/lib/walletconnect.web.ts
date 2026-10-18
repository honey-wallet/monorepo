/**
 * The browser build has no WalletConnect: Honey for Chrome connects to sites directly
 * (apps/extension/src/worker). Same names as walletconnect.ts so shared screens build.
 */
export const walletConnect = async () => null;
export const isWalletConnectUri = (_text: string) => false;
export async function pairWalletConnect(_uri: string) {
  throw new Error('WalletConnect is for the phone');
}
