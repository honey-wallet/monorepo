import { describe, expect, it, vi } from 'vitest';
import { bridgeStatusMessage, isBridgeStatusRecovery } from './bridge-status';
import { createApiClient } from './client';
import type { BridgeStatusRecovery } from './types';

const id = '00000000-0000-4000-8000-000000000001';
const fixture = (): BridgeStatusRecovery => ({
  operationId: id,
  binding: {
    provider: 'relay',
    providerReference: 'request-fixture',
    sourceChainId: '1',
    destinationChainId: '8453',
    refundChainId: '1',
    sourceTransactionHash: `0x${'11'.repeat(32)}`,
  },
  observation: {
    provider: 'relay',
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
        f.binding.providerReference = '../?secret';
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding.sourceChainId = '8453';
      },
      (f: ReturnType<typeof fixture>) => {
        f.binding.refundChainId = '8453';
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
