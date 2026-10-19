import { describe, expect, it, vi } from 'vitest';
import { ERR } from './protocol';
import { createRpcClient } from './rpc';

const jsonResponse = (body: string, headers?: HeadersInit) =>
  new Response(body, {
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  });

describe('bounded JSON-RPC transport', () => {
  it('parses a valid result and preserves provider errors', async () => {
    const client = createRpcClient(async () => jsonResponse('{"result":"0x2a"}'));
    await expect(client('https://rpc.example', 'eth_blockNumber', [])).resolves.toBe('0x2a');
    const failed = createRpcClient(async () =>
      jsonResponse('{"error":{"code":-32000,"message":"busy"}}'),
    );
    await expect(failed('https://rpc.example', 'eth_call', [])).rejects.toEqual({
      code: -32000,
      message: 'busy',
    });
  });

  it('rejects an oversized declared or streamed response', async () => {
    const declared = createRpcClient(async () =>
      jsonResponse('{}', { 'content-length': '1048577' }),
    );
    await expect(declared('https://rpc.example', 'eth_call', [])).rejects.toEqual(ERR.internal);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(500_000));
        controller.close();
      },
    });
    const streamed = createRpcClient(async () => new Response(stream));
    await expect(streamed('https://rpc.example', 'eth_call', [])).rejects.toEqual(ERR.internal);
  });

  it('aborts requests after the fixed deadline', async () => {
    vi.useFakeTimers();
    try {
      const client = createRpcClient(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      );
      const request = client('https://rpc.example', 'eth_call', []);
      const rejected = expect(request).rejects.toMatchObject({
        message: 'The network read timed out. Try again.',
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
