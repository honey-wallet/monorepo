import type { AaveReviewContext } from '../aave';
import type { AaveSigningRequest } from '../types';
// Synthetic public addresses and independent literal ABI encoding; never sent.
export function aaveFixture(now = Date.now()): {
  signing: AaveSigningRequest;
  context: AaveReviewContext;
} {
  const signer = `0x${'11'.repeat(20)}`,
    pool = `0x${'22'.repeat(20)}`,
    asset = `0x${'33'.repeat(20)}`,
    aToken = `0x${'44'.repeat(20)}`;
  const word = (s: string) => s.slice(2).padStart(64, '0');
  const operationId = '00000000-0000-4000-8000-000000000001';
  const signing: AaveSigningRequest = {
    operationId,
    operationVersion: '1',
    planHash: 'a'.repeat(64),
    prepared: {
      firstNonce: '0',
      gasLimits: ['100000', '200000'],
      maxFeePerGas: '3',
      maxPriorityFeePerGas: '1',
      plan: {
        schemaVersion: 1,
        provider: 'aave_v3',
        chainId: '31337',
        signer,
        intentHash: 'b'.repeat(64),
        registryRevision: 'test',
        feePolicyRevision: 'test-zero',
        quoteReference: null,
        expiresAtMs: now + 120000,
        maximumNetworkFeeRaw: '900000',
        maximumSpend: { assetAddress: asset, amountRaw: '1000000', recipient: signer },
        minimumReceive: null,
        fees: [],
        simulation: {
          blockNumber: '100',
          blockHash: `0x${'cc'.repeat(32)}`,
          callsHash: 'd'.repeat(64),
          observedAtMs: now,
        },
        steps: [
          {
            purpose: 'approval',
            to: asset,
            valueRaw: '0',
            data: `0x095ea7b3${word(pool)}${'f4240'.padStart(64, '0')}`,
          },
          {
            purpose: 'action',
            to: pool,
            valueRaw: '0',
            data: `0x617ba037${word(asset)}${'f4240'.padStart(64, '0')}${word(signer)}${'0'.repeat(64)}`,
          },
        ],
      },
    },
  };
  const context: AaveReviewContext = {
    operationId,
    operationVersion: '1',
    planHash: signing.planHash,
    signer,
    intent: { action: 'supply', amountRaw: '1000000', maximumNetworkFeeRaw: '1000000' },
    configuration: {
      mode: 'local_fork',
      chainId: '31337',
      pool,
      asset,
      aToken,
      decimals: 6,
      maximumAtokenRoundingRaw: '2',
      registryRevision: 'test',
      feePolicyRevision: 'test-zero',
    },
  };
  return { signing, context };
}
