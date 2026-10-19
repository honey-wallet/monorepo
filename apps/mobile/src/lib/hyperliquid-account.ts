import type { HyperliquidPerpsAccountState } from '@honey-wallet/api-client';

export function hyperliquidAccountMatchesWallet(
  result: HyperliquidPerpsAccountState,
  address: string,
): boolean {
  return result.account.toLowerCase() === address.toLowerCase();
}
