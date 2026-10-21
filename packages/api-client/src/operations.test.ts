import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { isOperationRecovery } from './operations';
import type { OperationRecovery } from './types';

const id = '4c027d92-d1b5-4678-98fe-baf70453f6c1';
function recovery(): OperationRecovery {
  return {
    operation: {
      id,
      walletId: '226d9165-1bde-42a7-a17c-7dab0c03237c',
      action: 'earn',
      state: 'awaiting_signature',
      version: '9007199254740993',
    },
    intentAvailable: true,
    preparation: {
      hash: 'a'.repeat(64),
      provider: 'aave_v3',
      chainId: '1',
      expiresAtMs: 1792310000000,
      expired: true,
      stepCount: 2,
      registryRevision: 'test-v1',
      feePolicyRevision: 'test-v1',
    },
    executionAvailable: false,
    submission: null,
    reconciliation: null,
  };
}
describe('durable operation recovery', () => {
  it('distinguishes pre-build swap consent from a signed transaction', () => {
    for (const state of ['awaiting_permit', 'building_swap'] as const) {
      const r = recovery();
      r.operation.action = 'swap';
      r.operation.state = state;
      r.preparation = null;
      expect(isOperationRecovery(r)).toBe(true);
      expect(isOperationRecovery({ ...r, operation: { ...r.operation, action: 'earn' } })).toBe(
        false,
      );
      expect(
        isOperationRecovery({
          ...r,
          preparation: { ...recovery().preparation, provider: 'uniswap' },
        }),
      ).toBe(false);
      expect(
        isOperationRecovery({
          ...r,
          submission: { operationId: id, transactionHashes: [`0x${'a'.repeat(64)}`] },
        }),
      ).toBe(false);
    }
  });
  it('preserves bigint versions and accepts expired evidence without making it executable', () => {
    expect(isOperationRecovery(recovery())).toBe(true);
    expect(isOperationRecovery({ ...recovery(), executionAvailable: true })).toBe(false);
    expect(isOperationRecovery({ ...recovery(), intentAvailable: false })).toBe(false);
    const result = recovery();
    result.preparation = null;
    result.intentAvailable = false;
    expect(isOperationRecovery(result)).toBe(true);
  });
  it('rejects malformed or cross-action evidence', () => {
    const result = recovery();
    for (const operation of [
      { version: 1 },
      { version: '01' },
      { version: '9223372036854775808' },
      { state: 'approved' },
      { action: 'swap' },
      { id: '../auth/session' },
    ]) {
      expect(
        isOperationRecovery({ ...result, operation: { ...result.operation, ...operation } }),
      ).toBe(false);
    }
    for (const preparation of [
      { stepCount: 9 },
      { chainId: 1 },
      { chainId: '01' },
      { hash: 'wrong' },
      { expiresAtMs: Infinity },
      { provider: 'unknown' },
      { feePolicyRevision: 'untrusted\ntext' },
    ]) {
      expect(
        isOperationRecovery({ ...result, preparation: { ...result.preparation, ...preparation } }),
      ).toBe(false);
    }
  });
  it('recovers exact signed transaction identifiers without treating them as receipts', () => {
    const result = recovery();
    result.operation.state = 'signed';
    expect(isOperationRecovery(result)).toBe(false);
    result.submission = {
      operationId: id,
      transactionHashes: [`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`],
    };
    expect(isOperationRecovery(result)).toBe(true);
    for (const submission of [
      undefined,
      { ...result.submission, operationId: result.operation.walletId },
      { ...result.submission, transactionHashes: ['not-a-hash'] },
      { ...result.submission, transactionHashes: [result.submission.transactionHashes[0]] },
      {
        ...result.submission,
        transactionHashes: Array(2).fill(result.submission.transactionHashes[0]),
      },
    ]) {
      expect(isOperationRecovery({ ...result, submission })).toBe(false);
    }
  });
  it('distinguishes canonical inclusion, reorg uncertainty and final settlement', () => {
    const r = recovery();
    const hash = `0x${'a'.repeat(64)}`;
    if (!r.preparation) throw new Error('fixture preparation missing');
    r.preparation.stepCount = 1;
    r.submission = { operationId: id, transactionHashes: [hash] };
    r.operation.state = 'confirming';
    const included = {
      blockNumber: '100',
      blockHash: hash,
      transactionIndex: '0',
      succeeded: true,
      finalized: false,
      gasUsed: '50000',
      effectiveGasPrice: '9007199254740993',
    };
    r.reconciliation = {
      checkedAtMs: 1792310000000,
      headNumber: '101',
      headHash: hash,
      finalizedNumber: '90',
      finalizedHash: hash,
      transactions: [{ transactionHash: hash, inclusion: included }],
    };
    expect(isOperationRecovery(r)).toBe(true);
    r.operation.state = 'succeeded';
    expect(isOperationRecovery(r)).toBe(false);
    r.reconciliation.finalizedNumber = '100';
    included.finalized = true;
    expect(isOperationRecovery(r)).toBe(true);
    included.succeeded = false;
    expect(isOperationRecovery(r)).toBe(false);
    r.operation.state = 'failed';
    expect(isOperationRecovery(r)).toBe(true);
    const transaction = r.reconciliation.transactions[0];
    if (!transaction) throw new Error('fixture transaction missing');
    transaction.inclusion = null;
    expect(isOperationRecovery(r)).toBe(false);
    r.operation.state = 'unknown';
    expect(isOperationRecovery(r)).toBe(true);
    transaction.transactionHash = `0x${'b'.repeat(64)}`;
    expect(isOperationRecovery(r)).toBe(false);
  });
  it('uses bearer header and binds recovered identity without automatic retries', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(recovery())));
    const client = createApiClient({ baseUrl: 'https://wallet.example', fetch });
    const result = await client.operation('session-token', id);
    expect(result.operation.version).toBe('9007199254740993');
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`https://wallet.example/api/v1/operations/${id}`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer session-token');
    expect(init.credentials).toBe('omit');
    await expect(client.operation('session-token', '../auth/session')).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const wrong = recovery();
    wrong.operation.id = wrong.operation.walletId;
    fetch.mockResolvedValue(new Response(JSON.stringify(wrong)));
    await expect(client.operation('session-token', id)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it('validates bounded history pages, exact versions, cursor placement and wallet isolation', async () => {
  const { isOperationPage } = await import('./operations');
  const item = { operation: recovery().operation, createdAtMs: 1000, updatedAtMs: 2000 };
  const page = { items: [item], nextCursor: item.operation.id };
  expect(isOperationPage(page)).toBe(true);
  for (const invalid of [
    { ...page, nextCursor: '00000000-0000-4000-8000-000000000002' },
    { items: [], nextCursor: item.operation.id },
    { ...page, items: [item, item] },
    { ...page, items: Array(51).fill(item) },
    { ...page, items: [{ ...item, createdAtMs: '1000' }] },
    { ...page, items: [{ ...item, operation: { ...item.operation, version: 1 } }] },
    {
      items: [
        item,
        {
          ...item,
          operation: {
            ...item.operation,
            id: '00000000-0000-4000-8000-000000000002',
            walletId: '00000000-0000-4000-8000-000000000003',
          },
        },
      ],
      nextCursor: null,
    },
  ])
    expect(isOperationPage(invalid)).toBe(false);
});
it('rejects anchor replay and oversized pages, and places auth only in a header', async () => {
  const item = { operation: recovery().operation, createdAtMs: 1000, updatedAtMs: 2000 };
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ items: [item], nextCursor: null }), { status: 200 }),
    );
  const api = createApiClient({ baseUrl: 'https://api.example', fetch: fetcher });
  await api.operations('secret', { limit: 1 });
  const call = fetcher.mock.calls[0];
  if (!call) throw new Error('missing request');
  expect(call[0]).toBe('https://api.example/api/v1/operations?limit=1');
  expect(new Headers(call[1].headers).get('authorization')).toBe('Bearer secret');
  await expect(api.operations('secret', { cursor: id })).rejects.toThrow('Invalid operation page');
  for (const limit of [0, 51, 1.5])
    await expect(api.operations('secret', { limit })).rejects.toThrow(
      'Invalid operation page query',
    );
  expect(fetcher).toHaveBeenCalledTimes(2);
});
