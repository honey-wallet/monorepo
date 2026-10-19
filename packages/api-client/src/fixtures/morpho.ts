import type { MorphoReviewContext } from '../morpho';
import type { MorphoQuote, MorphoSigningRequest } from '../types';
import { aaveFixture } from './aave';

/** Public synthetic identities; amounts chosen for exact, independently checkable ABI words. */
export function morphoFixture(action: 'deposit' | 'redeem' = 'deposit', now = Date.now()) {
  const a = aaveFixture(now);
  const vault = a.context.configuration.aToken,
    bundle = a.context.configuration.pool;
  const asset = a.context.configuration.asset,
    signer = a.context.signer;
  const amount = action === 'deposit' ? '1000000' : '1000000000000000000';
  const deadline = Math.floor(now / 1000) + 600;
  const word = (v: string | number | bigint) => BigInt(v).toString(16).padStart(64, '0');
  const context: MorphoReviewContext = {
    operationId: a.signing.operationId,
    operationVersion: '1',
    planHash: a.signing.planHash,
    signer,
    configuration: {
      mode: 'local_fork',
      chainId: '31337',
      vault,
      bundle,
      asset,
      assetDecimals: 6,
      shareDecimals: 18,
      performanceFeeWad: '0',
      managementFeePerSecondWad: '0',
      registryRevision: 'test',
      feePolicyRevision: 'test-zero',
      redemptionOutputProtection: 'none',
    },
    intent: {
      vault,
      action,
      amountRaw: amount,
      minimumSharesRaw: action === 'deposit' ? '1000000000000000000' : null,
      acknowledgeUnprotectedOutput: action === 'redeem',
      deadline: String(deadline),
      maximumNetworkFeeRaw: '1000000',
    },
  };
  const signing: MorphoSigningRequest = {
    ...a.signing,
    prepared: {
      ...a.signing.prepared,
      plan: {
        ...a.signing.prepared.plan,
        provider: 'morpho_vault_v2',
        maximumSpend: {
          assetAddress: action === 'deposit' ? asset : vault,
          amountRaw: amount,
          recipient: signer,
        },
        minimumReceive:
          action === 'deposit'
            ? { assetAddress: vault, amountRaw: '1000000000000000000', recipient: signer }
            : null,
        steps: [
          {
            purpose: 'approval',
            to: action === 'deposit' ? asset : vault,
            valueRaw: '0',
            data: `0x095ea7b3${word(bundle)}${word(amount)}`,
          },
          {
            purpose: 'action',
            to: bundle,
            valueRaw: '0',
            data:
              action === 'deposit'
                ? `0x6bbba4e0${[vault, '1000000', '1000000000000000', 224, 0, 0, deadline, 0, 64, 0].map(word).join('')}`
                : `0x932084a8${[vault, 0, amount, 0, 0, 0, 0, 0, 0, 0, 0, deadline].map(word).join('')}`,
          },
        ],
      },
    },
  };
  const quote: MorphoQuote = {
    action,
    amountRaw: amount,
    signer,
    chainId: '31337',
    vault,
    asset,
    assetBalanceRaw: '10000000',
    shareBalanceRaw: '1000000000000000000',
    previewAssetsRaw: '1000000',
    previewSharesRaw: '1000000000000000000',
    registryRevision: 'test',
    feePolicyRevision: 'test-zero',
    blockNumber: '100',
    blockHash: `0x${'cc'.repeat(32)}`,
    observedAtMs: now,
    expiresAtMs: now + 30000,
  };
  return { signing, context, quote };
}
