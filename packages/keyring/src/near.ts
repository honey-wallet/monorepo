import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { NEAR_NETWORKS, type NearNetwork } from './networks';

export const NEAR_DECIMALS = 24;
const U128_MAX = (1n << 128n) - 1n;
/** Kept in addition to the account's storage stake; this is a reserve, not a fee quote. */
export const NEAR_FEE_RESERVE = 10n ** 22n; // 0.01 NEAR

export function isNearAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

export function parseNearAmount(value: string): bigint {
  if (!/^(0|[1-9]\d*)(?:\.\d{1,24})?$/.test(value) || value.length > 65)
    throw new Error('Enter a NEAR amount with up to 24 decimal places');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole as string) * 10n ** 24n + BigInt(fraction.padEnd(24, '0'));
  if (amount <= 0n || amount > U128_MAX) throw new Error('NEAR amount is out of range');
  return amount;
}

export function formatNearAmount(amount: bigint): string {
  const whole = amount / 10n ** 24n;
  const fraction = (amount % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export const nearAddressOfKey = (key: Uint8Array) => bytesToHex(ed25519.getPublicKey(key));
export function nearPublicKey(accountId: string): string {
  if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error('Expected a NEAR implicit account');
  return `ed25519:${base58.encode(hexToBytes(accountId))}`;
}

export type NearTransfer = Readonly<{
  network: NearNetwork;
  signerId: string;
  receiverId: string;
  amount: bigint;
  nonce: bigint;
  blockHash: string;
  preparedAt: number;
}>;

function uint(value: bigint, bytes: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(bytes * 8)) throw new Error('Integer out of range');
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(value & 255n);
    value >>= 8n;
  }
  return out;
}
function string(value: string) {
  const bytes = utf8ToBytes(value);
  return concatBytes(uint(BigInt(bytes.length), 4), bytes);
}

/** Borsh Transaction V0 with exactly one Transfer action; no opaque actions are accepted. */
export function encodeNearTransfer(tx: NearTransfer): Uint8Array {
  nearPublicKey(tx.signerId);
  if (!isNearAccountId(tx.receiverId) || tx.receiverId === tx.signerId)
    throw new Error('Invalid NEAR recipient');
  if (tx.amount <= 0n || tx.amount > U128_MAX || tx.nonce <= 0n)
    throw new Error('Invalid NEAR transfer');
  const blockHash = base58.decode(tx.blockHash);
  if (blockHash.length !== 32) throw new Error('Invalid NEAR block hash');
  return concatBytes(
    string(tx.signerId),
    Uint8Array.of(0), // ED25519 public key
    hexToBytes(tx.signerId),
    uint(tx.nonce, 8),
    string(tx.receiverId),
    blockHash,
    uint(1n, 4), // action count
    Uint8Array.of(3), // Transfer variant
    uint(tx.amount, 16),
  );
}

export function signNearTransfer(key: Uint8Array, tx: NearTransfer) {
  if (nearAddressOfKey(key) !== tx.signerId) throw new Error('NEAR signing key does not match');
  const bytes = encodeNearTransfer(tx);
  const digest = sha256(bytes);
  return {
    hash: base58.encode(digest),
    signedTransaction: base64.encode(
      concatBytes(bytes, Uint8Array.of(0), ed25519.sign(digest, key)),
    ),
  };
}

export class NearRpcError extends Error {
  readonly detail: unknown;
  constructor(detail: unknown) {
    super('NEAR RPC request failed');
    this.detail = detail;
  }
  hasCause(name: string) {
    const error = this.detail as {
      cause?: { name?: string };
      data?: { cause?: { name?: string } };
    };
    return error?.cause?.name === name || error?.data?.cause?.name === name;
  }
}

type Rpc = (method: string, params: unknown) => Promise<unknown>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid NEAR response');
  return value as Record<string, unknown>;
}
function integer(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 39)
    return BigInt(value);
  throw new Error('Invalid NEAR integer');
}

export function createNearRpc(network: NearNetwork, fetcher: typeof fetch = fetch): Rpc {
  return async (method, params) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetcher(NEAR_NETWORKS[network].rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'honey-near', method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`NEAR RPC unavailable (${response.status})`);
      const envelope = object(await response.json());
      if (envelope.error) throw new NearRpcError(envelope.error);
      if (!('result' in envelope)) throw new Error('Invalid NEAR RPC response');
      return envelope.result;
    } finally {
      clearTimeout(timeout);
    }
  };
}

