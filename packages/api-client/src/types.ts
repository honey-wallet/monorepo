// Response shapes returned by the Rust server (apps/server/src/routes).
// Keep these in sync when changing a handler's response type.

export interface Health {
  status: 'ok';
}

/** `POST /api/v1/waitlist`. Same body whether the email is new or already listed. */
export interface WaitlistResponse {
  status: 'joined';
}

export type WaitlistSource = 'web' | 'extension' | 'mobile';

export interface VersionInfo {
  name: string;
  version: string;
}

export type DependencyStatus = 'not_configured' | 'pending' | 'up' | 'down';

/** GET /ready. A 503 response has this same operational shape. */
export interface Readiness {
  status: 'ready' | 'not_ready';
  dependencies: { postgres: DependencyStatus; redis: DependencyStatus };
  draining: boolean;
  checksFresh: boolean;
}

/** Runtime availability and the safest currently configured scope. Unknown features are disabled. */
export interface Capabilities {
  schemaVersion: 3;
  features: {
    id: string;
    available: boolean;
    scope: 'unavailable' | 'read_only' | 'local_testnet' | 'production';
    reason: string;
    /** Planned integration identities; inclusion does not mean the adapter is live. */
    providers: string[];
    /** Runtime adapters configured in this server process. */
    configuredProviders: string[];
  }[];
}

/** Pairing mailbox (apps/server/src/routes/pairing.rs), slots in protocol order. */
export type PairSlot = 'commit' | 'nonce' | 'reveal' | 'payload';

/** A pairing's mailbox: the channel is sha256(token) in hex; the token proves access. */
export interface PairChannel {
  channel: string;
  token: string;
}

