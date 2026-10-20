/**
 * Test mode (`EXPO_PUBLIC_TEST_MODE=1`, off by default): the real app with fake money. Your
 * wallets hold the sample portfolio (see `allWallets` in lib/wallets.ts), so every screen is
 * populated; sends, trades and deposits end on their success pages without signing. Prices,
 * quotes and markets stay live. Never on in release builds.
 */
export const TEST_MODE = process.env.EXPO_PUBLIC_TEST_MODE === '1';

/** Shown when a feature can't be turned on outside test mode. */
export const NOT_AVAILABLE = 'Not available on this network yet';

/**
 * What happens when someone flips Bunk mode. Its contracts aren't deployed, so outside test
 * mode it stays off: no claim of protection that doesn't exist.
 */
export function bunkToggle(
  want: boolean,
  testMode: boolean = TEST_MODE,
): { enabled: boolean; toast: string } {
  if (!want) return { enabled: false, toast: 'Bunk mode off' };
  if (!testMode) return { enabled: false, toast: NOT_AVAILABLE };
  return { enabled: true, toast: 'Bunk mode on' };
}
