import { describe, expect, it } from 'vitest';
import {
  isRelayQuoteRequest,
  projectRelayQuoteRequest,
  type RelayQuoteRequest,
} from './relay-quote';

const valid: RelayQuoteRequest = {
  user: `0x${'1'.repeat(40)}`,
  originChainId: 8453,
  destinationChainId: 1,
  originCurrency: `0x${'0'.repeat(40)}`,
  destinationCurrency: `0x${'2'.repeat(40)}`,
  amount: '1000000',
  tradeType: 'EXACT_INPUT',
};

describe('Relay quote request contract', () => {
  it('accepts the documented EVM request shape including native currency', () => {
    expect(isRelayQuoteRequest(valid)).toBe(true);
    expect(isRelayQuoteRequest({ ...valid, recipient: `0x${'3'.repeat(40)}` })).toBe(true);
  });

  it('projects only the reviewed, read-only fields', () => {
    expect(projectRelayQuoteRequest(valid)).toEqual(valid);
    expect(() =>
      projectRelayQuoteRequest({ ...valid, appFees: [{ recipient: '0x1', fee: '1' }] } as never),
    ).toThrow('Invalid Relay quote request.');
  });

  it.each([
    ['zero amount', { ...valid, amount: '0' }],
    ['non-canonical integer', { ...valid, amount: '01' }],
    ['oversized integer', { ...valid, amount: '1'.repeat(79) }],
    ['integer above uint256', { ...valid, amount: ((1n << 256n) - 1n + 1n).toString() }],
    ['unsafe chain ID', { ...valid, originChainId: Number.MAX_SAFE_INTEGER + 1 }],
    ['bad address', { ...valid, user: '0x1234' }],
    [
      'unsupported VM identifier',
      { ...valid, originCurrency: 'solana:So11111111111111111111111111111111111111112' },
    ],
    ['unknown execution option', { ...valid, txs: [{ to: `0x${'4'.repeat(40)}`, data: '0x' }] }],
  ])('rejects %s', (_label, request) => {
    expect(isRelayQuoteRequest(request)).toBe(false);
  });
});
