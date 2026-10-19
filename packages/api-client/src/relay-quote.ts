/** Reviewed input projection for Relay's v2 quote API.
 *
 * This is intentionally a request validator only. Relay quote responses include
 * transaction/signature steps and are not safe to hand to a signer until each
 * step, target, calldata, chain and fee has an independent execution review.
 */
export type RelayTradeType = 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'EXPECTED_OUTPUT';

export interface RelayQuoteRequest {
  user: string;
  recipient?: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: RelayTradeType;
}

/** Display-only server response. It contains no transaction or signature payloads. */
export interface RelayQuotePreview {
  provider: 'relay';
  requestId: string;
  executionAvailable: false;
  steps: RelayStepPreview[];
}

export interface RelayStepPreview {
  index: number;
  id: string;
  kind: 'transaction' | 'signature';
  action: string;
  description: string;
  itemCount: number;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX_SAFE_CHAIN_ID = Number.MAX_SAFE_INTEGER;
const MAX_UINT256 = (1n << 256n) - 1n;

function chainId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_SAFE_CHAIN_ID
  );
}

function currency(value: unknown): value is string {
  // Relay's EVM API uses the zero address for native currency and an address
  // for ERC-20. Non-EVM identifiers are deliberately outside this EVM slice.
  return typeof value === 'string' && EVM_ADDRESS.test(value);
}

function amount(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    UINT.test(value) &&
    BigInt(value) > 0n &&
    BigInt(value) <= MAX_UINT256
  );
}

export function isRelayQuoteRequest(value: unknown): value is RelayQuoteRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const allowed = new Set([
    'user',
    'recipient',
    'originChainId',
    'destinationChainId',
    'originCurrency',
    'destinationCurrency',
    'amount',
    'tradeType',
  ]);
  if (Object.keys(v).some((key) => !allowed.has(key))) return false;
  return (
    typeof v.user === 'string' &&
    EVM_ADDRESS.test(v.user) &&
    (v.recipient === undefined ||
      (typeof v.recipient === 'string' && EVM_ADDRESS.test(v.recipient))) &&
    chainId(v.originChainId) &&
    chainId(v.destinationChainId) &&
    currency(v.originCurrency) &&
    currency(v.destinationCurrency) &&
    amount(v.amount) &&
    (v.tradeType === 'EXACT_INPUT' ||
      v.tradeType === 'EXACT_OUTPUT' ||
      v.tradeType === 'EXPECTED_OUTPUT')
  );
}

/** Return a fresh exact-field copy, suitable for a future server-side quote adapter. */
export function projectRelayQuoteRequest(value: RelayQuoteRequest): RelayQuoteRequest {
  if (!isRelayQuoteRequest(value)) throw new Error('Invalid Relay quote request.');
  return {
    user: value.user,
    ...(value.recipient === undefined ? {} : { recipient: value.recipient }),
    originChainId: value.originChainId,
    destinationChainId: value.destinationChainId,
    originCurrency: value.originCurrency,
    destinationCurrency: value.destinationCurrency,
    amount: value.amount,
    tradeType: value.tradeType,
  };
}

export function isRelayQuotePreview(value: unknown): value is RelayQuotePreview {
  const text = (value: unknown, max: number): value is string =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) => !['provider', 'requestId', 'executionAvailable', 'steps'].includes(key),
    ) ||
    v.provider !== 'relay' ||
    v.executionAvailable !== false ||
    !text(v.requestId, 128) ||
    !Array.isArray(v.steps) ||
    v.steps.length < 1 ||
    v.steps.length > 16
  )
    return false;
  const ids = new Set<string>();
  return v.steps.every((step, index) => {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) return false;
    const s = step as Record<string, unknown>;
    if (
      Object.keys(s).some(
        (key) => !['index', 'id', 'kind', 'action', 'description', 'itemCount'].includes(key),
      ) ||
      s.index !== index ||
      !text(s.id, 64) ||
      ids.has(s.id) ||
      (s.kind !== 'transaction' && s.kind !== 'signature') ||
      !text(s.action, 160) ||
      !text(s.description, 256) ||
      !Number.isInteger(s.itemCount) ||
      (s.itemCount as number) < 0 ||
      (s.itemCount as number) > 16
    )
      return false;
    ids.add(s.id);
    return true;
  });
}
