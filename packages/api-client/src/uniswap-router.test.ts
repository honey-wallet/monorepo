import { expect, it } from 'vitest';
import fixtures from './fixtures/uniswap-router.json';
import { decodeUniswapRouterCall } from './uniswap-router';

it('independently decodes pinned V2/V3/V4 and Permit2 ABI fixtures', () => {
  for (const fixture of fixtures.valid) {
    expect(decodeUniswapRouterCall(fixture.data), fixture.name).toEqual(fixture.expected);
    // Canonical tails must consume the entire input, including every array element.
    for (let end = 10; end < fixture.data.length; end += 64) {
      expect(
        () => decodeUniswapRouterCall(fixture.data.slice(0, end)),
        `${fixture.name}:${end}`,
      ).toThrow();
    }
  }
});
it('rejects authority-changing commands, ambiguous ABI and unsupported versions', () => {
  for (const fixture of fixtures.invalid) {
    expect(() => decodeUniswapRouterCall(fixture.data), fixture.name).toThrow();
  }
  for (const data of ['', '0x', '0xzz', `0x3593564c${'00'.repeat(65536)}`]) {
    expect(() => decodeUniswapRouterCall(data)).toThrow();
  }
});
it('does not confuse structural decoding with signature or economic authorization', () => {
  const first = fixtures.valid[0];
  if (!first) throw new Error('fixture');
  const decoded = decodeUniswapRouterCall(first.data);
  const permit = decoded.commands[0];
  expect(permit?.kind).toBe('permit_single');
  if (permit?.kind !== 'permit_single') throw new Error('fixture');
  // Public placeholder is not a valid wallet signature. Cryptographic verification
  // belongs to the authority layer and MUST NOT be inferred from this decoder.
  expect(permit.signature).toBe(`0x${'11'.repeat(65)}`);
});
