import { expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { swapFixture } from './fixtures/swaps';
import {
  isSwapQuote,
  isSwapQuoteConfiguration,
  isSwapQuoteRequest,
  validateSwapQuote,
} from './swaps';

it('validates exact net output, fee conservation, slippage and review identity', () => {
  const { configuration: c, request: r, quote: q } = swapFixture();
  expect(isSwapQuoteConfiguration(c)).toBe(true);
  expect(isSwapQuote(q)).toBe(true);
  expect(() => validateSwapQuote(q, c, r, q.signer)).not.toThrow();
  for (const change of [
    { netOutputRaw: '2000000' },
    { minimumOutputRaw: '1970099' },
    { fees: [] },
    { amountInRaw: '01' },
    { executionAvailable: true },
    { approvalGasIncluded: true },
    { chainId: '10' },
    { signer: c.router },
    { registryRevision: 'changed' },
    { expiresAtMs: Date.now() - 1 },
  ]) {
    expect(() => validateSwapQuote({ ...q, ...change } as typeof q, c, r, q.signer)).toThrow();
  }
  expect(() =>
    validateSwapQuote(
      q,
      { ...c, integratorFees: [{ recipient: c.router, bps: 100 }] },
      r,
      q.signer,
    ),
  ).toThrow();
  expect(isSwapQuote({ ...q, fees: [...q.fees, ...q.fees] })).toBe(false);
});
it('sends authenticated quote reads once and rejects mismatched provider responses', async () => {
  const { request, quote } = swapFixture();
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(quote)));
  const api = createApiClient({ baseUrl: 'http://localhost:8080', fetch: fetcher });
  expect(await api.swapQuote('secret', request)).toEqual(quote);
  const first = fetcher.mock.calls[0];
  if (!first) throw new Error('missing call');
  expect(String(first[0])).toBe('http://localhost:8080/api/v1/swaps/quote');
  expect(first[1].method).toBe('POST');
  expect(first[1].cache).toBe('no-store');
  expect(new Headers(first[1].headers).get('Authorization')).toBe('Bearer secret');
  fetcher.mockResolvedValue(new Response(JSON.stringify({ ...quote, amountInRaw: '2' })));
  await expect(api.swapQuote('secret', request)).rejects.toThrow('match');
  fetcher.mockReset().mockRejectedValue(new Error('timeout'));
  await expect(api.swapQuote('secret', request)).rejects.toThrow('timeout');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('rejects the Permit2 unlimited sentinel even for exact-input quotes', () => {
  const { request } = swapFixture();
  const unlimited = (1n << 160n) - 1n;
  expect(isSwapQuoteRequest({ ...request, amountRaw: unlimited.toString() })).toBe(false);
  expect(isSwapQuoteRequest({ ...request, amountRaw: (unlimited - 1n).toString() })).toBe(true);
});
