import { expect, it, vi } from 'vitest';
import evidence from '../../../apps/server/tests/fixtures/across-direct-evidence.json';
import {
  acrossTransactionRequests,
  decodeAcrossDeposit,
  isAcrossSigningRequest,
  validateAcrossSigning,
} from './across-execution';
import { createApiClient } from './client';
import { acrossExecutionFixture } from './fixtures/across-execution';

it('decodes independently generated viem evidence and both exact direct selectors', () => {
  expect(decodeAcrossDeposit(evidence.calldata, '1')).toEqual(evidence.terms);
  const { signing } = acrossExecutionFixture();
  expect(decodeAcrossDeposit(signing.review.calldata, '31337', '0xabcd')).toEqual(
    signing.review.terms,
  );
  expect(
    decodeAcrossDeposit(`0x7b939232${signing.review.calldata.slice(10)}`, '31337', '0xabcd'),
  ).toEqual(signing.review.terms);
  for (const data of [
    `${signing.review.calldata}00`,
    signing.review.calldata.slice(0, -2),
    signing.review.calldata.replace('ad5425c6', '00000000'),
    signing.review.calldata.replace('1dc0deabcd73c0de', '1dc0de000073c0de'),
    `${signing.review.calldata.slice(0, 10)}1${signing.review.calldata.slice(11)}`,
  ])
    expect(() => decodeAcrossDeposit(data, '31337', '0xabcd')).toThrow();
  for (const [index, value] of [
    [8, '100000000'],
    [11, '1a0'],
    [12, '1'],
  ] as const) {
    const start = 10 + index * 64;
    const data =
      signing.review.calldata.slice(0, start) +
      value.padStart(64, '0') +
      signing.review.calldata.slice(start + 64);
    expect(() => decodeAcrossDeposit(data, '31337', '0xabcd')).toThrow();
  }
});
it('binds every financial term, approval, chain, deadline and simulation before signing', () => {
  const { signing: r, context: c } = acrossExecutionFixture();
  expect(isAcrossSigningRequest(r)).toBe(true);
  expect(() => validateAcrossSigning(r, c)).not.toThrow();
  expect(acrossTransactionRequests(r)).toMatchObject([
    { chainId: 31337, nonce: 0, value: 0n },
    { chainId: 31337, nonce: 1, value: 0n },
  ]);
  const mutations: ((v: typeof r) => void)[] = [
    (v) => {
      v.review.terms.recipient = c.signer;
    },
    (v) => {
      v.review.terms.destinationChain = '8453';
    },
    (v) => {
      v.review.terms.outputAmount = '1';
    },
    (v) => {
      v.review.terms.swapApiIntegratorId = '0x0000';
    },
    (v) => {
      v.review.quoteId = 'other';
    },
    (v) => {
      v.review.maximumNetworkFeeRaw = '1000001';
    },
    (v) => {
      v.prepared.plan.maximumSpend.recipient = c.signer;
    },
    (v) => {
      v.prepared.plan.maximumSpend.amountRaw = '2';
    },
    (v) => {
      v.prepared.plan.minimumReceive = {
        assetAddress: r.review.terms.outputToken,
        amountRaw: '990000',
        recipient: r.review.terms.recipient,
      };
    },
    (v) => {
      v.prepared.plan.feePolicyRevision = 'changed';
    },
    (v) => {
      v.prepared.plan.intentHash = 'c'.repeat(64);
    },
    (v) => {
      step(v, 0).data =
        `0x095ea7b3${r.review.sourceSpoke.slice(2).padStart(64, '0')}${'f'.repeat(64)}`;
    },
    (v) => {
      step(v, 0).to = r.review.terms.outputToken;
    },
    (v) => {
      step(v, 1).to = c.signer;
    },
    (v) => {
      step(v, 1).data += '00';
    },
    (v) => {
      v.prepared.maxPriorityFeePerGas = '4';
    },
    (v) => {
      v.prepared.gasLimits = ['100000', '300000'];
    },
    (v) => {
      v.prepared.firstNonce = '18446744073709551615';
    },
    (v) => {
      v.prepared.plan.simulation.observedAtMs = r.review.quotedAtMs - 1;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(r);
    mutate(changed);
    expect(() => validateAcrossSigning(changed, c)).toThrow();
  }
  for (const intent of [
    { quoteId: 'different' },
    { recipient: c.signer },
    { minimumOutputRaw: '990001' },
    { maximumNetworkFeeRaw: '1' },
    { deadline: String(Math.floor(Date.now() / 1000)) },
  ])
    expect(() => validateAcrossSigning(r, { ...c, intent: { ...c.intent, ...intent } })).toThrow();
});
it('allows existing allowance or finite reset/amount, never a reset without funding approval', () => {
  const { signing: r, context: c } = acrossExecutionFixture();
  const only = structuredClone(r);
  only.prepared.plan.steps.shift();
  only.prepared.gasLimits.shift();
  only.prepared.plan.maximumNetworkFeeRaw = '600000';
  expect(() => validateAcrossSigning(only, c)).not.toThrow();
  const reset = structuredClone(r);
  const first = structuredClone(step(reset, 0));
  first.data = first.data.slice(0, 74) + '0'.repeat(64);
  reset.prepared.plan.steps.unshift(first);
  reset.prepared.gasLimits.unshift('21000');
  reset.prepared.plan.maximumNetworkFeeRaw = '963000';
  expect(() => validateAcrossSigning(reset, c)).not.toThrow();
  step(r, 0).data = first.data;
  expect(() => validateAcrossSigning(r, c)).toThrow();
});
it('binds signing API response identity and sends create once with exact quoted consent', async () => {
  const { signing, context } = acrossExecutionFixture();
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(signing)));
  const api = createApiClient({ baseUrl: 'http://localhost', fetch: fetcher });
  expect(await api.acrossSigningRequest('secret', signing.operationId)).toEqual(signing);
  expect(new Headers(fetcher.mock.calls[0]?.[1].headers).get('Authorization')).toBe(
    'Bearer secret',
  );
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({ ...signing, operationId: '00000000-0000-4000-8000-000000000002' }),
    ),
  );
  await expect(api.acrossSigningRequest('secret', signing.operationId)).rejects.toThrow('identity');
  fetcher.mockReset().mockRejectedValue(new Error('ambiguous timeout'));
  await expect(api.createAcrossOperation('secret', 'stable-key', context.intent)).rejects.toThrow(
    'timeout',
  );
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[1].body).toBe(JSON.stringify(context.intent));
  expect(new Headers(fetcher.mock.calls[0]?.[1].headers).get('Idempotency-Key')).toBe('stable-key');
});

function step(r: ReturnType<typeof acrossExecutionFixture>['signing'], n: number) {
  const value = r.prepared.plan.steps[n];
  if (!value) throw new Error('missing fixture step');
  return value;
}
