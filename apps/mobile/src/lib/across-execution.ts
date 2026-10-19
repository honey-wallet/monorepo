import {
  type AcrossReviewContext,
  type AcrossSigningRequest,
  acrossTransactionRequests,
  validateAcrossSigning,
} from '@honey-wallet/api-client';
import { api } from '@/lib/api';
import { signReviewedEvm } from '@/lib/evm-execution';

/** Explicit review confirmation only. Copies immutable display terms before any await. */
export async function signReviewedAcross(
  signing: AcrossSigningRequest,
  context: AcrossReviewContext,
  accountId: string,
  isCurrent: () => boolean,
) {
  const request: AcrossSigningRequest = JSON.parse(JSON.stringify(signing));
  const review: AcrossReviewContext = JSON.parse(JSON.stringify(context));
  return signReviewedEvm(
    'Across',
    { signer: review.signer, chainId: review.configuration.quote.sourceChainId },
    accountId,
    isCurrent,
    () => validateAcrossSigning(request, review),
    () => acrossTransactionRequests(request),
    (token, signedTransactions) =>
      api.submitAcross(token, request.operationId, {
        expectedVersion: request.operationVersion,
        planHash: request.planHash,
        signedTransactions,
      }),
  );
}
