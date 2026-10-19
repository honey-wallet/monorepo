import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPriceSnapshot, subscribePrices } from './prices';
import type { PriceSnapshot } from './types';

const frame = (sequence = '1'): PriceSnapshot => ({
  schemaVersion: 1,
  type: 'snapshot',
  epoch: '01234567-89ab-4cde-8fab-0123456789ab',
  sequence,
  sampledAtMs: Date.now(),
  stale: false,
  source: 'hyperliquid',
  prices: (['BTC', 'ETH', 'SOL'] as const).map((symbol) => ({
    instrumentId: `hyperliquid:perp:${symbol}`,
    symbol,
    quoteUnit: 'USDT',
    price: '12345678901234567890.123456789012345678',
    kind: 'mid_or_last',
  })),
});
class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  send(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('price stream contract', () => {
  it('keeps decimal strings and rejects invalid units, symbols, sequences and numeric values', () => {
    expect(isPriceSnapshot(frame())).toBe(true);
    for (const change of [
      { quoteUnit: 'USD' },
      { price: 1 },
      { price: '1e9' },
      { price: '0' },
      { symbol: 'DOGE' },
    ]) {
      const f = frame();
      Object.assign(f.prices[0] ?? {}, change);
      expect(isPriceSnapshot(f)).toBe(false);
    }
    expect(isPriceSnapshot(frame('18446744073709551616'))).toBe(false);
    expect(isPriceSnapshot(frame('0'))).toBe(false);
  });
  it('ignores older snapshots, marks silence stale, reconnects and disposes all timers', () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const onSnapshot = vi.fn();
    const onState = vi.fn();
    const create = vi.fn(() => {
      const s = new Socket();
      sockets.push(s);
      return s as unknown as WebSocket;
    });
    const stop = subscribePrices('https://api.example', { onSnapshot, onState, webSocket: create });
    expect(create).toHaveBeenCalledWith('wss://api.example/api/v1/stream/prices');
    sockets[0]?.send(frame('2'));
    sockets[0]?.send(frame('1'));
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0]?.[0].prices[0].price).toBe(
      '12345678901234567890.123456789012345678',
    );
    vi.advanceTimersByTime(6000);
    expect(onSnapshot.mock.lastCall?.[0].stale).toBe(true);
    sockets[0]?.onclose?.();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    const reset = frame();
    reset.epoch = '11111111-1111-4111-8111-111111111111';
    sockets[1]?.send(reset);
    expect(onState).toHaveBeenLastCalledWith('live');
    stop();
    stop();
    const calls = onSnapshot.mock.calls.length;
    vi.advanceTimersByTime(120000);
    expect(create).toHaveBeenCalledTimes(2);
    expect(onSnapshot).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fails closed on malformed data and times out a connection with no snapshot', () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const onSnapshot = vi.fn();
    const stop = subscribePrices('http://localhost:8080', {
      onSnapshot,
      webSocket: () => {
        const s = new Socket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    });
    sockets[0]?.send({ token: 'unexpected' });
    expect(sockets[0]?.close).toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10000);
    expect(sockets[1]?.close).toHaveBeenCalled();
    stop();
  });
});
