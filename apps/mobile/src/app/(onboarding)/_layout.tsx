import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@/theme';

export default function OnboardingLayout() {
  const c = useTheme();
  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.canvas } }} />
      <StatusBar style="auto" />
    </>
  );
}
