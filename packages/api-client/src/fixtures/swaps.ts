import type { SwapQuote, SwapQuoteConfiguration, SwapQuoteRequest } from '../types';
export function swapFixture(now = Date.now()) {
  const a = (n: string) => `0x${n.repeat(40)}`;
  const configuration: SwapQuoteConfiguration = {
    provider: 'uniswap',
    chainId: '1',
    router: a('4'),
    permit2: a('5'),
    routerVersion: '2.1.2',
    tokens: [
      { address: a('2'), symbol: 'IN', decimals: 6 },
      { address: a('3'), symbol: 'OUT', decimals: 18 },
    ],
    integratorFees: [{ recipient: a('6'), bps: 100 }],
    registryRevision: 'fixture-v1',
    feePolicyRevision: 'fixture-fee-v1',
    executionAvailable: false,
  };
  const request: SwapQuoteRequest = {
    tokenIn: a('2'),
    tokenOut: a('3'),
    amountRaw: '1000000',
    slippageBps: 50,
  };
  const quote: SwapQuote = {
    provider: 'uniswap',
    routing: 'CLASSIC',
    quoteId: 'fixture-quote',
    requestId: 'fixture-request',
    chainId: '1',
    signer: a('1'),
    tokenIn: a('2'),
    tokenOut: a('3'),
    amountInRaw: '1000000',
    grossOutputRaw: '2000000',
    netOutputRaw: '1980000',
    minimumOutputRaw: '1970100',
    slippageBps: 50,
    fees: [{ recipient: a('6'), bps: 100, amountRaw: '20000' }],
    swapGasEstimateRaw: '1200000000000',
    approvalGasIncluded: false,
    permitRequired: false,
    sourceBlock: '100',
    registryRevision: 'fixture-v1',
    feePolicyRevision: 'fixture-fee-v1',
    receivedAtMs: now,
    expiresAtMs: now + 30000,
    executionAvailable: false,
  };
  return { configuration, request, quote };
}
