import type { OperationRecovery } from '@honey-wallet/api-client';
import { evmAddressOfKey, signEvmTransaction } from '@honey-wallet/keyring';
import { confirmOwner } from '@/lib/auth';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { privateKeyOf } from '@/lib/vault';
import { wallets } from '@/lib/wallets';

/** Shared key lifetime and session fencing; provider review remains independent. */
export async function signReviewedEvm(
  provider: 'Aave' | 'Morpho' | 'Uniswap',
  identity: { signer: string; chainId: string },
  accountId: string,
  isCurrent: () => boolean,
  validate: () => void,
  transactions: () => Parameters<typeof signEvmTransaction>[1][],
  submit: (token: string, signed: string[]) => Promise<OperationRecovery>,
) {
  const token = backendSessionToken();
  const walletId = backendSession.get().profile?.wallet.id;
  const assertCurrent = () => {
    const profile = backendSession.get().profile;
    if (
      !isCurrent() ||
      !token ||
      backendSessionToken() !== token ||
      wallets.get().activeId !== accountId ||
      profile?.wallet.id !== walletId ||
      profile?.wallet.address.toLowerCase() !== identity.signer.toLowerCase() ||
      profile.wallet.chainId !== `eip155:${identity.chainId}`
    )
      throw new Error('Wallet session changed. Sign in and review again.');
    validate();
  };
  assertCurrent();
  if (!(await confirmOwner(`Confirm ${provider} transaction`, true)))
    throw new Error('Transaction cancelled.');
  assertCurrent();
  const key = await privateKeyOf(accountId, 'evm');
  const signed: string[] = [];
  try {
    assertCurrent();
    if (evmAddressOfKey(key).toLowerCase() !== identity.signer.toLowerCase())
      throw new Error('Wallet key does not match the transaction.');
    for (const transaction of transactions()) {
      assertCurrent();
      signed.push(await signEvmTransaction(key, transaction));
    }
    assertCurrent();
  } catch (error) {
    signed.fill('');
    throw error;
  } finally {
    key.fill(0);
  }
  try {
    assertCurrent();
    return await submit(token as string, signed);
  } finally {
    // JS strings cannot be reliably zeroized; drop all owned references promptly.
    signed.fill('');
  }
}
