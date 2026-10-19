import {
  type AaveReviewContext,
  type AaveSigningRequest,
  aaveTransactionRequests,
  validateAaveReview,
} from '@honey-wallet/api-client';
import { api } from '@/lib/api';
import { signReviewedEvm } from '@/lib/evm-execution';

/** User-confirmed signing only. Never signs or submits from an effect/poll/retry. */
export async function signReviewedAave(
  signing: AaveSigningRequest,
  context: AaveReviewContext,
  accountId: string,
  isCurrent: () => boolean,
) {
  // Public JSON DTOs only; copy before awaiting owner confirmation.
  const request: AaveSigningRequest = JSON.parse(JSON.stringify(signing));
  const review: AaveReviewContext = JSON.parse(JSON.stringify(context));
  return signReviewedEvm(
    'Aave',
    { signer: review.signer, chainId: review.configuration.chainId },
    accountId,
    isCurrent,
    () => validateAaveReview(request, review),
    () => aaveTransactionRequests(request),
    (token, signedTransactions) =>
      api.submitAave(token, request.operationId, {
        expectedVersion: request.operationVersion,
        planHash: request.planHash,
        signedTransactions,
      }),
  );
}
export { earnDisplayAmount as aaveDisplayAmount } from '@/lib/earn-amount';

import { earnRawAmount } from '@/lib/earn-amount';
export function aaveRawAmount(text: string, decimals: number): string {
  if (decimals > 18) throw new Error('Unsupported decimals.');
  return earnRawAmount(text, decimals);
}
