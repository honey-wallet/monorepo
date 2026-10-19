import { expect, it, vi } from 'vitest';
import {
  isAcrossConfiguration,
  isAcrossQuote,
  isAcrossQuoteRequest,
  validateAcrossQuote,
} from './across';
import { createApiClient } from './client';
import { acrossFixture } from './fixtures/across';

it('binds a direct quote to the route, session, economics, refund and deadlines', () => {
  const { configuration: c, request: r, quote: q } = acrossFixture();
  expect(isAcrossConfiguration(c)).toBe(true);
  expect(isAcrossQuoteRequest(r)).toBe(true);
  expect(isAcrossQuote(q)).toBe(true);
  expect(() => validateAcrossQuote(q, c, r, q.sender)).not.toThrow();
  expect(
    isAcrossConfiguration({
      ...c,
      routes: c.routes.map((route) => ({
        ...route,
        outputToken: { ...route.outputToken, symbol: 'USDC.e' },
      })),
    }),
  ).toBe(true);
  expect(
    isAcrossConfiguration({
      ...c,
      routes: c.routes.map((route) => ({
        ...route,
        outputToken: { ...route.outputToken, assetId: 'usdc.e' },
      })),
    }),
  ).toBe(false);
  expect(
    isAcrossConfiguration({
      ...c,
      routes: c.routes.map((route) => ({
        ...route,
        outputToken: { ...route.outputToken, assetId: undefined },
      })),
    }),
  ).toBe(false);
  for (const change of [
    { expectedFillSeconds: 0 },
    { expectedFillSeconds: 1801 },
    { routeId: 'changed' },
    { registryRevision: 'changed' },
    { integratorId: '0x0000' },
    { sender: q.inputToken },
    { recipient: q.inputToken },
    { sourceChainId: '10' },
    { destinationChainId: '10' },
    { inputToken: q.outputToken },
    { outputToken: q.inputToken },
    { inputAmountRaw: '01' },
    { minimumOutputRaw: '980000' },
    { bridgeFeeRaw: '0' },
    { integratorFeeRaw: '1' },
    { refundChainId: '8453' },
    { refundRecipient: q.inputToken },
    { sourceGasEstimateRaw: '2000001' },
    { executionAvailable: true },
    { approvalGasIncluded: true },
    { exclusivityParameter: '61' },
    { expiresAtMs: q.receivedAtMs },
    { receivedAtMs: q.receivedAtMs + 60000, expiresAtMs: q.receivedAtMs + 90000 },
    { fillDeadline: (Number(q.quoteTimestamp) + 4000).toString() },
    { quoteTimestamp: (Number(q.quoteTimestamp) - 301).toString() },
  ])
    expect(() => validateAcrossQuote({ ...q, ...change } as typeof q, c, r, q.sender)).toThrow();
  expect(() => validateAcrossQuote(q, c, { ...r, minimumOutputRaw: '999999' }, q.sender)).toThrow();
  expect(() =>
    validateAcrossQuote(
      q,
      { ...c, routes: c.routes.map((route) => ({ ...route, maximumBridgeFeeBps: 99 })) },
      r,
      q.sender,
    ),
  ).toThrow();
  expect(() => validateAcrossQuote(q, c, r, q.sender, q.expiresAtMs)).toThrow();
});
it('rejects malformed registry routes and request fields before HTTP', async () => {
  const { configuration: c, request: r } = acrossFixture();
  expect(isAcrossConfiguration({ ...c, routes: [...c.routes, ...c.routes] })).toBe(false);
  expect(isAcrossConfiguration({ ...c, routes: [] })).toBe(false);
  expect(isAcrossConfiguration({ ...c, sourceChainId: '9007199254740992' })).toBe(false);
  expect(
    isAcrossConfiguration({
      ...c,
      routes: c.routes.map((route) => ({
        ...route,
        outputToken: { ...route.outputToken, decimals: 18 },
      })),
    }),
  ).toBe(false);
  const fetcher = vi.fn();
  const api = createApiClient({ baseUrl: 'http://localhost', fetch: fetcher });
  for (const change of [
    { sender: r.recipient },
    { amountRaw: '01' },
    { minimumOutputRaw: '0' },
    { minimumOutputRaw: '1000001' },
    { recipient: '0x0' },
  ])
    await expect(api.acrossQuote('secret', { ...r, ...change })).rejects.toThrow('Invalid');
  expect(fetcher).not.toHaveBeenCalled();
});
it('sends authenticated quote reads once, propagates cancellation and rejects identity changes', async () => {
  const { request, quote, configuration } = acrossFixture();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(configuration)))
    .mockResolvedValueOnce(new Response(JSON.stringify(quote)));
  const api = createApiClient({ baseUrl: 'http://localhost', fetch: fetcher });
  expect(await api.acrossConfiguration()).toEqual(configuration);
  const abort = new AbortController();
  expect(await api.acrossQuote('secret', request, { signal: abort.signal })).toEqual(quote);
  const call = fetcher.mock.calls[1];
  expect(call?.[0]).toBe('http://localhost/api/v1/bridges/across/quote');
  expect(call?.[1]).toMatchObject({
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify(request),
    signal: abort.signal,
  });
  expect(new Headers(call?.[1].headers).get('Authorization')).toBe('Bearer secret');
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ ...quote, recipient: quote.inputToken })),
  );
  await expect(api.acrossQuote('secret', request)).rejects.toThrow('match');
  fetcher.mockReset().mockRejectedValue(new Error('timeout'));
  await expect(api.acrossQuote('secret', request)).rejects.toThrow('timeout');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('never lets local TTL extend provider freshness, fill safety or relative exclusivity', () => {
  const now = 1800000000000;
  const { configuration: c, request: r, quote: q } = acrossFixture(now);
  const seconds = now / 1000;
  for (const changed of [
    { ...q, quoteTimestamp: String(seconds - 290) },
    { ...q, fillDeadline: String(seconds + 40) },
    { ...q, fillDeadline: String(seconds + 80), exclusivityParameter: '60' },
  ])
    expect(() => validateAcrossQuote(changed, c, r, q.sender, now)).toThrow();
  expect(() =>
    validateAcrossQuote(
      { ...q, quoteTimestamp: String(seconds - 290), expiresAtMs: now + 10000 },
      c,
      r,
      q.sender,
      now,
    ),
  ).not.toThrow();
  expect(() =>
    validateAcrossQuote(
      {
        ...q,
        fillDeadline: String(seconds + 80),
        exclusivityParameter: '60',
        expiresAtMs: now + 20000,
      },
      c,
      r,
      q.sender,
      now,
    ),
  ).not.toThrow();
});
