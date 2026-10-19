import { describe, expect, it, vi } from 'vitest';
import { bridgeStatusMessage, isBridgeStatusRecovery } from './bridge-status';
import { createApiClient } from './client';
import type { BridgeStatusRecovery } from './types';

const id = '00000000-0000-4000-8000-000000000001';
const fixture = (): BridgeStatusRecovery => ({
  operationId: id,
  binding: {
    provider: 'across',
    providerReference: '7',
    sourceChainId: '1',
    destinationChainId: '8453',
    refundChainId: '1',
    sourceTransactionHash: `0x${'11'.repeat(32)}`,
  },
  verifiedDelivery: null,
  observation: {
    provider: 'across',
    reportedOutcome: 'fill_reported',
    sourceTransactionSeen: true,
    candidates: [
      { chainId: '8453', transactionHash: `0x${'22'.repeat(32)}`, role: 'destination_fill' },
    ],
    observedAtMs: 100000,
    providerUpdatedAtMs: null,
    verificationRequired: true,
    pollAfterMs: 10000,
  },
  stale: false,
  pollVersion: '1',
  nextPollAtMs: 110000,
  lastErrorCode: null,
});
describe('bridge observation contract', () => {
  it('keeps fills and refunds advisory and displays delayed observations honestly', () => {
    const f = fixture();
    expect(isBridgeStatusRecovery(f)).toBe(true);
    expect(bridgeStatusMessage(f)).toContain('still pending');
    f.stale = true;
    expect(bridgeStatusMessage(f)).toContain('must not be sent again');
    f.observation = null;
    expect(isBridgeStatusRecovery(f)).toBe(true);
    f.stale = false;
    expect(isBridgeStatusRecovery(f)).toBe(false);
    const missingProof = fixture();
    Reflect.deleteProperty(missingProof, 'verifiedDelivery');
    expect(isBridgeStatusRecovery(missingProof)).toBe(false);
  });
  it('rejects mismatched chains, non-advisory claims and malformed candidates', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        const candidate = f.observation?.candidates[0];
        if (candidate) candidate.chainId = '1';
      },
      (f: ReturnType<typeof fixture>) => {
        if (f.observation) f.observation.sourceTransactionSeen = false;
      },
      (f: ReturnType<typeof fixture>) => {
        const candidate = f.observation?.candidates[0];
        if (candidate) f.observation?.candidates.push({ ...candidate });
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding.providerReference = '07';
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding.sourceChainId = '8453';
      },
    ]) {
      const f = fixture();
      mutate(f);
      expect(isBridgeStatusRecovery(f)).toBe(false);
    }
    const f = fixture();
    expect(
      isBridgeStatusRecovery({
        ...f,
        observation: { ...f.observation, verificationRequired: false },
      }),
    ).toBe(false);
    expect(
      isBridgeStatusRecovery({
        ...f,
        observation: { ...f.observation, reportedOutcome: 'succeeded' },
      }),
    ).toBe(false);
  });
  it('uses an owner-authenticated read and rejects a substituted operation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(fixture()));
    const client = createApiClient({ baseUrl: 'http://localhost', fetch: fetcher });
    await expect(client.bridgeStatus('token', id)).resolves.toMatchObject({ operationId: id });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `http://localhost/api/v1/operations/${id}/bridge-status`,
    );
    const substituted = { ...fixture(), operationId: '00000000-0000-4000-8000-000000000002' };
    fetcher.mockImplementation(async () => Response.json(substituted));
    await expect(client.bridgeStatus('token', id)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
it('accepts verified destination anchors separately from stale provider hints and rejects substitution', () => {
  const f = fixture();
  const anchor = {
    blockNumber: '100',
    blockHash: `0x${'33'.repeat(32)}`,
    finalizedNumber: '101',
    finalizedHash: `0x${'44'.repeat(32)}`,
  };
  f.verifiedDelivery = {
    evidenceVersion: '1',
    operationVersion: '8',
    sourceChainId: '1',
    sourceTransactionHash: f.binding.sourceTransactionHash,
    destinationChainId: '8453',
    destinationTransactionHash: `0x${'22'.repeat(32)}`,
    recipient: `0x${'55'.repeat(20)}`,
    outputToken: `0x${'66'.repeat(20)}`,
    deliveredAmountRaw: '990000',
    source: anchor,
    destination: anchor,
    verifiedAtMs: 120000,
  };
  f.stale = true;
  expect(isBridgeStatusRecovery(f)).toBe(true);
  expect(bridgeStatusMessage(f)).toBe('Destination delivery verified.');
  for (const change of [
    { evidenceVersion: '2' },
    { destinationChainId: '1' },
    { sourceTransactionHash: `0x${'99'.repeat(32)}` },
    { deliveredAmountRaw: '0' },
    { deliveredAmountRaw: '01' },
    { recipient: '0x0' },
    { destination: { ...anchor, finalizedNumber: '99' } },
  ])
    expect(
      isBridgeStatusRecovery({ ...f, verifiedDelivery: { ...f.verifiedDelivery, ...change } }),
    ).toBe(false);
});
