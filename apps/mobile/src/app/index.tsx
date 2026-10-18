import { Redirect } from 'expo-router';
import { useOnboarding } from '@/lib/onboarding';
import { useWallets } from '@/lib/wallets';

export default function Index() {
  const { added } = useWallets();
  const { method } = useOnboarding();
  // A wallet with keys here, or a finished sign-in (remembered by the browser extension).
  const signedIn = added.some((wallet) => wallet.addresses) || method !== null;
  return <Redirect href={signedIn ? '/home' : '/welcome'} />;
}
