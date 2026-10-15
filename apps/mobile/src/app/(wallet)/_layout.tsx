import { Tabs } from 'expo-router';
import { TabBar } from '@/components/wallet/TabBar';

export default function WalletLayout() {
  return (
    <Tabs
      // Back from Trade returns to the tab you opened it from.
      backBehavior="history"
      screenOptions={{ headerShown: false, animation: 'fade' }}
      tabBar={(props) => <TabBar {...props} />}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="savings" />
      <Tabs.Screen name="search" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="trade" />
    </Tabs>
  );
}
