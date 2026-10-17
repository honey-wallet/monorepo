import { Redirect } from 'expo-router';
import { useWallets } from '@/lib/wallets';

export default function Index() {
  const { added } = useWallets();
  return <Redirect href={added.some((wallet) => wallet.addresses) ? '/home' : '/welcome'} />;
}
