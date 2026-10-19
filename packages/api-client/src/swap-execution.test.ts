import { describe, expect, it } from 'vitest';
import source from '../../../apps/server/tests/fixtures/sealed-swap-viem.json';
import { createApiClient } from './client';
import { swapExecutionFixture as fixture, swapFixtureNow as now } from './fixtures/swap-execution';
import type { SwapReviewContext } from './swap-execution';
import {
  isSwapExecutionConfiguration,
  isSwapSigningRequest,
  swapTransactionRequests,
  validateSwapReview,
  validateSwapSigning,
} from './swap-execution';
import type { SwapSigningRequest } from './types';

describe('reviewed local swap signing', () => {
  it('binds fixed Permit2, economic calldata, exact gas and user intent', () => {
    const { r, c } = fixture();
    expect(isSwapExecutionConfiguration(c.configuration)).toBe(true);
    expect(isSwapSigningRequest(r)).toBe(true);
    expect(() => validateSwapReview(r, c, now)).not.toThrow();
    expect(() => validateSwapSigning(r, c, source.signature, now)).not.toThrow();
    const tx = swapTransactionRequests(r);
    expect(tx).toHaveLength(1);
    expect(tx[0]?.nonce).toBe(7);
    expect(tx[0]?.chainId).toBe(31337);
    expect(tx[0]?.gas).toBe(500000n);
  });
  it('rejects changed economics, identity, deadline, policy, session context and permit', () => {
    const cases: ((r: SwapSigningRequest, c: SwapReviewContext) => void)[] = [
      (r) => {
        r.review.authority.maximumInputRaw = '1001';
      },
      (r) => {
        if (r.prepared.plan.minimumReceive) r.prepared.plan.minimumReceive.amountRaw = '1899';
      },
      (r) => {
        r.prepared.plan.expiresAtMs += 1000;
      },
      (r) => {
        r.review.authority.router = `0x${'9'.repeat(40)}`;
      },
      (r) => {
        if (r.review.permit) r.review.permit.spender = `0x${'9'.repeat(40)}`;
      },
      (r) => {
        r.prepared.plan.feePolicyRevision = 'changed';
      },
      (r) => {
        r.review.authority.fees = [
          { recipient: `0x${'9'.repeat(40)}`, maximumBps: '10', maximumRoundingRaw: '1' },
        ];
      },
      (r) => {
        r.prepared.gasLimits[0] = '500001';
      },
      (r) => {
        r.prepared.plan.simulation.observedAtMs = now - 61000;
      },
      (_, c) => {
        c.signer = `0x${'9'.repeat(40)}`;
      },
      (_, c) => {
        c.reviewHash = 'd'.repeat(64);
      },
      (_, c) => {
        c.intent.maximumNetworkFeeRaw = '1';
      },
    ];
    for (const mutate of cases) {
      const { r, c } = fixture();
      mutate(r, c);
      expect(() => validateSwapSigning(r, c, source.signature, now)).toThrow();
    }
    const { r, c } = fixture();
    expect(() => validateSwapSigning(r, c, null, now)).toThrow();
    expect(() => validateSwapSigning(r, c, source.signature, now + 600000)).toThrow();
  });
  it('rejects unlimited or wrong-target approvals even when transaction shape is valid', () => {
    const { r, c } = fixture();
    const data = `0x095ea7b3${source.terms.permit2.slice(2).padStart(64, '0')}${1000n.toString(16).padStart(64, '0')}`;
    r.prepared.plan.steps.unshift({
      purpose: 'approval',
      to: source.terms.token,
      valueRaw: '0',
      data,
    });
    r.prepared.gasLimits.unshift('500000');
    r.prepared.plan.maximumNetworkFeeRaw = '2000000000000000';
    c.intent.maximumNetworkFeeRaw = r.prepared.plan.maximumNetworkFeeRaw;
    r.review.maximumNetworkFeeRaw = c.intent.maximumNetworkFeeRaw;
    expect(() => validateSwapSigning(r, c, source.signature, now)).not.toThrow();
    const first = r.prepared.plan.steps[0];
    if (first) first.data = data.slice(0, -64) + 'f'.repeat(64);
    expect(() => validateSwapSigning(r, c, source.signature, now)).toThrow();
  });
  it('uses authenticated operation-specific endpoints and rejects identity substitution', async () => {
    const { r } = fixture();
    let request: RequestInit | undefined;
    let path = '';
    const client = createApiClient({
      baseUrl: 'https://wallet.invalid',
      fetch: async (input, init) => {
        path = String(input);
        request = init;
        return new Response(JSON.stringify(r));
      },
    });
    expect(await client.swapSigningRequest('opaque', r.operationId)).toEqual(r);
    expect(path).toContain(`/operations/${r.operationId}/swap-signing-request`);
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer opaque');
    await expect(
      client.swapSigningRequest('opaque', '22222222-2222-4222-8222-222222222222'),
    ).rejects.toThrow('Operation identity mismatch');
  });
});
