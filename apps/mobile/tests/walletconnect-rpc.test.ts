import { describe, expect, it, vi } from 'vitest';
import { requestJsonRpc } from '@/lib/json-rpc';

vi.mock('@honey-wallet/extension/router', () => ({
  createRouter: () => ({
    fromPage: vi.fn(),
    sites: vi.fn(async () => []),
    disconnect: vi.fn(),
    pinChain: vi.fn(),
  }),
}));
vi.mock('@honey-wallet/keyring', () => ({ EVM_NETWORKS: [], readSolanaTransaction: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));
vi.mock('@reown/walletkit', () => ({ WalletKit: {}, IWalletKit: {} }));
vi.mock('@walletconnect/core', () => ({ Core: class {} }));
vi.mock('@walletconnect/utils', () => ({ buildApprovedNamespaces: vi.fn(), getSdkError: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn() }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ added: [] }) } }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

const { isBoundedWalletConnectRequest, requestRpc } = await import('@/lib/walletconnect');

describe('WalletConnect inbound request bounds', () => {
  it('allows ordinary requests and rejects oversized, deeply nested or cyclic payloads', () => {
    expect(
      isBoundedWalletConnectRequest({ method: 'solana_signMessage', params: { message: 'hello' } }),
    ).toBe(true);
    expect(
      isBoundedWalletConnectRequest({
        method: 'solana_signTransaction',
        params: { transaction: 'A'.repeat(128 * 1024) },
      }),
    ).toBe(false);

    let deeplyNested: unknown = 'payload';
    for (let i = 0; i < 34; i++) deeplyNested = { nested: deeplyNested };
    expect(
      isBoundedWalletConnectRequest({ method: 'eth_signTypedData_v4', params: deeplyNested }),
    ).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isBoundedWalletConnectRequest({ method: 'eth_signTypedData_v4', params: cyclic })).toBe(
      false,
    );
  });
});

describe('WalletConnect RPC response bounds', () => {
  it('uses bounded XHR when the React Native fetch response has no stream body', async () => {
    const originalNavigator = globalThis.navigator;
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    class NativeXhr {
      responseText = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';
      timeout = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      onprogress: ((event?: ProgressEvent) => void) | null = null;
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = vi.fn(() => this.onload?.());
      abort = vi.fn();
    }
    vi.stubGlobal('XMLHttpRequest', NativeXhr);
    const fetcher = vi.fn(async () => new Response(null));
    try {
      await expect(requestRpc('https://rpc.example', 'eth_chainId', [], fetcher)).resolves.toBe(
        '0x1',
      );
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('navigator', originalNavigator);
      vi.unstubAllGlobals();
    }
  });

  it('enforces the XHR response byte cap during progress', async () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    class OversizedXhr {
      responseText = '';
      timeout = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      onprogress: ((event?: ProgressEvent) => void) | null = null;
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = vi.fn(() => {
        this.responseText = 'x'.repeat(1025);
        this.onprogress?.({ loaded: 1025 } as ProgressEvent);
      });
      abort = vi.fn();
    }
    vi.stubGlobal('XMLHttpRequest', OversizedXhr);
    try {
      await expect(
        requestJsonRpc('https://rpc.example', 'method', [], { maxResponseBytes: 1024 }),
      ).rejects.toThrow('RPC response exceeded 1024 bytes.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('enforces the XHR timeout', async () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    class StalledXhr {
      timeout = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      onprogress: ((event?: ProgressEvent) => void) | null = null;
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = vi.fn(() => setTimeout(() => this.ontimeout?.(), this.timeout));
      abort = vi.fn();
    }
    vi.stubGlobal('XMLHttpRequest', StalledXhr);
    try {
      await expect(
        requestJsonRpc('https://rpc.example', 'method', [], { timeoutMs: 5 }),
      ).rejects.toThrow('RPC request timed out.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('aborts a request at its deadline', async () => {
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    await expect(requestRpc('https://rpc.example', 'eth_chainId', [], fetcher, 5)).rejects.toThrow(
      'RPC request timed out.',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('cancels a streamed body that exceeds the response limit', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi.fn(async () => new Response(body));

    await expect(requestRpc('https://rpc.example', 'eth_chainId', [], fetcher)).rejects.toThrow(
      'RPC response exceeded 1048576 bytes.',
    );
    expect(cancelled).toBe(true);
  });

  it('returns a JSON-RPC result and preserves provider error objects', async () => {
    const success = vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    await expect(requestRpc('https://rpc.example', 'eth_chainId', [], success)).resolves.toBe(
      '0x1',
    );

    const failure = vi.fn(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'Provider unavailable' },
      }),
    );
    await expect(
      requestRpc('https://rpc.example', 'eth_chainId', [], failure),
    ).rejects.toMatchObject({
      code: -32000,
      message: 'Provider unavailable',
    });
  });
});
