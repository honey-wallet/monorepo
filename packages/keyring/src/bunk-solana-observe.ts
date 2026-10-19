import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import {
  BUNK_SOLANA_SYSTEM,
  type BunkSolanaAccount,
  type BunkSolanaHash,
  type BunkSolanaScope,
  type BunkSolanaState,
  bunkSolanaAddressBytes,
  bunkSolanaWallet,
  decodeBunkSolanaState,
} from './bunk-solana';

/** Must come from a trusted release registry, not an RPC-discovered self-attestation. */
export interface BunkSolanaRelease {
  genesisHash: string;
  program: string;
  programData: string;
  codeSha256: BunkSolanaHash;
  codeLength: number;
  upgradeAuthority: string | null;
}
export interface BunkSolanaRpc {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}
export interface BunkSolanaAccess {
  rpc: BunkSolanaRpc;
  /** Unix seconds. */
  now(): number;
  maxFinalizedAgeSeconds: number;
}
export interface BunkSolanaCheckpoint {
  slot: number;
  blockhash: string;
  blockTime: number;
}
export interface BunkSolanaObservation {
  scope: BunkSolanaScope;
  wallet: string;
  checkpoint: BunkSolanaCheckpoint;
  account: BunkSolanaAccount | null;
  state: BunkSolanaState | null;
  lamports: bigint;
}
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid Solana RPC object');
  return v as Record<string, unknown>;
}
function integer(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new Error('Unsafe Solana RPC integer');
  return v;
}
function address(v: unknown): string {
  bunkSolanaAddressBytes(v as string);
  return v as string;
}
export function checkBunkSolanaRelease(input: BunkSolanaRelease): BunkSolanaRelease {
  const c = {
    genesisHash: address(input.genesisHash),
    program: address(input.program),
    programData: address(input.programData),
    codeSha256: input.codeSha256,
    codeLength: integer(input.codeLength),
    upgradeAuthority: input.upgradeAuthority === null ? null : address(input.upgradeAuthority),
  };
  if (
    [c.genesisHash, c.program, c.programData].includes(BUNK_SOLANA_SYSTEM) ||
    c.program === c.programData ||
    !/^0x[0-9a-f]{64}$/.test(c.codeSha256) ||
    c.codeSha256 === `0x${'0'.repeat(64)}` ||
    c.codeLength < 1 ||
    c.codeLength > 10 * 1024 * 1024
  )
    throw new Error('Invalid Solana release');
  return c;
}
function rpcAccount(v: unknown, key: string, maxBytes: number) {
  if (v === null) return null;
  const a = object(v);
  if (
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length > Math.ceil(maxBytes / 3) * 4 ||
    typeof a.executable !== 'boolean'
  )
    throw new Error('Invalid Solana RPC account encoding');
  const data = base64.decode(a.data[0]);
  if (data.length > maxBytes || base64.encode(data) !== a.data[0])
    throw new Error('Noncanonical Solana account data');
  return {
    address: key,
    owner: address(a.owner),
    executable: a.executable,
    data,
    lamports: BigInt(integer(a.lamports)),
  };
}
function checkpoint(slot: number, value: unknown): BunkSolanaCheckpoint {
  const b = object(value);
  return { slot: integer(slot), blockhash: address(b.blockhash), blockTime: integer(b.blockTime) };
}
const blockParams = (slot: number) => [
  slot,
  {
    commitment: 'finalized',
    transactionDetails: 'none',
    rewards: false,
    maxSupportedTransactionVersion: 0,
  },
];
function fresh(c: BunkSolanaCheckpoint, access: BunkSolanaAccess) {
  const now = access.now(),
    max = access.maxFinalizedAgeSeconds;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 3600 ||
    c.blockTime > now + 5 ||
    now - c.blockTime > max
  )
    throw new Error('Stale or invalid finalized Solana checkpoint');
}
/** One getMultipleAccounts bank contains program, code and wallet. The trusted RPC
 * remains a trust boundary: this is not a cryptographic account-state proof. */
