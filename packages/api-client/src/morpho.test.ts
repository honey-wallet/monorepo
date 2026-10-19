import { expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { morphoFixture } from './fixtures/morpho';
import {
  isMorphoSigningRequest,
  morphoIntentFromQuote,
  morphoTransactionRequests,
  validateMorphoReview,
} from './morpho';
import type { MorphoSigningRequest } from './types';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}

it.each(['deposit', 'redeem'] as const)(
  'binds %s to exact calldata, finite approvals, economics and expiry',
  (action) => {
    const { signing, context } = morphoFixture(action);
    expect(() => validateMorphoReview(signing, context)).not.toThrow();
    expect(morphoTransactionRequests(signing).map((t) => t.nonce)).toEqual([0, 1]);
    const mutations: ((s: MorphoSigningRequest) => void)[] = [
      (s) => {
        must(s.prepared.plan.steps[0]).data =
          `${must(s.prepared.plan.steps[0]).data.slice(0, -64)}${'f'.repeat(64)}`;
      },
      (s) => {
        must(s.prepared.plan.steps[1]).to = context.configuration.vault;
      },
      (s) => {
        must(s.prepared.plan.steps[1]).data += '00';
      },
      (s) => {
        s.prepared.plan.maximumSpend.amountRaw = '2';
      },
      (s) => {
        s.prepared.plan.maximumSpend.assetAddress = context.configuration.bundle;
      },
      (s) => {
        s.prepared.plan.maximumSpend.recipient = context.configuration.bundle;
      },
      (s) => {
        s.prepared.plan.expiresAtMs = Date.now() - 1;
      },
      (s) => {
        s.prepared.plan.registryRevision = 'changed';
      },
      (s) => {
        s.prepared.plan.feePolicyRevision = 'changed';
      },
      (s) => {
        s.prepared.gasLimits[0] = '21000';
      },
      (s) => {
        s.planHash = 'f'.repeat(64);
      },
      (s) => {
        s.operationVersion = '2';
      },
      (s) => {
        s.prepared.plan.minimumReceive =
          action === 'deposit'
            ? null
            : {
                assetAddress: context.configuration.asset,
                amountRaw: '1',
                recipient: context.signer,
              };
      },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(signing);
      mutate(copy);
      expect(() => validateMorphoReview(copy, context)).toThrow();
    }
    // Every ABI field is reviewed, including all permit, referral and deadline words.
    const data = must(signing.prepared.plan.steps[1]).data;
    for (let at = 10; at < data.length; at += 64) {
      const copy = structuredClone(signing);
      const old = BigInt(`0x${data.slice(at, at + 64)}`);
      must(copy.prepared.plan.steps[1]).data =
        data.slice(0, at) + (old + 1n).toString(16).padStart(64, '0') + data.slice(at + 64);
      expect(() => validateMorphoReview(copy, context)).toThrow();
    }
    expect(
      isMorphoSigningRequest({
        ...signing,
        prepared: { ...signing.prepared, plan: { ...signing.prepared.plan, provider: 'aave_v3' } },
      }),
    ).toBe(false);
  },
);

it('sizes minimum shares exactly and refuses stale quotes, wrong identities and missing redemption consent', () => {
  const now = Date.now(),
    { quote, context } = morphoFixture('deposit', now);
  const options = {
    slippageBps: 10,
    acknowledgeUnprotectedOutput: false,
    maximumNetworkFeeRaw: '1000000',
  };
  const create = (q = quote) =>
    morphoIntentFromQuote(q, context.configuration, context.signer, options, now);
  expect(create().minimumSharesRaw).toBe('999000000000000000');
  for (const change of [
    { vault: context.configuration.bundle },
    { signer: context.configuration.bundle },
    { expiresAtMs: now },
    { observedAtMs: now + 3000, expiresAtMs: now + 33000 },
    { amountRaw: '01' },
    { previewAssetsRaw: '2' },
    { registryRevision: 'new' },
  ])
    expect(() => create({ ...quote, ...change })).toThrow();
  const r = morphoFixture('redeem', now);
  expect(() =>
    morphoIntentFromQuote(r.quote, r.context.configuration, r.context.signer, options, now),
  ).toThrow();
  expect(
    morphoIntentFromQuote(
      r.quote,
      r.context.configuration,
      r.context.signer,
      { ...options, acknowledgeUnprotectedOutput: true },
      now,
    ).minimumSharesRaw,
  ).toBeNull();
  expect(() =>
    validateMorphoReview(
      r.signing,
      { ...r.context, intent: { ...r.context.intent, acknowledgeUnprotectedOutput: false } },
      now,
    ),
  ).toThrow();
});

it('uses provider-specific authenticated routes and validates quote request identity', async () => {
  const { signing, quote } = morphoFixture();
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(signing)));
  const api = createApiClient({ baseUrl: 'http://localhost:8080', fetch: fetcher });
  await api.morphoSigningRequest('secret', signing.operationId);
  const [url, init] = must(fetcher.mock.calls[0]);
  expect(String(url)).toContain(`/operations/${signing.operationId}/morpho-signing-request`);
  expect(String(url)).not.toContain('secret');
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
  fetcher.mockResolvedValue(new Response(JSON.stringify(quote)));
  await expect(api.morphoQuote('secret', { action: 'deposit', amountRaw: '2' })).rejects.toThrow();
});
