import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import {
  isNearIntentsQuotePreview,
  isNearIntentsQuoteRequest,
  isNearIntentsTokens,
} from './near-intents';

const request = {
  originAsset: 'nep141:eth.omft.near',
  destinationAsset: 'nep141:wrap.near',
  amount: '1000',
  recipient: 'receiver.near',
  slippageTolerance: 100,
};
const preview = {
  provider: 'near_intents',
  executionAvailable: false,
  originAsset: request.originAsset,
  destinationAsset: request.destinationAsset,
  amountIn: '1000',
  amountOut: '2000',
  minAmountOut: '1980',
  quotedAt: '2026-10-21T00:00:00Z',
};

describe('NEAR Intents previews', () => {
  it('rejects execution overrides, noncanonical amounts, and unsafe slippage', () => {
    expect(isNearIntentsQuoteRequest(request)).toBe(true);
    for (const patch of [
      { dry: false },
      { refundTo: 'attacker' },
      { amount: '01' },
      { amount: '0' },
      { amount: (1n << 256n).toString() },
      { slippageTolerance: 501 },
      { slippageTolerance: -1 },
    ]) {
      expect(isNearIntentsQuoteRequest({ ...request, ...patch })).toBe(false);
    }
  });

  it('rejects executable or inconsistent responses and duplicate catalog entries', () => {
    expect(isNearIntentsQuotePreview(preview)).toBe(true);
    for (const patch of [
      { depositAddress: 'attacker' },
      { executionAvailable: true },
      { amountOut: '01' },
      { minAmountOut: '2001' },
      { quotedAt: 'invalid' },
    ]) {
      expect(isNearIntentsQuotePreview({ ...preview, ...patch })).toBe(false);
    }
    const token = {
      assetId: request.originAsset,
      blockchain: 'eth',
      symbol: 'ETH',
      decimals: 18,
      contractAddress: null,
    };
    expect(isNearIntentsTokens([token])).toBe(true);
    expect(isNearIntentsTokens([token, token])).toBe(false);
  });

  it('sends bearer auth, retains the exact request, and binds response identity', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(preview)));
    const api = createApiClient({ baseUrl: 'https://api.test', fetch });
    await expect(api.nearIntentsQuotePreview('session', request)).resolves.toEqual(preview);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.test/api/v1/bridges/near-intents/quote');
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer session');
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(init?.cache).toBe('no-store');
    fetch.mockImplementation(
      async () => new Response(JSON.stringify({ ...preview, amountIn: '999' })),
    );
    await expect(api.nearIntentsQuotePreview('session', request)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    fetch.mockClear();
    await expect(
      api.nearIntentsQuotePreview('session', { ...request, amount: '0' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
