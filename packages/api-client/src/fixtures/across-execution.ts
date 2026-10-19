import type { AcrossReviewContext } from '../across-execution';
import type { AcrossDepositTerms, AcrossSigningRequest } from '../types';
import { acrossFixture } from './across';
/** Synthetic fixture, literal ABI words; no live credentials or transactions. */
export function acrossExecutionFixture(now = Date.now()) {
  const { configuration } = acrossFixture(now);
  configuration.sourceChainId = '31337';
  for (const r of configuration.routes) r.destinationChainId = '31338';
  const route = configuration.routes[0];
  if (!route) throw new Error('fixture missing route');
  const terms: AcrossDepositTerms = {
    sourceChain: '31337',
    destinationChain: '31338',
    depositor: `0x${'1'.repeat(40)}`,
    recipient: `0x${'5'.repeat(40)}`,
    inputToken: route.inputToken.address,
    outputToken: route.outputToken.address,
    inputAmount: '1000000',
    outputAmount: '990000',
    exclusiveRelayer: `0x${'6'.repeat(40)}`,
    quoteTimestamp: String(Math.floor(now / 1000)),
    fillDeadline: String(Math.floor(now / 1000) + 1800),
    exclusivityParameter: '30',
    swapApiIntegratorId: configuration.integratorId,
  };
  const word = (n: string) => BigInt(n).toString(16).padStart(64, '0');
  const calldata = `0xad5425c6${[terms.depositor, terms.recipient, terms.inputToken, terms.outputToken, terms.inputAmount, terms.outputAmount, terms.destinationChain, terms.exclusiveRelayer, terms.quoteTimestamp, terms.fillDeadline, terms.exclusivityParameter, '384', '0'].map(word).join('')}1dc0deabcd73c0de`;
  const operationId = '00000000-0000-4000-8000-000000000001';
  const executionDeadlineMs = (Math.floor(now / 1000) + 300) * 1000;
  const preparedExpiresAtMs = executionDeadlineMs;
  const signing: AcrossSigningRequest = {
    operationId,
    operationVersion: '1',
    planHash: 'a'.repeat(64),
    review: {
      terms,
      sourceSpoke: route.sourceSpoke,
      calldata,
      quoteId: 'fixture-quote',
      registryRevision: configuration.registryRevision,
      intentHash: 'b'.repeat(64),
      quotedAtMs: now,
      quoteExpiresAtMs: now + 30000,
      providerExpiresAtMs: null,
      executionDeadlineMs,
      preparedAtMs: now + 1000,
      expiresAtMs: preparedExpiresAtMs,
      maximumNetworkFeeRaw: '1000000',
    },
    prepared: {
      firstNonce: '0',
      gasLimits: ['100000', '200000'],
      maxFeePerGas: '3',
      maxPriorityFeePerGas: '1',
      plan: {
        schemaVersion: 1,
        provider: 'across',
        chainId: '31337',
        signer: terms.depositor,
        intentHash: 'b'.repeat(64),
        registryRevision: configuration.registryRevision,
        feePolicyRevision: 'across-zero-app-fee-v1',
        quoteReference: 'fixture-quote',
        expiresAtMs: preparedExpiresAtMs,
        maximumNetworkFeeRaw: '900000',
        maximumSpend: {
          assetAddress: terms.inputToken,
          amountRaw: terms.inputAmount,
          recipient: route.sourceSpoke,
        },
        minimumReceive: null,
        fees: [],
        simulation: {
          blockNumber: '100',
          blockHash: `0x${'c'.repeat(64)}`,
          callsHash: 'd'.repeat(64),
          observedAtMs: now + 1000,
        },
        steps: [
          {
            purpose: 'approval',
            to: terms.inputToken,
            valueRaw: '0',
            data: `0x095ea7b3${word(route.sourceSpoke)}${word(terms.inputAmount)}`,
          },
          { purpose: 'action', to: route.sourceSpoke, valueRaw: '0', data: calldata },
        ],
      },
    },
  };
  const context: AcrossReviewContext = {
    configuration: {
      mode: 'local_fork',
      quote: configuration,
      feePolicyRevision: 'across-zero-app-fee-v1',
    },
    intent: {
      quoteId: 'fixture-quote',
      routeId: route.id,
      amountRaw: terms.inputAmount,
      minimumOutputRaw: terms.outputAmount,
      recipient: terms.recipient,
      deadline: String(Math.floor(executionDeadlineMs / 1000)),
      maximumNetworkFeeRaw: '1000000',
    },
    signer: terms.depositor,
    operationId,
    operationVersion: '1',
    planHash: signing.planHash,
  };
  return { signing, context };
}
