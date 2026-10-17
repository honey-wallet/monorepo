import { Tabs } from 'expo-router';
import { Easing } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { TabBar } from '@/components/wallet/TabBar';
import { DURATION } from '@/theme/motion';

// Motion: switching tabs slides the new screen in from the side of the tab you tapped
// (50px, with a crossfade), so the bar's left-to-right order reads as a place: tap a
// tab to the left and the page arrives from the left. 250ms on a snappy ease-out.
// Under Reduce Motion it only crossfades.
const SLIDE = {
  animation: 'timing',
  config: { duration: DURATION.medium, easing: Easing.bezier(0.25, 1, 0.5, 1) },
} as const;

export default function WalletLayout() {
  const reduceMotion = useReducedMotion();
  return (
    <Tabs
      // Back from Trade returns to the tab you opened it from.
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        animation: reduceMotion ? 'fade' : 'shift',
        transitionSpec: SLIDE,
      }}
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