export async function observeBunkSolanaAccount(
  releaseInput: BunkSolanaRelease,
  identityInput: string,
  accountIndex: number,
  access: BunkSolanaAccess,
  previous?: BunkSolanaCheckpoint,
): Promise<BunkSolanaObservation> {
  const release = checkBunkSolanaRelease(releaseInput),
    identity = address(identityInput);
  const scope = { genesisHash: release.genesisHash, program: release.program, accountIndex };
  const wallet = bunkSolanaWallet(release.program, identity, accountIndex).address;
  const prior = previous && {
    slot: integer(previous.slot),
    blockhash: address(previous.blockhash),
    blockTime: integer(previous.blockTime),
  };
  const rpc = access.rpc;
  if ((await rpc.request('getGenesisHash', [])) !== release.genesisHash)
    throw new Error('Wrong Solana genesis');
  if (prior) {
    const old = checkpoint(prior.slot, await rpc.request('getBlock', blockParams(prior.slot)));
    if (old.blockhash !== prior.blockhash || old.blockTime !== prior.blockTime)
      throw new Error('Solana finalized anchor changed');
  }
  const response = object(
    await rpc.request('getMultipleAccounts', [
      [release.program, release.programData, wallet],
      { encoding: 'base64', commitment: 'finalized', minContextSlot: prior?.slot ?? 0 },
    ]),
  );
  const slot = integer(object(response.context).slot);
  if (prior && slot < prior.slot) throw new Error('Solana finalized slot regressed');
  if (!Array.isArray(response.value) || response.value.length !== 3)
    throw new Error('Incomplete Solana account snapshot');
  const program = rpcAccount(response.value[0], release.program, 36);
  const code = rpcAccount(response.value[1], release.programData, 10 * 1024 * 1024 + 45);
  const walletAccount = rpcAccount(response.value[2], wallet, 157);
  if (
    !program ||
    program.owner !== LOADER ||
    !program.executable ||
    program.data.length !== 36 ||
    new DataView(program.data.buffer).getUint32(0, true) !== 2 ||
    base58.encode(program.data.slice(4)) !== release.programData
  )
    throw new Error('Unexpected Solana program account');
  if (
    !code ||
    code.owner !== LOADER ||
    code.executable ||
    code.data.length < 45 + release.codeLength ||
    new DataView(code.data.buffer).getUint32(0, true) !== 3
  )
    throw new Error('Unexpected Solana program-data account');
  const authority =
    code.data[12] === 0
      ? null
      : code.data[12] === 1
        ? base58.encode(code.data.slice(13, 45))
        : undefined;
  if (
    authority !== release.upgradeAuthority ||
    `0x${bytesToHex(sha256(code.data.slice(45, 45 + release.codeLength)))}` !==
      release.codeSha256 ||
    code.data.slice(45 + release.codeLength).some(Boolean) ||
    new DataView(code.data.buffer).getBigUint64(4, true) > BigInt(slot)
  )
    throw new Error('Solana deployment code/upgrade policy mismatch');
  let account: BunkSolanaAccount | null = null,
    state: BunkSolanaState | null = null;
  if (
    walletAccount &&
    !(
      walletAccount.owner === BUNK_SOLANA_SYSTEM &&
      !walletAccount.executable &&
      walletAccount.data.length === 0
    )
  ) {
    account = {
      address: wallet,
      owner: walletAccount.owner,
      executable: walletAccount.executable,
      data: walletAccount.data.slice(),
    };
    state = decodeBunkSolanaState(scope, account);
    if (state.identity !== identity) throw new Error('Foreign Solana wallet identity');
  }
  const anchor = checkpoint(slot, await rpc.request('getBlock', blockParams(slot)));
  fresh(anchor, access);
  const finalAnchor = checkpoint(slot, await rpc.request('getBlock', blockParams(slot)));
  if (
    finalAnchor.blockhash !== anchor.blockhash ||
    finalAnchor.blockTime !== anchor.blockTime ||
    (await rpc.request('getGenesisHash', [])) !== release.genesisHash
  )
    throw new Error('Solana observation changed during verification');
  fresh(anchor, access);
  return {
    scope,
    wallet,
    checkpoint: anchor,
    account,
    state,
    lamports: walletAccount?.lamports ?? 0n,
  };
}
