import type { Approval } from '@honey-wallet/extension/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getTransactionCount: vi.fn(),
  estimateGas: vi.fn(),
  estimateFeesPerGas: vi.fn(),
  getGasPrice: vi.fn(),
  sendRawTransaction: vi.fn(),
  createPublicClient: vi.fn(),
  http: vi.fn(),
  privateKeyOf: vi.fn(),
  signEvmTransaction: vi.fn(),
}));

vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: m.createPublicClient,
  http: m.http,
}));
vi.mock('@/lib/vault', () => ({ privateKeyOf: m.privateKeyOf }));
vi.mock('@honey-wallet/keyring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@honey-wallet/keyring')>()),
  signEvmTransaction: m.signEvmTransaction,
}));

import { type EvmTx, performApproval, prepareEvmSend } from '@/lib/dapp-sign';

const address = '0x1234567890123456789012345678901234567890';
const tx: EvmTx = { from: address, to: address, value: '0x1', data: '0x' };
const request = (transaction: EvmTx = tx) =>
  ({
    id: 'request',
    kind: 'evmSend',
    origin: 'https://example.test',
    params: { chainId: 1, tx: transaction },
  }) as Approval;

beforeEach(() => {
  vi.resetAllMocks();
  const client = {
    getTransactionCount: m.getTransactionCount.mockResolvedValue(7n),
    estimateGas: m.estimateGas.mockResolvedValue(21_000n),
    estimateFeesPerGas: m.estimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    getGasPrice: m.getGasPrice.mockResolvedValue(2_000_000_000n),
    sendRawTransaction: m.sendRawTransaction.mockResolvedValue(`0x${'11'.repeat(32)}`),
  };
  m.createPublicClient.mockReturnValue(client);
  m.http.mockReturnValue({});
  m.privateKeyOf.mockResolvedValue(new Uint8Array(32).fill(7));
  m.signEvmTransaction.mockResolvedValue('0xdead');
});

describe('EVM dapp fee consent', () => {
  it('refuses to sign or read key material without the preparation shown in review', async () => {
    await expect(performApproval(request(), 'wallet')).rejects.toThrow(
      /review the transaction again/i,
    );
    expect(m.privateKeyOf).not.toHaveBeenCalled();
    expect(m.signEvmTransaction).not.toHaveBeenCalled();
  });

  it('signs and broadcasts the exact fee-capped transaction that was prepared for review', async () => {
    m.estimateFeesPerGas
      .mockResolvedValueOnce({
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      })
      .mockResolvedValueOnce({
        maxFeePerGas: 8_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
      });
    const prepared = await prepareEvmSend(tx, 1);
    expect(prepared.maxFee).toBe(50_400_000_000_000n);

    const answer = await performApproval(request(), 'wallet', prepared);

    expect(answer).toEqual({ id: 'request', result: `0x${'11'.repeat(32)}` });
    expect(m.estimateFeesPerGas).toHaveBeenCalledOnce();
    expect(m.signEvmTransaction).toHaveBeenCalledWith(expect.any(Uint8Array), prepared.unsigned);
    expect(m.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: '0xdead' });
  });

  it('rejects a changed request before reading the private key', async () => {
    const prepared = await prepareEvmSend(tx, 1);
    await expect(
      performApproval(request({ ...tx, value: '0x2' }), 'wallet', prepared),
    ).rejects.toThrow(/review the transaction again/i);
    expect(m.privateKeyOf).not.toHaveBeenCalled();
    expect(m.signEvmTransaction).not.toHaveBeenCalled();
  });
});
