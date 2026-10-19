import { base58, base64 } from '@scure/base';
import { bunkSolanaAddressBytes } from './bunk-solana';
import type { BunkSolanaCheckpoint, BunkSolanaRpc } from './bunk-solana-observe';

export const BUNK_SOLANA_TOKEN_PROGRAMS = Object.freeze([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
] as const);
/** Per owner and token program. Oversized inventories reject instead of truncating. */
export const BUNK_SOLANA_TOKEN_ACCOUNT_LIMIT = 256;
export interface BunkSolanaTokenAccount {
  address: string;
  mint: string;
  /** Public base amount only, without decimals, extension balances or adjustments. */
  amount: bigint;
  state: 'initialized' | 'frozen';
  delegate: string | null;
  delegatedAmount: bigint;
  closeAuthority: string | null;
  nativeReserve: bigint | null;
  /** Extension bodies are not fetched or interpreted. */
  extended: boolean;
}
export interface BunkSolanaTokenSnapshot {
  tokenProgram: string;
  checkpoint: BunkSolanaCheckpoint;
  accounts: BunkSolanaTokenAccount[];
  /** Mint batches can be newer than the token accounts; never imply one bank. */
  mintSnapshots: BunkSolanaMintSnapshot[];
}
export type BunkSolanaMint = { address: string } & (
  | { status: 'missing' }
  | {
      status: 'initialized';
      decimals: number;
      supply: bigint;
      mintAuthority: string | null;
      freezeAuthority: string | null;
      /** Mint extension bodies and adjusted UI amounts are not interpreted. */
      extended: boolean;
    }
);
export interface BunkSolanaMintSnapshot {
  checkpoint: BunkSolanaCheckpoint;
  mints: BunkSolanaMint[];
}
function requireTokens(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Bunk Solana tokens: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  requireTokens(
    !!value && typeof value === 'object' && !Array.isArray(value),
    'invalid RPC object',
  );
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  requireTokens(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'invalid integer',
  );
  return value;
}
function address(value: unknown): string {
  bunkSolanaAddressBytes(value as string);
  return value as string;
}
function accountData(value: unknown, program: string, kind: 'token' | 'mint'): Uint8Array {
  const account = object(value),
    space = integer(account.space),
    baseSize = kind === 'token' ? 165 : 82;
  requireTokens(account.owner === program && account.executable === false, 'foreign token program');
  requireTokens(
    program === BUNK_SOLANA_TOKEN_PROGRAMS[0]
      ? space === baseSize
      : space === baseSize || (space > 165 && space <= 10 * 1024 * 1024 && space !== 355),
    `invalid ${kind} account size`,
  );
  const encoded = account.data;
  requireTokens(
    Array.isArray(encoded) &&
      encoded.length === 2 &&
      encoded[1] === 'base64' &&
      typeof encoded[0] === 'string' &&
      encoded[0].length <= 224,
    'invalid token account encoding',
  );
  const data = base64.decode(encoded[0]);
  requireTokens(
    data.length === Math.min(space, 166) && base64.encode(data) === encoded[0],
    'invalid token data slice',
  );
  requireTokens(
    space === baseSize || data[165] === (kind === 'token' ? 2 : 1),
    'invalid extended account type',
  );
  if (kind === 'mint' && space > baseSize)
    requireTokens(
      data.subarray(82, 165).every((byte) => byte === 0),
      'invalid mint padding',
    );
  return data;
}
function present(view: DataView, offset: number): boolean {
  const tag = view.getUint32(offset, true);
  requireTokens(tag === 0 || tag === 1, 'invalid token option');
  return tag === 1;
}
function tokenAccount(value: unknown, wallet: string, program: string): BunkSolanaTokenAccount {
  const row = object(value),
    key = address(row.pubkey),
    data = accountData(row.account, program, 'token');
  requireTokens(base58.encode(data.subarray(32, 64)) === wallet, 'foreign token owner');
  requireTokens(data[108] === 1 || data[108] === 2, 'uninitialized or invalid token state');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    address: key,
    mint: base58.encode(data.subarray(0, 32)),
    amount: view.getBigUint64(64, true),
    state: data[108] === 1 ? 'initialized' : 'frozen',
    delegate: present(view, 72) ? base58.encode(data.subarray(76, 108)) : null,
    delegatedAmount: view.getBigUint64(121, true),
    closeAuthority: present(view, 129) ? base58.encode(data.subarray(133, 165)) : null,
    nativeReserve: present(view, 109) ? view.getBigUint64(113, true) : null,
    extended: data.length > 165,
  };
}
function mintAccount(key: string, value: unknown, program: string): BunkSolanaMint {
  // A mint may have closed at this newer bank. Retain the holding without guessing
  // decimals or treating absence as a zero balance. Missing array entries still fail.
  if (value === null) return { address: key, status: 'missing' };
  const data = accountData(value, program, 'mint'),
    view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  requireTokens(data[45] === 1, 'uninitialized or invalid mint');
  return {
    address: key,
    status: 'initialized',
    decimals: view.getUint8(44),
    supply: view.getBigUint64(36, true),
    mintAuthority: present(view, 0) ? base58.encode(data.subarray(4, 36)) : null,
    freezeAuthority: present(view, 46) ? base58.encode(data.subarray(50, 82)) : null,
    extended: data.length > 82,
  };
}
async function readCheckpoint(slot: number, rpc: BunkSolanaRpc): Promise<BunkSolanaCheckpoint> {
  const block = object(
    await rpc.request('getBlock', [
      slot,
      {
        commitment: 'finalized',
        transactionDetails: 'none',
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ]),
  );
  return { slot, blockhash: address(block.blockhash), blockTime: integer(block.blockTime) };
}

/** Internal discovery step. The caller must verify the wallet first, fence RPC
 * cancellation, then recheck every returned checkpoint, freshness and genesis.
 * minContextSlot is a floor; each program result has its own finalized bank. */
export async function readBunkSolanaTokenSnapshots(
  wallet: string,
  minimumSlot: number,
  rpc: BunkSolanaRpc,
): Promise<BunkSolanaTokenSnapshot[]> {
  const snapshots: BunkSolanaTokenSnapshot[] = [],
    seen = new Set<string>();
  let floor = minimumSlot;
  for (const tokenProgram of BUNK_SOLANA_TOKEN_PROGRAMS) {
    const response = object(
      await rpc.request('getTokenAccountsByOwner', [
        wallet,
        { programId: tokenProgram },
        {
          encoding: 'base64',
          commitment: 'finalized',
          minContextSlot: floor,
          dataSlice: { offset: 0, length: 166 },
        },
      ]),
    );
    const slot = integer(object(response.context).slot);
    requireTokens(slot >= floor, 'token context slot regressed');
    requireTokens(
      Array.isArray(response.value) && response.value.length <= BUNK_SOLANA_TOKEN_ACCOUNT_LIMIT,
      'invalid or oversized token inventory',
    );
    const accounts = Array.from(response.value, (value) => {
      const account = tokenAccount(value, wallet, tokenProgram);
      requireTokens(!seen.has(account.address), 'duplicate token account');
      seen.add(account.address);
      return account;
    });
    const checkpoint = await readCheckpoint(slot, rpc);
    floor = slot;
    const mintKeys = [...new Set(accounts.map((account) => account.mint))];
    const mintSnapshots: BunkSolanaMintSnapshot[] = [];
    // Standard getMultipleAccounts limit. No mint is inferred from token metadata.
    for (let offset = 0; offset < mintKeys.length; offset += 100) {
      const keys = mintKeys.slice(offset, offset + 100);
      const response = object(
        await rpc.request('getMultipleAccounts', [
          keys,
          {
            encoding: 'base64',
            commitment: 'finalized',
            minContextSlot: floor,
            dataSlice: { offset: 0, length: 166 },
          },
        ]),
      );
      const mintSlot = integer(object(response.context).slot);
      requireTokens(mintSlot >= floor, 'mint context slot regressed');
      requireTokens(
        Array.isArray(response.value) && response.value.length === keys.length,
        'incomplete mint snapshot',
      );
      const values = response.value;
      const mints = keys.map((key, i) => mintAccount(key, values[i], tokenProgram));
      mintSnapshots.push({ checkpoint: await readCheckpoint(mintSlot, rpc), mints });
      floor = mintSlot;
    }
    snapshots.push({
      tokenProgram,
      checkpoint,
      accounts,
      mintSnapshots,
    });
  }
  return snapshots;
}
