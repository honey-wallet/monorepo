// Response shapes returned by the Rust server (apps/server/src/routes).
// Keep these in sync when changing a handler's response type.

export interface Health {
  status: 'ok';
}

export interface VersionInfo {
  name: string;
  version: string;
}

/** Pairing mailbox (apps/server/src/routes/pairing.rs). */
export type PairSlot = 'hello' | 'payload';

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