export type NearBalance = { amount: bigint; available: bigint; exists: boolean };

/** Injectable RPC keeps transport tests deterministic and never needs a funded account. */
export function createNearClient(network: NearNetwork, rpc: Rpc = createNearRpc(network)) {
  async function account(accountId: string) {
    if (!isNearAccountId(accountId)) throw new Error('Invalid NEAR account');
    try {
      return object(
        await rpc('query', {
          request_type: 'view_account',
          account_id: accountId,
          finality: 'final',
        }),
      );
    } catch (error) {
      if (error instanceof NearRpcError && error.hasCause('UNKNOWN_ACCOUNT')) return null;
      throw error;
    }
  }
  async function balance(accountId: string): Promise<NearBalance> {
    const state = await account(accountId);
    if (!state) return { amount: 0n, available: 0n, exists: false };
    const config = object(
      await rpc('EXPERIMENTAL_protocol_config', { block_id: state.block_hash }),
    );
    if (config.chain_id !== network) throw new Error('Wrong NEAR network');
    const storagePrice = integer(object(config.runtime_config).storage_amount_per_byte);
    if (storagePrice <= 0n) throw new Error('Invalid NEAR storage price');
    const amount = integer(state.amount);
    const storage = integer(state.storage_usage) * storagePrice;
    const locked = integer(state.locked);
    // Staked NEAR can cover storage. `amount` already excludes the staked balance.
    const reserve = (storage > locked ? storage - locked : 0n) + NEAR_FEE_RESERVE;
    return { amount, available: amount > reserve ? amount - reserve : 0n, exists: true };
  }
  return {
    balance,
    async prepare(signerId: string, receiverId: string, amount: string): Promise<NearTransfer> {
      const publicKey = nearPublicKey(signerId);
      if (!isNearAccountId(receiverId) || receiverId === signerId)
        throw new Error('Invalid NEAR recipient');
      if (
        (network === 'mainnet' && receiverId.endsWith('.testnet')) ||
        (network === 'testnet' && receiverId.endsWith('.near'))
      )
        throw new Error('Recipient belongs to another NEAR network');
      const deposit = parseNearAmount(amount);
      const [funds, access, recipient] = await Promise.all([
        balance(signerId),
        rpc('query', {
          request_type: 'view_access_key',
          account_id: signerId,
          public_key: publicKey,
          finality: 'final',
        }).then(object),
        account(receiverId),
      ]);
      if (!funds.exists || deposit > funds.available)
        throw new Error('Insufficient spendable NEAR (including storage and fee reserve)');
      if (!recipient && !/^[0-9a-f]{64}$/.test(receiverId))
        throw new Error('NEAR recipient account does not exist');
      if (access.permission !== 'FullAccess')
        throw new Error('NEAR transfer requires a full access key');
      const tx = Object.freeze({
        network,
        signerId,
        receiverId,
        amount: deposit,
        nonce: integer(access.nonce) + 1n,
        blockHash: String(access.block_hash),
        preparedAt: Date.now(),
      });
      encodeNearTransfer(tx);
      return tx;
    },
    async submit(signed: string) {
      return rpc('send_tx', { signed_tx_base64: signed, wait_until: 'FINAL' });
    },
    async status(hash: string, signerId: string) {
      return rpc('tx', { tx_hash: hash, sender_account_id: signerId, wait_until: 'FINAL' });
    },
  };
}

/** Inclusion alone is not success: require finalized execution and matching transaction. */
export function nearTransferOutcome(
  result: unknown,
  hash: string,
  signerId: string,
): 'pending' | 'success' | 'failure' {
  const response = object(result);
  if (response.final_execution_status !== 'FINAL') return 'pending';
  const tx = object(response.transaction);
  if (tx.hash !== hash || tx.signer_id !== signerId)
    throw new Error('NEAR transaction response mismatch');
  const status = object(response.status);
  if (typeof status.SuccessValue === 'string') return 'success';
  if ('Failure' in status) return 'failure';
  return 'pending';
}
