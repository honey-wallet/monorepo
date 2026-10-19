import { ERR, type ProviderError } from './protocol';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_048_576;

type RpcBody = { result?: unknown; error?: ProviderError };

/** A bounded JSON-RPC transport for untrusted dApp read requests. */
export function createRpcClient(fetcher: typeof fetch = fetch) {
  return async (url: string, method: string, params: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      const declaredLength = Number(res.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw ERR.internal;
      }
      if (!res.body) throw ERR.internal;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw ERR.internal;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let body: RpcBody;
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as RpcBody;
      } catch {
        throw ERR.internal;
      }
      if (body.error) {
        if (typeof body.error.code !== 'number' || typeof body.error.message !== 'string') {
          throw ERR.internal;
        }
        throw body.error;
      }
      return body.result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw { ...ERR.internal, message: 'The network read timed out. Try again.' };
      }
      if (error === ERR.internal || (error && typeof error === 'object' && 'code' in error)) {
        throw error;
      }
      throw { ...ERR.internal, message: 'Couldn’t reach the network. Try again.' };
    } finally {
      clearTimeout(timer);
    }
  };
}
