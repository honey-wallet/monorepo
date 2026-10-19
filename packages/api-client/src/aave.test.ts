import { expect, it, vi } from 'vitest';
import { aaveTransactionRequests, isAaveSigningRequest, validateAaveReview } from './aave';
import { createApiClient } from './client';
import { aaveFixture } from './fixtures/aave';
import type { AaveSigningRequest } from './types';

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing fixture value');
  return v;
}

it('binds exact approvals, calldata, identities, gas and fees to the reviewed intent', () => {
  const { signing, context } = aaveFixture();
  expect(isAaveSigningRequest(signing)).toBe(true);
  expect(() => validateAaveReview(signing, context)).not.toThrow();
  const txs = aaveTransactionRequests(signing);
  expect(txs.map((t) => t.nonce)).toEqual([0, 1]);
  expect(txs.map((t) => t.gas)).toEqual([100000n, 200000n]);
  const mutations: ((s: AaveSigningRequest) => void)[] = [
    (s) => {
      must(s.prepared.plan.steps[0]).data =
        `${must(s.prepared.plan.steps[0]).data.slice(0, -64)}${'f'.repeat(64)}`;
    },
    (s) => {
      must(s.prepared.plan.steps[1]).data =
        `${must(s.prepared.plan.steps[1]).data.slice(0, -64)}${'0'.repeat(63)}1`;
    },
    (s) => {
      must(s.prepared.plan.steps[1]).to = context.configuration.asset;
    },
    (s) => {
      s.prepared.plan.maximumSpend.amountRaw = '999999';
    },
    (s) => {
      s.prepared.plan.signer = context.configuration.pool;
    },
    (s) => {
      s.prepared.plan.maximumSpend.recipient = context.configuration.pool;
    },
    (s) => {
      s.prepared.plan.feePolicyRevision = 'unreviewed';
    },
    (s) => {
      s.operationId = '00000000-0000-4000-8000-000000000002';
    },
    (s) => {
      s.operationVersion = '2';
    },
    (s) => {
      s.prepared.gasLimits[0] = '21000';
    },
    (s) => {
      s.prepared.firstNonce = '18446744073709551615';
    },
    (s) => {
      s.prepared.maxPriorityFeePerGas = '4';
    },
    (s) => {
      s.prepared.plan.expiresAtMs = Date.now() - 1;
    },
  ];
  for (const mutate of mutations) {
    const s = structuredClone(signing);
    mutate(s);
    expect(() => validateAaveReview(s, context)).toThrow();
  }
  expect(() =>
    validateAaveReview(signing, {
      ...context,
      intent: { ...context.intent, maximumNetworkFeeRaw: '899999' },
    }),
  ).toThrow();
});
it('reviews withdrawal dust against the server-published rounding policy', () => {
  const { signing, context } = aaveFixture();
  const reviewed = structuredClone(signing);
  const nextContext = structuredClone(context);
  nextContext.configuration.maximumAtokenRoundingRaw = '3';
  nextContext.intent.action = 'withdraw';
  reviewed.prepared.gasLimits = ['200000'];
  reviewed.prepared.plan.maximumNetworkFeeRaw = '600000';
  reviewed.prepared.plan.steps = [
    {
      purpose: 'action',
      to: context.configuration.pool,
      valueRaw: '0',
      data: `0x69328dec${context.configuration.asset.slice(2).padStart(64, '0')}${BigInt(nextContext.intent.amountRaw).toString(16).padStart(64, '0')}${context.signer.slice(2).padStart(64, '0')}`,
    },
  ];
  reviewed.prepared.plan.maximumSpend = {
    assetAddress: context.configuration.aToken,
    amountRaw: '1000003',
    recipient: context.signer,
  };
  reviewed.prepared.plan.minimumReceive = {
    assetAddress: context.configuration.asset,
    amountRaw: '1000000',
    recipient: context.signer,
  };
  expect(() => validateAaveReview(reviewed, nextContext)).not.toThrow();
  nextContext.configuration.maximumAtokenRoundingRaw = '2';
  expect(() => validateAaveReview(reviewed, nextContext)).toThrow();
});
it('rejects malformed numeric input and unsafe JS nonce conversions without throwing in the guard', () => {
  const { signing } = aaveFixture();
  for (const firstNonce of ['01', '1.1', '-1', '9'.repeat(79), Number.MAX_SAFE_INTEGER + 1])
    expect(
      isAaveSigningRequest({ ...signing, prepared: { ...signing.prepared, firstNonce } }),
    ).toBe(false);
  signing.prepared.firstNonce = '9007199254740993';
  expect(isAaveSigningRequest(signing)).toBe(true);
  expect(() => aaveTransactionRequests(signing)).toThrow();
  for (const value of [null, [], {}, { prepared: null }])
    expect(isAaveSigningRequest(value)).toBe(false);
});
it('keeps bearer/idempotency headers off URLs, rejects wrong operation IDs and never retries mutations', async () => {
  const { signing } = aaveFixture();
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(signing), { status: 200 }));
  const api = createApiClient({ baseUrl: 'http://localhost:8080', fetch: fetcher });
  await api.aaveSigningRequest('secret', signing.operationId);
  const [url, init] = must(fetcher.mock.calls[0]);
  expect(url).not.toContain('secret');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret');
  expect(init.credentials).toBe('omit');
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({ ...signing, operationId: '00000000-0000-4000-8000-000000000002' }),
      { status: 200 },
    ),
  );
  await expect(api.aaveSigningRequest('secret', signing.operationId)).rejects.toThrow(
    'identity mismatch',
  );
  fetcher.mockRejectedValue(new Error('lost response'));
  await expect(
    api.createAaveOperation('secret', 'same-key', {
      action: 'supply',
      amountRaw: '1',
      maximumNetworkFeeRaw: '2',
    }),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(new Headers(must(fetcher.mock.calls[2])[1].headers).get('idempotency-key')).toBe(
    'same-key',
  );
});

it('validates typed recovery intents and rejects another operation instead of silently resuming it', async () => {
  const { isAaveIntentRecovery } = await import('./aave');
  const { context } = aaveFixture();
  const value = {
    operationId: context.operationId,
    signer: context.signer,
    chainId: '31337',
    asset: context.configuration.asset,
    registryRevision: 'test',
    feePolicyRevision: 'test-zero',
    intent: context.intent,
  };
  expect(isAaveIntentRecovery(value)).toBe(true);
  for (const change of [
    { amountRaw: 0 },
    { amountRaw: '0' },
    { amountRaw: ((1n << 256n) - 1n).toString() },
    { maximumNetworkFeeRaw: '0' },
    { action: 'transfer' },
  ])
    expect(isAaveIntentRecovery({ ...value, intent: { ...value.intent, ...change } })).toBe(false);
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ ...value, operationId: '00000000-0000-4000-8000-000000000002' }),
        { status: 200 },
      ),
    );
  await expect(
    createApiClient({ baseUrl: 'https://api.example', fetch: fetcher }).aaveIntent(
      'token',
      value.operationId,
    ),
  ).rejects.toThrow('identity mismatch');
});
