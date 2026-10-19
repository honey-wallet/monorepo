type JsonRpcError = { code: number; message: string; data?: unknown };

type JsonRpcResponse = { result?: unknown; error?: JsonRpcError };

type JsonRpcRequestOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

function parseResponse(text: string): unknown {
  const body = JSON.parse(text) as JsonRpcResponse;
  if (body.error) throw body.error;
  return body.result;
}

function requestWithXhr(
  url: string,
  payload: string,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      xhr.onload = null;
      xhr.onerror = null;
      xhr.ontimeout = null;
      xhr.onabort = null;
      xhr.onprogress = null;
      if (error !== undefined) reject(error);
      else resolve(result);
    };
    const checkSize = (event?: ProgressEvent) => {
      // ProgressEvent.loaded is the transferred byte count and avoids repeatedly
      // encoding the entire growing responseText on every progress notification.
      if (typeof event?.loaded === 'number' && event.loaded > maxResponseBytes) {
        xhr.abort();
        finish(new Error(`RPC response exceeded ${maxResponseBytes} bytes.`));
      }
    };
    xhr.open('POST', url, true);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onprogress = checkSize;
    xhr.onerror = () => finish(new Error('RPC request failed.'));
    xhr.ontimeout = () => finish(new Error('RPC request timed out.'));
    xhr.onabort = () => finish(new Error('RPC request aborted.'));
    xhr.onload = () => {
      if (new TextEncoder().encode(xhr.responseText ?? '').byteLength > maxResponseBytes) {
        xhr.abort();
        finish(new Error(`RPC response exceeded ${maxResponseBytes} bytes.`));
        return;
      }
      if (settled) return;
      try {
        finish(undefined, parseResponse(xhr.responseText ?? ''));
      } catch (error) {
        finish(error);
      }
    };
    xhr.send(payload);
  });
}

/** Shared bounded JSON-RPC transport for wallet-controlled provider calls. */
export async function requestJsonRpc(
  url: string,
  method: string,
  params: unknown,
  { fetcher = fetch, timeoutMs = 15_000, maxResponseBytes = 1_048_576 }: JsonRpcRequestOptions = {},
): Promise<unknown> {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const nativeNavigator = globalThis.navigator as Navigator & { product?: string };
  if (nativeNavigator?.product === 'ReactNative') {
    return requestWithXhr(url, payload, timeoutMs, maxResponseBytes);
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxResponseBytes) {
      controller.abort();
      void res.body?.cancel().catch(() => {});
      throw new Error(`RPC response exceeded ${maxResponseBytes} bytes.`);
    }
    if (!res.body) {
      // Never replay a request through XHR after Fetch has sent it: the first
      // response may have been lost after a mutating RPC was accepted.
      throw new Error('RPC response stream is unavailable.');
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) {
          controller.abort();
          void reader.cancel().catch(() => {});
          throw new Error(`RPC response exceeded ${maxResponseBytes} bytes.`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parseResponse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (timedOut) throw new Error('RPC request timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
