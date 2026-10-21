import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, isFeatureAvailable } from './client';

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

describe('createApiClient', () => {
  it('requests an authenticated Relay preview with exact input fields and rejects executable response fields', async () => {
    const request = {
      user: '0x0000000000000000000000000000000000000001',
      originChainId: 1,
      destinationChainId: 10,
      originCurrency: '0x0000000000000000000000000000000000000000',
      destinationCurrency: '0x0000000000000000000000000000000000000000',
      amount: '100',
      tradeType: 'EXACT_INPUT' as const,
    };
    const fetch = mockFetch(200, {
      provider: 'relay',
      requestId: 'quote-1',
      executionAvailable: false,
      steps: [
        {
          index: 0,
          id: 'deposit',
          kind: 'transaction',
          action: 'Review',
          description: 'Deposit',
          itemCount: 1,
        },
      ],
    });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });

    await expect(
      api.relayQuotePreview('opaque-token', request, {
        headers: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' },
      }),
    ).resolves.toMatchObject({
      executionAvailable: false,
      steps: [{ index: 0, id: 'deposit' }],
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://api.test/api/v1/relay/quote',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        body: JSON.stringify(request),
      }),
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer opaque-token',
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('traceparent')).toBe(
      '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    );

    const unsafe = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(200, {
        provider: 'relay',
        requestId: 'quote-1',
        executionAvailable: false,
        steps: [
          {
            index: 0,
            id: 'deposit',
            kind: 'transaction',
            action: 'Review',
            description: 'Deposit',
            itemCount: 1,
            data: { to: '0xdead' },
          },
        ],
      }),
    });
    await expect(unsafe.relayQuotePreview('opaque-token', request)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('reads the authenticated Hyperliquid state with bearer auth and no address selector', async () => {
    const fetch = mockFetch(200, {
      schemaVersion: 1,
      venue: 'hyperliquid',
      account: '0x0000000000000000000000000000000000000001',
      fetchedAtMs: 1760000000000,
      state: {
        marginSummary: {
          accountValue: '0.0',
          totalNtlPos: '0.0',
          totalRawUsd: '0.0',
          totalMarginUsed: '0.0',
        },
        crossMarginSummary: {
          accountValue: '0.0',
          totalNtlPos: '0.0',
          totalRawUsd: '0.0',
          totalMarginUsed: '0.0',
        },
        crossMaintenanceMarginUsed: '0.0',
        withdrawable: '0.0',
        assetPositions: [],
        time: 1760000000000,
      },
    });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });

    await expect(api.hyperliquidPerpsAccount('opaque-token')).resolves.toMatchObject({
      venue: 'hyperliquid',
      state: { assetPositions: [] },
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://api.test/api/v1/perps/hyperliquid/account',
      expect.objectContaining({
        credentials: 'omit',
      }),
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer opaque-token',
    );
  });

  it('requests the versioned endpoint and parses JSON', async () => {
    const fetch = mockFetch(200, { name: 'honey-server', version: '0.1.0' });
    const api = createApiClient({ baseUrl: 'http://api.test/', fetch });

    await expect(api.version()).resolves.toEqual({ name: 'honey-server', version: '0.1.0' });
    expect(fetch).toHaveBeenCalledWith('http://api.test/api/v1/version', expect.anything());
  });

  it('joins the waitlist with a JSON POST', async () => {
    const fetch = mockFetch(200, { status: 'joined' });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });

    await expect(api.joinWaitlist('ada@example.com')).resolves.toEqual({ status: 'joined' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/api/v1/waitlist');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'ada@example.com', source: 'web' });
  });

  it('throws ApiError with the server error code', async () => {
    const fetch = mockFetch(404, { error: { code: 'not_found', message: 'resource not found' } });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });

    const error = await api.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('sends and receives pairing messages, null while waiting', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'not_found', message: '' } }), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: 'abc' }), { status: 200 }));
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });

    const pair = { channel: 'chan', token: 'secret' };

    await api.pairSend(pair, 'commit', { data: 'abc' });
    expect(fetch).toHaveBeenCalledWith(
      'http://api.test/api/v1/pairing/chan/commit',
      expect.objectContaining({
        method: 'PUT',
        body: '{"data":"abc"}',
        headers: expect.any(Headers),
      }),
    );
    await expect(api.pairReceive(pair, 'commit')).resolves.toBeNull();
    await expect(api.pairReceive(pair, 'commit')).resolves.toEqual({ data: 'abc' });
    expect(fetch).toHaveBeenLastCalledWith(
      'http://api.test/api/v1/pairing/chan/commit',
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-pair-token')).toBe('secret');
    expect(new Headers(fetch.mock.lastCall?.[1]?.headers).get('x-pair-token')).toBe('secret');
  });

  it('falls back when the error body is JSON in another shape', async () => {
    const fetch = mockFetch(404, { message: 'Cannot GET /api/v1/pairing' });
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });

    await expect(api.health()).rejects.toMatchObject({ status: 404, code: 'unknown' });
  });

  it('falls back when the error body is not JSON', async () => {
    const fetch = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });

    await expect(api.health()).rejects.toMatchObject({ status: 502, code: 'unknown' });
  });

  it('exposes correlation and retry metadata without retrying a request', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'busy', message: 'Busy' } }), {
          status: 503,
          headers: {
            'x-request-id': 'request-123',
            'retry-after': '2',
            'x-trace-id': '0123456789abcdef0123456789abcdef',
          },
        }),
    );
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await expect(api.health()).rejects.toMatchObject({
      requestId: 'request-123',
      traceId: '0123456789abcdef0123456789abcdef',
      retryAfterMs: 2000,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves Headers and tuple inputs while binding the pairing token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ data: 'ok' })),
    );
    const api = createApiClient({ baseUrl: 'http://api.test', fetch });
    await api.version({ headers: new Headers({ Authorization: 'Bearer test' }) });
    expect(new Headers(fetch.mock.lastCall?.[1]?.headers).get('authorization')).toBe('Bearer test');
    await api.pairReceive({ channel: 'channel', token: 'right-token' }, 'commit', {
      headers: [
        ['x-pair-token', 'wrong-token'],
        ['x-custom', 'present'],
      ],
    });
    const headers = new Headers(fetch.mock.lastCall?.[1]?.headers);
    expect(headers.get('x-pair-token')).toBe('right-token');
    expect(headers.get('x-custom')).toBe('present');
  });

  it('validates capabilities and treats unknown or missing features as unavailable', async () => {
    const capabilities = {
      schemaVersion: 3 as const,
      features: [
        {
          id: 'swap',
          available: false,
          scope: 'unavailable' as const,
          reason: 'not_configured',
          providers: ['uniswap'],
          configuredProviders: [],
        },
      ],
    };
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(200, capabilities),
    });
    expect(await api.capabilities()).toEqual(capabilities);
    expect(isFeatureAvailable(capabilities, 'swap')).toBe(false);
    expect(isFeatureAvailable(capabilities, 'unknown')).toBe(false);
    expect(isFeatureAvailable(null, 'swap')).toBe(false);
    const invalid = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(200, {
        schemaVersion: 3,
        features: [{ id: 'swap', available: 'true', scope: 'unavailable' }],
      }),
    });
    await expect(invalid.capabilities()).rejects.toMatchObject({ code: 'invalid_response' });
    const unknownScope = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(200, {
        schemaVersion: 3,
        features: [
          {
            id: 'swap',
            available: true,
            scope: 'experimental',
            reason: 'preview',
            providers: ['uniswap'],
            configuredProviders: [],
          },
        ],
      }),
    });
    await expect(unknownScope.capabilities()).rejects.toMatchObject({ code: 'invalid_response' });
    const inconsistentScope = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(200, {
        schemaVersion: 3,
        features: [
          {
            id: 'swap',
            available: true,
            scope: 'local_testnet',
            reason: 'local_testnet_only',
            providers: ['uniswap'],
            configuredProviders: [],
          },
        ],
      }),
    });
    await expect(inconsistentScope.capabilities()).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const missingConfiguredProviders = createApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(200, {
        schemaVersion: 3,
        features: [
          {
            id: 'bridge_quotes',
            available: true,
            scope: 'read_only',
            reason: 'quote_preview_only',
            providers: ['relay', 'near_intents'],
          },
        ],
      }),
    });
    await expect(missingConfiguredProviders.capabilities()).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
