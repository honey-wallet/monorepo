import type { Approval } from '@honey-wallet/extension/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/vault', () => ({ privateKeyOf: vi.fn() }));

import {
  approvalReviewError,
  inspectEvmCall,
  performApproval,
  readableMessage,
  requestSolanaRpc,
  toBase64,
  typedDataReview,
} from '@/lib/dapp-sign';
import { privateKeyOf } from '@/lib/vault';

const word = (value: string) => value.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const address = '0x1234567890123456789012345678901234567890';
const transfer = `0xa9059cbb${word(address)}${word('2a')}` as `0x${string}`;

const typed = (domain: Record<string, unknown>) =>
  JSON.stringify({
    types: { 'Ma\u202Eil': [{ name: 'cont\u2066ents', type: 'string' }] },
    primaryType: 'Ma\u202Eil',
    domain,
    message: { 'cont\u2066ents': 'hello' },
  });

const approval = (kind: Approval['kind'], params: unknown) =>
  ({ id: 'request', kind, origin: 'https://example.test', params }) as Approval;

describe('dApp signing review gates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('makes bidi and invisible format characters visible in message and typed-data reviews', () => {
    const hidden = 'pay \u202E10\u2066 ETH\u2069';
    const bytes = new TextEncoder().encode(hidden);
    expect(readableMessage(bytes)).toEqual({
      text: 'pay [U+202E]10[U+2066] ETH[U+2069]',
      isText: true,
    });
    const review = typedDataReview(typed({ name: 'Ex\u202Eample' }).replace('hello', hidden));
    expect(review.domainRows).toContainEqual(['name', 'Ex[U+202E]ample']);
    expect(review.messageRows).toContainEqual([
      'cont[U+2066]ents',
      'pay [U+202E]10[U+2066] ETH[U+2069]',
    ]);
    expect(review.primaryTypeLabel).toBe('Ma[U+202E]il');
    expect(review.typed.message['cont\u2066ents']).toBe(hidden);
    expect(readableMessage(new TextEncoder().encode('café ☕'))).toEqual({
      text: 'café ☕',
      isText: true,
    });
    const hiddenTag = 'tag\u{E0061}\u{E007F}';
    expect(readableMessage(new TextEncoder().encode(hiddenTag)).text).toBe('tag[U+E0061][U+E007F]');
    expect(typedDataReview(typed({ name: 'cafe\uFE0F' })).domainRows).toContainEqual([
      'name',
      'cafe[U+FE0F]',
    ]);
  });

  it('bounds Solana broadcast RPC time and response bytes', async () => {
    const stalled = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    await expect(requestSolanaRpc('sendTransaction', ['signed'], stalled, 5)).rejects.toThrow(
      'RPC request timed out.',
    );

    let cancelled = false;
    const oversized = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body);
    });
    await expect(requestSolanaRpc('sendTransaction', ['signed'], oversized)).rejects.toThrow(
      'RPC response exceeded 16384 bytes.',
    );
    expect(cancelled).toBe(true);
  });

  it('decodes exact ERC-20 transfer arguments and rejects unknown or ambiguous effects', () => {
    expect(inspectEvmCall(transfer, address)).toMatchObject({
      reviewable: true,
      label: 'ERC-20 transfer',
      rows: [
        ['Recipient', address],
        ['Raw token units', '42'],
      ],
    });
    expect(inspectEvmCall('0xdeadbeef', address).reviewable).toBe(false);
    expect(inspectEvmCall(`0x095ea7b3${word(address)}${word('100')}`, address)).toMatchObject({
      reviewable: false,
      label: 'Ambiguous approval',
    });
    expect(
      inspectEvmCall(`0x23b872dd${word(address)}${word(address)}${word('1')}`, address).reviewable,
    ).toBe(false);
  });

  it('shows every standard EIP-712 domain field and discloses absent chain binding', () => {
    const review = typedDataReview(
      typed({
        name: 'Example',
        version: '2',
        chainId: 8453,
        verifyingContract: address,
        salt: `0x${'11'.repeat(32)}`,
      }),
    );
    expect(review.complete).toBe(true);
    expect(review.hasChainBinding).toBe(true);
    expect(review.domainRows).toEqual([
      ['name', 'Example'],
      ['version', '2'],
      ['chainId', '8453'],
      ['verifyingContract', address],
      ['salt', `0x${'11'.repeat(32)}`],
    ]);

    const unbound = typedDataReview(typed({ name: 'Example', purpose: 'looks important' }));
    expect(unbound.complete).toBe(false);
    expect(unbound.hasChainBinding).toBe(false);
    expect(unbound.domainRows).toContainEqual(['chainId', '(not set; not signed)']);
    expect(unbound.domainRows).toContainEqual(['purpose', 'looks important (not signed)']);
  });

  it('blocks opaque Solana and EVM requests before reading private key material', async () => {
    const unsupportedEvm = approval('evmSend', {
      chainId: 1,
      tx: { from: address, to: address, value: '0x0', data: '0xdeadbeef' },
    });
    expect(approvalReviewError(unsupportedEvm)).toMatch(/cannot safely decode/i);
    await expect(performApproval(unsupportedEvm, 'wallet')).rejects.toThrow(
      /cannot safely decode/i,
    );
    expect(privateKeyOf).not.toHaveBeenCalled();

    const opaqueMessage = [
      1, // required signatures
      0, // readonly signed
      1, // readonly unsigned
      2, // static keys
      ...new Uint8Array(32).fill(0x11),
      ...new Uint8Array(32), // System Program
      ...new Uint8Array(32), // blockhash
      1, // instruction count
      1, // program index
      0, // account count
      0, // empty data is not a supported System instruction
    ];
    const opaqueBytes = Uint8Array.from([1, ...new Uint8Array(64), ...opaqueMessage]);
    const opaqueSolana = approval('solanaSignTransaction', { transaction: toBase64(opaqueBytes) });
    expect(approvalReviewError(opaqueSolana)).toMatch(/safely decode/i);
    await expect(performApproval(opaqueSolana, 'wallet')).rejects.toThrow(/safely decode/i);
    expect(privateKeyOf).not.toHaveBeenCalled();
  });
});
