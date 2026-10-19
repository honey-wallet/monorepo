import {
  type MorphoReviewContext,
  type MorphoSigningRequest,
  morphoTransactionRequests,
  validateMorphoReview,
} from '@honey-wallet/api-client';
import { api } from '@/lib/api';
import { signReviewedEvm } from '@/lib/evm-execution';

/** User-confirmed signing only. Never signs or submits from an effect/poll/retry. */
export async function signReviewedMorpho(
  signing: MorphoSigningRequest,
  context: MorphoReviewContext,
  accountId: string,
  isCurrent: () => boolean,
) {
  // Public JSON DTOs only; copy before awaiting owner confirmation.
  const request: MorphoSigningRequest = JSON.parse(JSON.stringify(signing));
  const review: MorphoReviewContext = JSON.parse(JSON.stringify(context));
  return signReviewedEvm(
    'Morpho',
    { signer: review.signer, chainId: review.configuration.chainId },
    accountId,
    isCurrent,
    () => validateMorphoReview(request, review),
    () => morphoTransactionRequests(request),
    (token, signedTransactions) =>
      api.submitMorpho(token, request.operationId, {
        expectedVersion: request.operationVersion,
        planHash: request.planHash,
        signedTransactions,
      }),
  );
}