export interface PairMessage {
  /** Base64url: a public key for `hello`, ciphertext for `payload`. */
  data: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// Multi-chain wallet (apps/server/src/{chains,wallet,relayer,exposure,monitoring}.rs).
// Self-custodial: no request or response ever carries key material.

export type Chain = 'evm' | 'solana' | 'bitcoin' | 'tron' | 'xrpl';

/** Security tier: A = hot (curve key + rotation), B = vault (hash-based). */
export type Tier = 'A' | 'B';

export type Support = 'yes' | 'no' | 'contract_route_only' | 'inherent';

export type SessionAnchorKind =
  | 'erc7579_validator'
  | 'pda_field'
  | 'zero_ops_permission'
  | 'message_key'
  | 'identity_address';

/** `public_rpc` today; the private routes are a later upgrade (spec §10). */
export type SubmissionRoute =
  | 'public_rpc'
  | 'private_bundler'
  | 'flashbots_protect'
  | 'direct_to_leader'
  | 'jito_bundle'
  | 'own_node'
  | 'miner_direct';

/** GET /api/v1/chains */
export interface ChainCapabilities {
  chain: Chain;
  identifierIsPubkeyHash: boolean;
  atomicRotation: Support;
  customContractForTierA: Support;
  commitDelayReveal: Support;
  sessionAnchor: SessionAnchorKind;
  thirdPartySessionVerification: boolean;
  tierB: Support;
  confirmationWindowMs: number;
  privateSubmission: SubmissionRoute[];
  notes: string;
}

export type SessionAnchor =
  | { kind: 'erc7579_validator'; validator: string }
  | { kind: 'pda_field' }
  | { kind: 'zero_ops_permission'; permission_id: number }
  | { kind: 'message_key' }
  | { kind: 'identity_address'; address: string };

export interface SessionKey {
  publicKey: string;
  expiresAt: number;
  anchor: SessionAnchor;
}

export interface VaultState {
  merkleRoot: string;
  nextLeafIndex: number;
  treeHeight: number;
}

/** POST /api/v1/accounts, GET /api/v1/accounts/:id */
export interface Account {
  id: string;
  chain: Chain;
  address: string;
  tier: Tier;
  ownerKeyIndex: number;
  ownerCommitment: string | null;
  session: SessionKey | null;
  vault: VaultState | null;
  commitDelay: number | null;
}

export interface PendingMigration {
  newOwnerCommitment: string | null;
  newValidator: string | null;
  executableAt: number;
}

/** GET /api/v1/accounts/:id/recovery */
export interface RecoveryStatus {
  guardianCommitments: string[];
  threshold: number;
  pendingMigration: PendingMigration | null;
  deadManSwitchMonths: number | null;
  lastOwnerOperationAt: number | null;
}

export type ExposureKind =
  | 'owner_signature'
  | 'rotation_window'
  | 'master_key_setup'
  | 'vault_leaf';

/** GET/POST /api/v1/accounts/:id/exposure-events */
export interface ExposureEvent {
  id: string;
  accountId: string;
  chain: Chain;
  kind: ExposureKind;
  keyIndex: number;
  txHash: string | null;
  observedAt: number;
}

/** POST /api/v1/session-signatures/verify */
export interface SessionVerdict {
  valid: boolean;
  reason: string | null;
  sessionExpiresAt: number | null;
}

/** POST /api/v1/relay/commits */
export interface CommitReceipt {
  commitId: string;
  chain: Chain;
  txHash: string;
  committedAt: number;
  revealAfter: number;
  expiresAt: number;
}

/** POST /api/v1/relay/submit, POST /api/v1/relay/commits/:id/reveal */
export interface SubmissionReceipt {
  txHash: string;
  route: SubmissionRoute;
  submittedAt: number;
}

export type MigrationTrigger =
  | 'bip360_activation'
  | 'ethereum_pq_signatures'
  | 'solana_native_pq'
  | 'xrpl_batch_libraries'
  | 'quantum_resource_estimate';

/** GET /api/v1/monitoring/triggers */
export interface TriggerStatus {
  trigger: MigrationTrigger;
  fired: boolean;
  lastCheckedAt: number | null;
  evidence: string | null;
}
/** GET /api/v1/auth/config. Auth availability never enables financial features. */
export interface AuthConfiguration {
  enabled: boolean;
  method: 'siwe_eoa' | null;
  origin: string | null;
  chainId: string | null;
  sessionTtlSeconds: number;
}

export interface SignInChallenge {
  id: string;
  message: string;
  expiresAt: string;
}

export interface WalletProfile {
  userId: string;
  wallet: WalletIdentity;
}

/**
 * GET /api/v1/me/clerk with a Clerk session token: the Clerk user id only. Identity,
 * not wallet authority; unrelated to SIWE sessions.
 */
export interface ClerkIdentity {
  userId: string;
}

export interface WalletIdentity {
  id: string;
  chainId: string;
  address: string;
  accountKind: 'eoa';
}

/** Keep in memory or a platform credential store; never in a URL or logs. */
export interface AuthenticatedSession {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
  deviceId: string;
  profile: WalletProfile;
}

/** Venue display mid (or last trade for an empty book), never an execution quote. */
export interface DisplayPrice {
  instrumentId: string;
  symbol: 'BTC' | 'ETH' | 'SOL';
  quoteUnit: 'USDT';
  price: string;
  kind: 'mid_or_last';
}
export interface PriceSnapshot {
  schemaVersion: 1;
  type: 'snapshot';
  epoch: string;
  sequence: string;
  /** Server sample time, not exchange trade time. */
  sampledAtMs: number;
  stale: boolean;
  source: 'hyperliquid';
  prices: DisplayPrice[];
}

/** Authenticated, read-only Hyperliquid clearinghouse snapshot for the SIWE wallet. */
export interface HyperliquidPerpsAccountState {
  schemaVersion: 1;
  venue: 'hyperliquid';
  account: string;
  fetchedAtMs: number;
  state: {
    marginSummary: HyperliquidMarginSummary;
    crossMarginSummary: HyperliquidMarginSummary;
    crossMaintenanceMarginUsed: string;
    withdrawable: string;
    assetPositions: HyperliquidPosition[];
    time: number;
  };
}

export interface HyperliquidMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

export interface HyperliquidPosition {
  type: 'oneWay' | 'hedged';
  position: {
    coin: string;
    szi: string;
    entryPx: string | null;
    positionValue: string;
    unrealizedPnl: string;
    marginUsed: string;
    liquidationPx: string | null;
    leverage: { type: 'cross' | 'isolated'; value: number };
  };
}

export type EarnProtocol = 'aave_v3' | 'morpho_vault_v2';
export interface EarnAsset {
  address: string;
  decimals: number;
  symbol: string;
}
/** Indexed public market data; never a user position or executable quote. */
export interface EarnObservation {
  schemaVersion: 1;
  protocol: EarnProtocol;
  chainId: string;
  contractAddress: string;
  asset: EarnAsset;
  positionAsset: EarnAsset;
  totalSuppliedRaw: string;
  availableLiquidityRaw: string | null;
  supplyCapRaw: string | null;
  supplyApy: {
    fraction: string;
    basis: 'current_supply' | 'trailing_one_day_after_fees';
    rewardsIncluded: false;
  } | null;
  restrictions: {
    paused: boolean | null;
    frozen: boolean | null;
    supplyCapReached: boolean | null;
    gated: boolean | null;
  };
  vaultFees: { kind: 'performance' | 'management'; rateWad: string | null }[] | null;
  sourceBlocks: { component: 'configuration' | 'state' | 'apy'; number: string }[];
  fetchedAtMs: number;
  executionAvailable: false;
}
export interface PolymarketMarket {
  id: string;
  slug: string | null;
  question: string | null;
  conditionId: string | null;
  version: string | null;
  outcomeTokenIds: string[];
  positionIds: string[];
  /** Gamma catalog metadata only; never a Honey execution authorization. */
  orderBookEnabled: boolean;
  active: boolean;
  closed: boolean;
}

export interface PolymarketCatalog {
  schemaVersion: 1;
  executionAvailable: false;
  dataStatus: 'fresh' | 'stale';
  fetchedAtMs: number;
  ageMs: number;
  /** True when the bounded Gamma snapshot ended before upstream pagination did. */
  sourceTruncated: boolean;
  /** Local numeric cursor into the current cached snapshot, or null when exhausted. */
  nextCursor: string | null;
  markets: PolymarketMarket[];
}

export interface PolymarketOrderBookLevel {
  price: string;
  size: string;
}

export interface PolymarketOrderBook {
  schemaVersion: 1;
  executionAvailable: false;
  dataStatus: 'fresh' | 'stale';
  fetchedAtMs: number;
  ageMs: number;
  book: {
    marketId: string;
    assetId: string;
    timestamp: string;
    hash: string;
    bids: PolymarketOrderBookLevel[];
    asks: PolymarketOrderBookLevel[];
    minOrderSize: string;
    tickSize: string;
    negativeRisk: boolean;
    lastTradePrice: string;
  };
}

export interface EarnCatalogProduct {
  id: string;
  label: string;
  protocol: EarnProtocol;
  chainId: string;
  contractAddress: string;
  assetAddress: string;
  status: 'fresh' | 'stale' | 'unavailable';
  ageMs: number | null;
  observation: EarnObservation | null;
}
export interface EarnCatalog {
  schemaVersion: 1;
  status: 'not_configured' | 'ready' | 'degraded';
  maxAgeMs: 120000;
  products: EarnCatalogProduct[];
}

/** Durable recovery metadata; this response never authorizes signing or submission. */
export interface OperationRecovery {
  operation: {
    id: string;
    walletId: string;
    action: 'transfer' | 'swap' | 'bridge' | 'earn' | 'perps' | 'prediction';
    state:
      | 'created'
      | 'awaiting_permit'
      | 'building_swap'
      | 'awaiting_signature'
      | 'signed'
      | 'submitted'
      | 'confirming'
      | 'bridging'
      | 'succeeded'
      | 'failed'
      | 'unknown';
    /** Exact PostgreSQL bigint, not a JS number. */
    version: string;
  };
  intentAvailable: boolean;
  preparation: {
    hash: string;
    provider: 'native_transfer' | 'aave_v3' | 'morpho_vault_v2' | 'uniswap';
    chainId: string;
    expiresAtMs: number;
    expired: boolean;
    stepCount: number;
    registryRevision: string;
    feePolicyRevision: string;
  } | null;
  executionAvailable: false;
  submission: { operationId: string; transactionHashes: string[] } | null;
  reconciliation: {
    checkedAtMs: number;
    headNumber: string;
    headHash: string;
    finalizedNumber: string;
    finalizedHash: string;
    transactions: {
      transactionHash: string;
      inclusion: {
        blockNumber: string;
        blockHash: string;
        transactionIndex: string;
        succeeded: boolean;
        finalized: boolean;
        gasUsed: string;
        effectiveGasPrice: string;
      } | null;
    }[];
  } | null;
}

/** Explicit local-fork Aave execution registry. Mainnet activation is not supported. */
export interface AaveExecutionConfiguration {
  mode: 'local_fork';
  chainId: '31337';
  pool: string;
  asset: string;
  aToken: string;
  decimals: number;
  maximumAtokenRoundingRaw: string;
  registryRevision: string;
  feePolicyRevision: string;
}
export interface AaveIntent {
  action: 'supply' | 'withdraw';
  amountRaw: string;
  maximumNetworkFeeRaw: string;
}
export type AaveSigningRequest = EvmSigningRequest<'aave_v3'>;
export interface EvmSigningRequest<P extends 'aave_v3' | 'morpho_vault_v2' | 'uniswap'> {
  operationId: string;
  operationVersion: string;
  planHash: string;
  prepared: {
    firstNonce: string;
    gasLimits: string[];
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    plan: {
      schemaVersion: 1;
      provider: P;
      chainId: '31337';
      signer: string;
      intentHash: string;
      registryRevision: string;
      feePolicyRevision: string;
      quoteReference: P extends 'uniswap' ? string : null;
      expiresAtMs: number;
      maximumNetworkFeeRaw: string;
      maximumSpend: { assetAddress: string; amountRaw: string; recipient: string };
      minimumReceive: { assetAddress: string; amountRaw: string; recipient: string } | null;
      fees: P extends 'uniswap'
        ? { kind: 'app'; amount: { assetAddress: string; amountRaw: string; recipient: string } }[]
        : [];
      simulation: {
        blockNumber: string;
        blockHash: string;
        callsHash: string;
        observedAtMs: number;
      };
      steps: { purpose: 'approval' | 'action'; to: string; valueRaw: '0'; data: string }[];
    };
  };
}

/** Owner-scoped Honey request history; excludes external/on-chain activity. */
export interface OperationPage {
  items: { operation: OperationRecovery['operation']; createdAtMs: number; updatedAtMs: number }[];
  nextCursor: string | null;
}
export interface AaveIntentRecovery {
  operationId: string;
  signer: string;
  chainId: '31337';
  asset: string;
  registryRevision: string;
  feePolicyRevision: string;
  intent: AaveIntent;
}

export interface MorphoExecutionConfiguration {
  mode: 'local_fork';
  chainId: '31337';
  vault: string;
  bundle: string;
  asset: string;
  assetDecimals: number;
  shareDecimals: number;
  performanceFeeWad: string;
  managementFeePerSecondWad: string;
  registryRevision: string;
  feePolicyRevision: string;
  redemptionOutputProtection: 'none';
}
export interface MorphoIntent {
  vault: string;
  action: 'deposit' | 'redeem';
  amountRaw: string;
  minimumSharesRaw: string | null;
  acknowledgeUnprotectedOutput: boolean;
  deadline: string;
  maximumNetworkFeeRaw: string;
}
export type MorphoSigningRequest = EvmSigningRequest<'morpho_vault_v2'>;
export interface MorphoIntentRecovery {
  operationId: string;
  signer: string;
  chainId: '31337';
  asset: string;
  registryRevision: string;
  feePolicyRevision: string;
  intent: MorphoIntent;
}
export interface MorphoQuote {
  action: 'deposit' | 'redeem';
  amountRaw: string;
  signer: string;
  chainId: '31337';
  vault: string;
  asset: string;
  assetBalanceRaw: string;
  shareBalanceRaw: string;
  previewAssetsRaw: string;
  previewSharesRaw: string;
  registryRevision: string;
  feePolicyRevision: string;
  blockNumber: string;
  blockHash: string;
  observedAtMs: number;
  expiresAtMs: number;
}

/** Explicit curated quote registry. Receiving a quote never enables signing. */
export interface SwapQuoteConfiguration {
  provider: 'uniswap';
  chainId: string;
  router: string;
  permit2: string;
  routerVersion: '2.1.2';
  tokens: { address: string; symbol: string; decimals: number }[];
  integratorFees: { recipient: string; bps: number }[];
  registryRevision: string;
  feePolicyRevision: string;
  executionAvailable: false;
}
export interface SwapQuoteRequest {
  tokenIn: string;
  tokenOut: string;
  amountRaw: string;
  slippageBps: number;
}
export interface SwapQuote {
  provider: 'uniswap';
  routing: 'CLASSIC';
  quoteId: string;
  requestId: string;
  chainId: string;
  signer: string;
  tokenIn: string;
  tokenOut: string;
  amountInRaw: string;
  grossOutputRaw: string;
  netOutputRaw: string;
  minimumOutputRaw: string;
  slippageBps: number;
  fees: { recipient: string; bps: number; amountRaw: string }[];
  swapGasEstimateRaw: string;
  approvalGasIncluded: false;
  permitRequired: boolean;
  sourceBlock: string;
  registryRevision: string;
  feePolicyRevision: string;
  receivedAtMs: number;
  expiresAtMs: number;
  executionAvailable: false;
}
/** Exact EOA PermitSingle terms. Future execution must bind to persisted intent and fresh nonce. */
export interface Permit2Terms {
  chainId: string;
  permit2: string;
  owner: string;
  token: string;
  amountRaw: string;
  spender: string;
  nonce: string;
  expiration: string;
  sigDeadline: string;
}

/** Immutable user-reviewed policy for the CLASSIC economic proof; not execution admission. */
export interface SwapAuthority {
  chainId: string;
  owner: string;
  router: string;
  tokenIn: string;
  tokenOut: string;
  maximumInputRaw: string;
  minimumOutputRaw: string;
  deadline: string;
  feeBasis: 'settlement_balance';
  tokens: string[];
  fees: { recipient: string; maximumBps: string; maximumRoundingRaw: string }[];
}
export interface SwapRouterCall {
  chainId: string;
  from: string;
  to: string;
  valueRaw: string;
  data: string;
}
export interface SwapEconomicProof {
  maximumDebitRaw: string;
  guaranteedOutputRaw: string;
  refundTokens: string[];
  feeRecipients: string[];
}

/** Local-fork execution only; does not advertise production swap availability. */
export interface SwapExecutionConfiguration {
  mode: 'local_fork';
  quote: SwapQuoteConfiguration;
  maximumFeeRoundingRaw: '0' | '1';
}
export interface SwapIntent {
  tokenIn: string;
  tokenOut: string;
  amountRaw: string;
  slippageBps: string;
  minimumOutputRaw: string;
  deadline: string;
  maximumNetworkFeeRaw: string;
}
export interface SwapReview {
  schemaVersion: 1;
  intentHash: string;
  quoteId: string;
  providerQuoteHash: string;
  registryRevision: string;
  feePolicyRevision: string;
  authority: SwapAuthority;
  permit2: string;
  permit: Permit2Terms | null;
  maximumNetworkFeeRaw: string;
  quoteObservedAtMs: number;
  reviewedAtMs: number;
  expiresAtMs: number;
}
export interface SwapReviewRequest {
  operationId: string;
  operationVersion: string;
  reviewHash: string;
  review: SwapReview;
}
export interface SwapSigningRequest extends EvmSigningRequest<'uniswap'> {
  reviewHash: string;
  review: SwapReview;
}
export interface SwapIntentRecovery {
  operationId: string;
  signer: string;
  chainId: '31337';
  registryRevision: string;
  feePolicyRevision: string;
  intent: SwapIntent;
}

/** Provider observations are advisory; they do not establish cross-chain finality. */
export type BridgeProvider = 'relay';
export interface BridgeBinding {
  provider: BridgeProvider;
  providerReference: string;
  sourceChainId: string;
  destinationChainId: string;
  refundChainId: string;
  sourceTransactionHash: string;
}
export type BridgeReportedOutcome =
  | 'not_indexed'
  | 'pending'
  | 'fill_reported'
  | 'refund_pending'
  | 'refund_reported'
  | 'recovery_required';
export interface BridgeStatusReport {
  provider: BridgeProvider;
  reportedOutcome: BridgeReportedOutcome;
  sourceTransactionSeen: boolean;
  candidates: Array<{
    chainId: string;
    transactionHash: string;
    role: 'destination_fill' | 'refund';
  }>;
  observedAtMs: number;
  providerUpdatedAtMs: number | null;
  verificationRequired: true;
  pollAfterMs: 10000 | 60000;
}
export interface BridgeStatusRecovery {
  operationId: string;
  binding: BridgeBinding;
  observation: BridgeStatusReport | null;
  stale: boolean;
  pollVersion: string;
  nextPollAtMs: number;
  lastErrorCode:
    | 'invalid'
    | 'busy'
    | 'cooldown'
    | 'unavailable'
    | 'rejected'
    | 'invalid_response'
    | 'ambiguous'
    | 'unsupported_route'
    | null;
}

// Provider-specific NEAR Intents response types mirror the server preview contract.
export type {
  NearIntentsQuotePreview,
  NearIntentsQuoteRequest,
  NearIntentsToken,
} from './near-intents';
