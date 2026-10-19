import type { HyperliquidPerpsAccountState } from '@honey-wallet/api-client';
import { api } from './api';

export async function readHyperliquidAccount(
  token: string,
  address: string,
  signal: AbortSignal,
): Promise<HyperliquidPerpsAccountState> {
  const account = await api.hyperliquidPerpsAccount(token, { signal });
  if (account.account.toLowerCase() !== address.toLowerCase())
    throw new Error('The account response did not match the signed-in wallet.');
  return account;
}
