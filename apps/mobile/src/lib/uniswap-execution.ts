import {
  decodeUniswapRouterCall,
  permit2TypedData,
  type SwapReviewContext,
  type SwapReviewRequest,
  type SwapSigningRequest,
  swapTransactionRequests,
  validateSwapReview,
  validateSwapSigning,
} from '@honey-wallet/api-client';
import {
  evmAddressOfKey,
  signEvmTypedData,
  verifyEvmTypedDataSignature,
} from '@honey-wallet/keyring';
import { api } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import { backendSession, backendSessionToken } from '@/lib/backend-session';
import { signReviewedEvm } from '@/lib/evm-execution';
import { privateKeyOf } from '@/lib/vault';
import { wallets } from '@/lib/wallets';

/** Explicit user confirmation only; an admitted permit is never persisted by the app. */
export async function signReviewedSwapPermit(
  review: SwapReviewRequest,
  context: SwapReviewContext,
  accountId: string,
  isCurrent: () => boolean,
) {
  const r: SwapReviewRequest = JSON.parse(JSON.stringify(review)),
    c: SwapReviewContext = JSON.parse(JSON.stringify(context));
  const token = backendSessionToken(),
    walletId = backendSession.get().profile?.wallet.id;
  const check = () => {
    const p = backendSession.get().profile;
    if (
      !isCurrent() ||
      !token ||
      backendSessionToken() !== token ||
      p?.wallet.id !== walletId ||
      wallets.get().activeId !== accountId ||
      p?.wallet.address.toLowerCase() !== c.signer.toLowerCase() ||
      p.wallet.chainId !== 'eip155:31337'
    )
      throw new Error('Wallet session changed. Review again.');
    validateSwapReview(r, c);
  };
  check();
  if (!r.review.permit) throw new Error('This swap does not require token permission.');
  if (!(await confirmOwner('Confirm Uniswap token permission', true)))
    throw new Error('Permission cancelled.');
  check();
  const key = await privateKeyOf(accountId, 'evm');
  let signature = '';
  try {
    check();
    if (evmAddressOfKey(key).toLowerCase() !== c.signer.toLowerCase())
      throw new Error('Wallet key does not match the review.');
    signature = await signEvmTypedData(key, permit2TypedData(r.review.permit));
    check();
  } finally {
    key.fill(0);
  }
  try {
    check();
    return await api.submitSwapPermit(token as string, r.operationId, {
      expectedVersion: r.operationVersion,
      reviewHash: r.reviewHash,
      signature,
    });
  } finally {
    signature = '';
  }
}
/** Recover and verify the embedded EOA signature offline, including after restart.
 * Exact review/call validation still runs before and after owner confirmation. */
export async function signReviewedSwap(
  signing: SwapSigningRequest,
  context: SwapReviewContext,
  accountId: string,
  isCurrent: () => boolean,
) {
  const r: SwapSigningRequest = JSON.parse(JSON.stringify(signing)),
    c: SwapReviewContext = JSON.parse(JSON.stringify(context));
  const action = r.prepared.plan.steps.at(-1);
  if (!action) throw new Error('Missing swap transaction.');
  const first = decodeUniswapRouterCall(action.data).commands[0];
  const signature = first?.kind === 'permit_single' ? first.signature : null;
  validateSwapSigning(r, c, signature);
  if (
    r.review.permit &&
    (!signature ||
      !(await verifyEvmTypedDataSignature(c.signer, permit2TypedData(r.review.permit), signature)))
  )
    throw new Error('Swap permit signature does not match this wallet.');
  return signReviewedEvm(
    'Uniswap',
    { signer: c.signer, chainId: '31337' },
    accountId,
    isCurrent,
    () => validateSwapSigning(r, c, signature),
    () => swapTransactionRequests(r),
    (token, signedTransactions) =>
      api.submitSwap(token, r.operationId, {
        expectedVersion: r.operationVersion,
        planHash: r.planHash,
        signedTransactions,
      }),
  );
}
