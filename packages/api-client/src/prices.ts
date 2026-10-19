import type { PriceSnapshot } from './types';

const symbols = ['BTC', 'ETH', 'SOL'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decimal = /^\d+(?:\.\d{1,18})?$/;
export function isPriceSnapshot(value: unknown): value is PriceSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === 1 &&
    v.type === 'snapshot' &&
    v.source === 'hyperliquid' &&
    typeof v.epoch === 'string' &&
    uuid.test(v.epoch) &&
    typeof v.sequence === 'string' &&
    /^[1-9]\d{0,19}$/.test(v.sequence) &&
    BigInt(v.sequence) <= 18446744073709551615n &&
    typeof v.sampledAtMs === 'number' &&
    Number.isSafeInteger(v.sampledAtMs) &&
    v.sampledAtMs > 0 &&
    typeof v.stale === 'boolean' &&
    Array.isArray(v.prices) &&
    v.prices.length === 3 &&
    v.prices.every((p: unknown, i) => {
      if (!p || typeof p !== 'object') return false;
      const price = p as Record<string, unknown>;
      return (
        price.symbol === symbols[i] &&
        price.instrumentId === `hyperliquid:perp:${symbols[i]}` &&
        price.quoteUnit === 'USDT' &&
        price.kind === 'mid_or_last' &&
        typeof price.price === 'string' &&
        price.price.length <= 64 &&
        decimal.test(price.price) &&
        /[1-9]/.test(price.price)
      );
    })
  );
}

export type PriceConnectionState = 'connecting' | 'live' | 'stale' | 'reconnecting';
export interface PriceStreamOptions {
  onSnapshot: (snapshot: PriceSnapshot) => void;
  onState?: (state: PriceConnectionState) => void;
  /** Allows native runtimes and tests to inject their WebSocket implementation. */
  webSocket?: (url: string) => WebSocket;
}

/** One fixed public stream, no token in URL; full snapshots permit sequence gaps.
 * Returns an idempotent cleanup which prevents reconnection and future callbacks.
 */
export function subscribePrices(baseUrl: string, options: PriceStreamOptions): () => void {
  const url = new URL('/api/v1/stream/prices', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Price stream requires an HTTP(S) API origin without credentials');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const create = options.webSocket ?? ((address: string) => new WebSocket(address));
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let latest: PriceSnapshot | null = null;
  let state: PriceConnectionState | undefined;
  const setState = (next: PriceConnectionState) => {
    if (!stopped && next !== state) {
      state = next;
      options.onState?.(next);
    }
  };
  const emit = (snapshot: PriceSnapshot) => {
    const now = Date.now();
    const next = {
      ...snapshot,
      stale: snapshot.stale || snapshot.sampledAtMs > now || now - snapshot.sampledAtMs > 5000,
    };
    latest = next;
    options.onSnapshot(next);
    setState(next.stale ? 'stale' : 'live');
  };
  function connect() {
    if (stopped) return;
    setState(failures === 0 ? 'connecting' : 'reconnecting');
    let current: WebSocket;
    try {
      current = create(url.toString());
    } catch {
      schedule();
      return;
    }
    socket = current;
    let baseline: PriceSnapshot | null = null;
    const startedAt = Date.now();
    let ended = false;
    const end = () => {
      if (ended || stopped || socket !== current) return;
      ended = true;
      clearTimeout(deadline);
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      current.close();
      socket = undefined;
      if (latest && !latest.stale) emit({ ...latest, stale: true });
      if (Date.now() - startedAt > 30000) failures = 0;
      schedule();
    };
    // A successful handshake without a first valid snapshot isn't a usable feed.
    deadline = setTimeout(end, 10000);
    current.onmessage = (event) => {
      if (stopped || ended || socket !== current) return;
      let frame: unknown;
      if (typeof event.data !== 'string' || event.data.length > 8192) {
        end();
        return;
      }
      try {
        frame = JSON.parse(event.data);
      } catch {
        end();
        return;
      }
      if (!isPriceSnapshot(frame)) {
        end();
        return;
      }
      if (baseline?.epoch === frame.epoch && BigInt(frame.sequence) < BigInt(baseline.sequence))
        return;
      baseline = frame;
      clearTimeout(deadline);
      emit(frame);
    };
    current.onclose = end;
    current.onerror = end;
  }
  function schedule() {
    if (stopped) return;
    setState('reconnecting');
    const ceiling = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
    retry = setTimeout(connect, ceiling / 2 + (Math.random() * ceiling) / 2);
  }
  const freshness = setInterval(() => {
    if (
      !stopped &&
      latest &&
      !latest.stale &&
      (Date.now() - latest.sampledAtMs > 5000 || latest.sampledAtMs > Date.now())
    )
      emit(latest);
  }, 1000);
  connect();
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(retry);
    clearTimeout(deadline);
    clearInterval(freshness);
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
  };
}
