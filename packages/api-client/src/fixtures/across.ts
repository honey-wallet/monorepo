import type { AcrossConfiguration, AcrossQuote, AcrossQuoteRequest } from '../types';
export function acrossFixture(now = Date.now()) {
  const address = (n: string) => `0x${n.repeat(40)}`;
  const configuration: AcrossConfiguration = {
    provider: 'across',
    sourceChainId: '1',
    integratorId: '0xabcd',
    registryRevision: 'fixture-v1',
    executionAvailable: false,
    routes: [
      {
        id: 'usdc-base',
        destinationChainId: '8453',
        sourceSpoke: address('4'),
        inputToken: { address: address('2'), assetId: 'usdc', symbol: 'USDC', decimals: 6 },
        outputToken: { address: address('3'), assetId: 'usdc', symbol: 'USDC', decimals: 6 },
        minimumInputRaw: '1000000',
        maximumInputRaw: '1000000000',
        maximumBridgeFeeBps: 100,
        maximumFillSeconds: 3600,
        maximumExclusivitySeconds: 60,
      },
    ],
  };
  const request: AcrossQuoteRequest = {
    routeId: 'usdc-base',
    amountRaw: '1000000',
    minimumOutputRaw: '980000',
    recipient: address('1'),
  };
  const quote: AcrossQuote = {
    provider: 'across',
    quoteId: 'fixture-quote',
    routeId: request.routeId,
    registryRevision: 'fixture-v1',
    sourceChainId: '1',
    destinationChainId: '8453',
    sender: address('1'),
    recipient: address('1'),
    inputToken: address('2'),
    outputToken: address('3'),
    inputAmountRaw: '1000000',
    outputAmountRaw: '990000',
    minimumOutputRaw: '990000',
    bridgeFeeRaw: '10000',
    integratorFeeRaw: '0',
    integratorId: '0xabcd',
    sourceGasEstimateRaw: '120000',
    approvalGasIncluded: false,
    expectedFillSeconds: 10,
    refundChainId: '1',
    refundRecipient: address('1'),
    quoteTimestamp: Math.floor(now / 1000).toString(),
    fillDeadline: (Math.floor(now / 1000) + 1800).toString(),
    exclusivityParameter: '30',
    exclusiveRelayer: address('6'),
    receivedAtMs: now,
    providerExpiresAtMs: null,
    expiresAtMs: now + 30000,
    executionAvailable: false,
  };
  return { configuration, request, quote };
}
