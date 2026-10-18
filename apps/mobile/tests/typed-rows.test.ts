import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));

import { TYPED_ROW_LIMIT, typedRows } from '@/lib/dapp-sign';

const MAIL = {
  Person: [
    { name: 'name', type: 'string' },
    { name: 'wallet', type: 'address' },
  ],
  Mail: [
    { name: 'from', type: 'Person' },
    { name: 'to', type: 'Person' },
    { name: 'contents', type: 'string' },
  ],
};

describe('typed data shown before signing', () => {
  it('lists exactly the encoded fields, ignoring keys outside the types', () => {
    const { rows, complete } = typedRows(MAIL, 'Mail', {
      from: { name: 'Cow', wallet: '0xCD2a' },
      to: { name: 'Bob', wallet: '0xbBbB' },
      contents: 'Hello, Bob!',
      hidden: 'not signed, not shown',
    });
    expect(complete).toBe(true);
    expect(rows).toEqual([
      ['from.name', 'Cow'],
      ['from.wallet', '0xCD2a'],
      ['to.name', 'Bob'],
      ['to.wallet', '0xbBbB'],
      ['contents', 'Hello, Bob!'],
    ]);
  });

  it('stays bounded when types fan out into each other', () => {
    // Each level doubles: 2^20 leaves if walked without a budget.
    const types: Record<string, { name: string; type: string }[]> = {};
    const message: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      types[`T${i}`] = [
        { name: 'a', type: `T${i + 1}` },
        { name: 'b', type: `T${i + 1}` },
      ];
    }
    types.T20 = [{ name: 'v', type: 'uint256' }];
    const nest = (i: number): Record<string, unknown> =>
      i === 20
        ? { v: 1 }
        : (() => {
            const child = nest(i + 1);
            return { a: child, b: child };
          })();
    Object.assign(message, nest(0));
    const started = Date.now();
    const { rows, complete } = typedRows(types, 'T0', message);
    expect(complete).toBe(false);
    expect(rows.length).toBeLessThanOrEqual(TYPED_ROW_LIMIT);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('refuses anything missing or the wrong shape, and ignores inherited names', () => {
    const bad = typedRows(MAIL, 'Mail', { from: 'oops', to: null, contents: 1 });
    expect(bad.complete).toBe(false);
    expect(bad.rows).toEqual([
      ['from', '(missing)'],
      ['to', '(missing)'],
      ['contents', '1'],
    ]);
    const partial = { from: { name: 'Cow' }, to: { name: 'B', wallet: '0x1' }, contents: 'x' };
    expect(typedRows(MAIL, 'Mail', partial).complete).toBe(false);
    const list = { L: [{ name: 'xs', type: 'uint256[]' }] };
    expect(typedRows(list, 'L', { xs: 'nope' }).complete).toBe(false);
    expect(typedRows({ X: [{ name: 'p', type: 'constructor' }] }, 'X', { p: 'v' }).rows).toEqual([
      ['p', 'v'],
    ]);
  });
});
