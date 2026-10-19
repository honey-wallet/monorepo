import source from '../../../../apps/server/tests/fixtures/sealed-swap-viem.json';
import type { SwapReviewContext } from '../swap-execution';
import type { SwapSigningRequest } from '../types';
export const swapFixtureNow = 1900000000000;
export function swapExecutionFixture() {
  const p = structuredClone(source.prepared) as SwapSigningRequest['prepared'];
  const r: SwapSigningRequest = {
    operationId: '11111111-1111-4111-8111-111111111111',
    operationVersion: '3',
    planHash: 'a'.repeat(64),
    prepared: p,
    reviewHash: 'b'.repeat(64),
    review: {
      schemaVersion: 1,
      intentHash: p.plan.intentHash,
      quoteId: 'synthetic-quote',
      providerQuoteHash: 'c'.repeat(64),
      registryRevision: p.plan.registryRevision,
      feePolicyRevision: p.plan.feePolicyRevision,
      authority: {
        chainId: '31337',
        owner: p.plan.signer,
        router: source.terms.spender,
        tokenIn: source.terms.token,
        tokenOut: p.plan.minimumReceive?.assetAddress as string,
        maximumInputRaw: '1000',
        minimumOutputRaw: '1900',
        deadline: source.terms.sigDeadline,
        feeBasis: 'settlement_balance',
        tokens: [source.terms.token, p.plan.minimumReceive?.assetAddress as string],
        fees: [],
      },
      permit2: source.terms.permit2,
      permit: structuredClone(source.terms),
      maximumNetworkFeeRaw: p.plan.maximumNetworkFeeRaw,
      quoteObservedAtMs: swapFixtureNow,
      reviewedAtMs: swapFixtureNow,
      expiresAtMs: p.plan.expiresAtMs,
    },
  };
  const c: SwapReviewContext = {
    configuration: {
      mode: 'local_fork',
      quote: {
        provider: 'uniswap',
        chainId: '31337',
        router: source.terms.spender,
        permit2: source.terms.permit2,
        routerVersion: '2.1.2',
        tokens: r.review.authority.tokens.map((address, n) => ({
          address,
          symbol: n ? 'OUT' : 'IN',
          decimals: 6,
        })),
        integratorFees: [],
        registryRevision: p.plan.registryRevision,
        feePolicyRevision: p.plan.feePolicyRevision,
        executionAvailable: false,
      },
      maximumFeeRoundingRaw: '0',
    },
    intent: {
      tokenIn: source.terms.token,
      tokenOut: r.review.authority.tokenOut,
      amountRaw: '1000',
      slippageBps: '500',
      minimumOutputRaw: '1900',
      deadline: source.terms.sigDeadline,
      maximumNetworkFeeRaw: p.plan.maximumNetworkFeeRaw,
    },
    signer: p.plan.signer,
    operationId: r.operationId,
    reviewHash: r.reviewHash,
  };
  return { r, c };
}
