import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('createApiClient', () => {
  it('requests the versioned endpoint and parses JSON', async () => {
    const fetch = mockFetch(200, { name: 'honey-server', version: '0.1.0' });
    const api = createApiClient({ baseUrl: 'http://api.test/', fetch });

    await expect(api.version()).resolves.toEqual({ name: 'honey-server', version: '0.1.0' });
    expect(fetch).toHaveBeenCalledWith('http://api.test/api/v1/version', expect.anything());
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
        headers: expect.objectContaining({ 'X-Pair-Token': 'secret' }),
      }),
    );
    await expect(api.pairReceive(pair, 'commit')).resolves.toBeNull();
    await expect(api.pairReceive(pair, 'commit')).resolves.toEqual({ data: 'abc' });
    expect(fetch).toHaveBeenLastCalledWith(
      'http://api.test/api/v1/pairing/chan/commit',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Pair-Token': 'secret' }) }),
    );
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
});
