import { address, object, uint } from './evm-signing';
import { validateSwapQuote } from './swaps';
import type { Permit2Terms, SwapQuote, SwapQuoteConfiguration } from './types';
import type { UniswapRouterExecution } from './uniswap-router';

const MAX48 = (1n << 48n) - 1n;
function validTerms(v: unknown, now: number): v is Permit2Terms {
  if (!Number.isSafeInteger(now) || now <= 0 || now > Number.MAX_SAFE_INTEGER - 2592000)
    return false;
  return (
    object(v) &&
    uint(v.chainId, BigInt(Number.MAX_SAFE_INTEGER)) &&
    v.chainId !== '0' &&
    address(v.permit2) &&
    address(v.owner) &&
    address(v.token) &&
    address(v.spender) &&
    uint(v.amountRaw, (1n << 160n) - 2n) &&
    v.amountRaw !== '0' &&
    uint(v.nonce, MAX48) &&
    uint(v.expiration, MAX48) &&
    uint(v.sigDeadline, MAX48) &&
    BigInt(v.sigDeadline) > BigInt(now) &&
    BigInt(v.sigDeadline) <= BigInt(now + 1800) &&
    BigInt(v.expiration) >= BigInt(v.sigDeadline) &&
    BigInt(v.expiration) <= BigInt(now + 2592000)
  );
}
/** Reconstruct fixed PermitSingle EIP-712 data; never forward provider-supplied types.
 * No key access or signature. Fresh allowance nonce and contract pins are separate checks.
 */
export function permit2TypedData(terms: Permit2Terms, now = Math.floor(Date.now() / 1000)): string {
  if (!validTerms(terms, now)) throw new Error('Invalid or expired Permit2 authority.');
  return JSON.stringify({
    domain: { name: 'Permit2', chainId: Number(terms.chainId), verifyingContract: terms.permit2 },
    primaryType: 'PermitSingle',
    types: {
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
    message: {
      details: {
        token: terms.token,
        amount: terms.amountRaw,
        expiration: terms.expiration,
        nonce: terms.nonce,
      },
      spender: terms.spender,
      sigDeadline: terms.sigDeadline,
    },
  });
}
/** Wallet-facing quote binding. This does not prove a fresh nonce or authorize signing. */
export function validatePermit2Quote(
  terms: Permit2Terms,
  configuration: SwapQuoteConfiguration,
  quote: SwapQuote,
  signer: string,
  nowMs = Date.now(),
): void {
  if (
    !validTerms(terms, Math.floor(nowMs / 1000)) ||
    terms.owner !== signer.toLowerCase() ||
    terms.chainId !== configuration.chainId ||
    terms.permit2 !== configuration.permit2 ||
    terms.spender !== configuration.router ||
    terms.token !== quote.tokenIn ||
    terms.amountRaw !== quote.amountInRaw
  ) {
    throw new Error('Permit2 authority does not match the reviewed swap.');
  }
  validateSwapQuote(
    quote,
    configuration,
    {
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      amountRaw: quote.amountInRaw,
      slippageBps: quote.slippageBps,
    },
    signer,
    nowMs,
  );
}

/** Bind a provider build to the exact signature the wallet just produced. This
 * checks only embedded permit authority, not swap/payment semantics. Server EOA
 * recovery and fresh on-chain nonce verification remain mandatory.
 */
export function validateEmbeddedPermit(
  execution: UniswapRouterExecution,
  terms: Permit2Terms | null,
  signature: string | null,
  now = Math.floor(Date.now() / 1000),
): void {
  const permits = execution.commands.filter((c) => c.kind === 'permit_single');
  if (terms === null && signature === null && permits.length === 0) return;
  const permit = execution.commands[0];
  if (
    !terms ||
    !signature ||
    !validTerms(terms, now) ||
    !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(signature) ||
    permits.length !== 1 ||
    permit?.kind !== 'permit_single' ||
    permit.token !== terms.token ||
    permit.amountRaw !== terms.amountRaw ||
    permit.expiration !== terms.expiration ||
    permit.nonce !== terms.nonce ||
    permit.spender !== terms.spender ||
    permit.sigDeadline !== terms.sigDeadline ||
    permit.signature !== signature.toLowerCase() ||
    !uint(execution.deadline) ||
    BigInt(execution.deadline) <= BigInt(now) ||
    BigInt(execution.deadline) > BigInt(terms.sigDeadline)
  ) {
    throw new Error('The router permit differs from the wallet authorization.');
  }
}
