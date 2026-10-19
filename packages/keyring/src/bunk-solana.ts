import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { BUNK_MAX_INDEX } from './bunk';

/** New recovery namespace; existing Bunk v1 paths are unchanged. Wire protocol is v1. */
export const BUNK_SOLANA_DERIVATION_VERSION = 2 as const;
export const BUNK_SOLANA_SYSTEM = '11111111111111111111111111111111';
export const BUNK_SOLANA_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111';
export const BUNK_SOLANA_ED25519 = 'Ed25519SigVerify111111111111111111111111111';
export type BunkSolanaHash = `0x${string}`;
export interface BunkSolanaScope {
  genesisHash: string;
  program: string;
  accountIndex: number;
}
export type BunkSolanaKeyRef = BunkSolanaScope &
  (
    | { role: 'deployment' }
    | { role: 'owner'; epoch: number; ownerIndex: number }
    | { role: 'recovery'; epoch: number }
  );
export interface BunkSolanaKey {
  derivationVersion: 2;
  path: string;
  publicKey: string;
  commitment: BunkSolanaHash;
}
export interface BunkSolanaMeta {
  address: string;
  writable: boolean;
  signer: boolean;
}
export interface BunkSolanaInstruction {
  program: string;
  accounts: BunkSolanaMeta[];
  data: Uint8Array;
}
export interface BunkSolanaState {
  genesisHash: string;
  identity: string;
  accountIndex: number;
  epoch: number;
  ownerIndex: number;
  nonce: bigint;
  owner: BunkSolanaHash;
  recovery: BunkSolanaHash;
  bump: number;
}
export interface BunkSolanaAccount {
  address: string;
  owner: string;
  executable: boolean;
  data: Uint8Array;
}
export type BunkSolanaAction =
  | { kind: 'native'; destination: string; lamports: bigint }
  | { kind: 'cpi'; program: string; accounts: readonly BunkSolanaMeta[]; data: Uint8Array };
export interface BunkSolanaPrepared {
  kind: 'initialize' | 'execute' | 'recover';
  key: BunkSolanaKeyRef;
  signer: BunkSolanaKey;
  wallet: string;
  digest: BunkSolanaHash;
  instruction: BunkSolanaInstruction;
}
const hex = (b: Uint8Array): BunkSolanaHash => `0x${bytesToHex(b)}`;
function hashBytes(value: BunkSolanaHash): Uint8Array {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value))
    throw new Error('Expected canonical 32-byte Solana commitment');
  return hexToBytes(value.slice(2));
}
function index(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > BUNK_MAX_INDEX)
    throw new Error('Solana index out of range');
  return value;
}
function uint(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn)
    throw new Error('Expected Solana u64');
  return value;
}
function le(value: bigint | number, size: 2 | 4 | 8): Uint8Array {
  const out = new Uint8Array(size),
    view = new DataView(out.buffer);
  if (size === 8) view.setBigUint64(0, uint(value as bigint), true);
  else if (size === 4) view.setUint32(0, index(value as number), true);
  else view.setUint16(0, value as number, true);
  return out;
}
export function bunkSolanaAddressBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
    throw new Error('Expected canonical Solana address');
  const bytes = base58.decode(value);
  if (bytes.length !== 32 || base58.encode(bytes) !== value)
    throw new Error('Expected 32-byte Solana address');
  return bytes;
}
function scope(input: BunkSolanaScope): BunkSolanaScope {
  for (const value of [input.genesisHash, input.program])
    if (!bunkSolanaAddressBytes(value).some(Boolean)) throw new Error('Empty Solana scope');
  return {
    genesisHash: input.genesisHash,
    program: input.program,
    accountIndex: index(input.accountIndex),
  };
}
function parts(value: string): number[] {
  const n = BigInt(hex(bunkSolanaAddressBytes(value)));
  return Array.from({ length: 9 }, (_, i) => Number((n >> BigInt(31 * (8 - i))) & 0x7fffffffn));
}
/** Every component is hardened. Genesis/program use full big-endian uint256,
 * encoded as nine fixed-width base-2^31 digits, including leading zeros. */
export function bunkSolanaKeyPath(ref: BunkSolanaKeyRef): string {
  const c = scope(ref);
  const role = { owner: 0, deployment: 2, recovery: 3 }[ref.role];
  if (role === undefined) throw new Error('Unknown Solana key role');
  const path = [7744, 2, role, 501, ...parts(c.genesisHash), ...parts(c.program), c.accountIndex];
  if (ref.role !== 'deployment') path.push(index(ref.epoch));
  if (ref.role === 'owner') path.push(index(ref.ownerIndex));
  return `m/${path.map((n) => `${n}'`).join('/')}`;
}
/** Low-level internal signing primitive. Does NOT implement a durable key claim.
 * Integration must persist one exact digest before use; caller must clear output. */
export function bunkSolanaPrivateKey(seed: Uint8Array, ref: BunkSolanaKeyRef): Uint8Array {
  const path = bunkSolanaKeyPath(ref);
  if (!(seed instanceof Uint8Array) || seed.length !== 64)
    throw new Error('Expected 64-byte BIP-39 seed');
  let node = hmac(sha512, utf8ToBytes('ed25519 seed'), seed);
  try {
    for (const component of path.split('/').slice(1)) {
      const data = new Uint8Array(37);
      try {
        data.set(node.subarray(0, 32), 1);
        new DataView(data.buffer).setUint32(33, Number(component.slice(0, -1)) + 0x80000000);
        const next = hmac(sha512, node.subarray(32), data);
        node.fill(0);
        node = next;
      } finally {
        data.fill(0);
      }
    }
    return node.slice(0, 32);
  } finally {
    node.fill(0);
  }
}
export function deriveBunkSolanaKey(seed: Uint8Array, ref: BunkSolanaKeyRef): BunkSolanaKey {
  const key = bunkSolanaPrivateKey(seed, ref);
  try {
    const publicKey = ed25519.getPublicKey(key);
    return {
      derivationVersion: 2,
      path: bunkSolanaKeyPath(ref),
      publicKey: base58.encode(publicKey),
      commitment: hex(sha256(publicKey)),
    };
  } finally {
    key.fill(0);
  }
}
function pda(program: string, seeds: Uint8Array[]) {
  const programBytes = bunkSolanaAddressBytes(program);
  for (let bump = 255; bump >= 0; bump--) {
    const bytes = sha256(
      concatBytes(
        ...seeds,
        Uint8Array.of(bump),
        programBytes,
        utf8ToBytes('ProgramDerivedAddress'),
      ),
    );
    try {
      ed25519.Point.fromBytes(bytes, true);
    } catch {
      return { address: base58.encode(bytes), bump };
    }
  }
  throw new Error('No Solana PDA bump');
}
export function bunkSolanaWallet(program: string, identity: string, accountIndex: number) {
  return pda(program, [
    utf8ToBytes('wallet-v1'),
    bunkSolanaAddressBytes(identity),
    le(accountIndex, 4),
  ]);
}
export function bunkSolanaSpent(program: string, wallet: string, commitment: BunkSolanaHash) {
  return pda(program, [
    utf8ToBytes('spent-v1'),
    bunkSolanaAddressBytes(wallet),
    hashBytes(commitment),
  ]);
}
/** Structural validation only: does not establish RPC trust, finality or freshness. */
export function decodeBunkSolanaState(
  input: BunkSolanaScope,
  account: BunkSolanaAccount,
): BunkSolanaState {
  const c = scope(input),
    b = account.data;
  if (
    !(b instanceof Uint8Array) ||
    b.length !== 157 ||
    hex(b.slice(0, 8)) !== hex(utf8ToBytes('HNYBUNK1')) ||
    account.owner !== c.program ||
    account.executable !== false
  )
    throw new Error('Invalid Solana wallet account');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const state = {
    genesisHash: base58.encode(b.slice(8, 40)),
    identity: base58.encode(b.slice(40, 72)),
    accountIndex: index(v.getUint32(72, true)),
    epoch: index(v.getUint32(76, true)),
    ownerIndex: index(v.getUint32(80, true)),
    nonce: v.getBigUint64(84, true),
    owner: hex(b.slice(92, 124)),
    recovery: hex(b.slice(124, 156)),
    bump: v.getUint8(156),
  };
  const expected = bunkSolanaWallet(c.program, state.identity, state.accountIndex);
  if (
    state.genesisHash !== c.genesisHash ||
    state.accountIndex !== c.accountIndex ||
    state.identity === BUNK_SOLANA_SYSTEM ||
    account.address !== expected.address ||
    state.bump !== expected.bump
  )
    throw new Error('Solana wallet identity mismatch');
  roots(state.identity, state.owner, state.recovery);
  return state;
}
function roots(identity: string, ...values: BunkSolanaHash[]) {
  const identityRoot = hex(sha256(bunkSolanaAddressBytes(identity)));
  if (
    new Set(values).size !== values.length ||
    values.some((v) => !hashBytes(v).some(Boolean) || v === identityRoot)
  )
    throw new Error('Invalid or reused Solana authority');
}
const meta = (address: string, writable = false, signer = false): BunkSolanaMeta => {
  bunkSolanaAddressBytes(address);
  return { address, writable, signer };
};
function controls(
  wallet: string,
  payer: string,
  identity: string,
  owner: BunkSolanaHash,
  recovery: BunkSolanaHash,
  successors: BunkSolanaHash[] = [],
) {
  const payerRoot = hex(sha256(bunkSolanaAddressBytes(payer)));
  if (
    [owner, recovery, ...successors, hex(sha256(bunkSolanaAddressBytes(identity)))].includes(
      payerRoot,
    )
  )
    throw new Error('Rotating/deployment key cannot be the payer');
  return [
    meta(wallet, true),
    meta(payer, true, true),
    meta(BUNK_SOLANA_INSTRUCTIONS),
    meta(BUNK_SOLANA_SYSTEM),
  ];
}
function unique(accounts: BunkSolanaMeta[]) {
  if (new Set(accounts.map((a) => a.address)).size !== accounts.length)
    throw new Error('Duplicate Solana control accounts');
}
export function bunkSolanaDigest(
  c: BunkSolanaScope,
  wallet: string,
  data: Uint8Array,
  actionKeys: readonly string[],
): BunkSolanaHash {
  scope(c);
  if (
    !(data instanceof Uint8Array) ||
    data.length > 700 ||
    !Array.isArray(actionKeys) ||
    actionKeys.length > 13
  )
    throw new Error('Solana authorization exceeds program bounds');
  return hex(
    sha256(
      concatBytes(
        utf8ToBytes('HoneyBunkSolanaV1'),
        bunkSolanaAddressBytes(c.program),
        bunkSolanaAddressBytes(wallet),
        bunkSolanaAddressBytes(c.genesisHash),
        le(data.length, 4),
        data,
        le(actionKeys.length, 2),
        ...actionKeys.map(bunkSolanaAddressBytes),
      ),
    ),
  );
}
function prepared(
  kind: BunkSolanaPrepared['kind'],
  seed: Uint8Array,
  key: BunkSolanaKeyRef,
  wallet: string,
  accounts: BunkSolanaMeta[],
  data: Uint8Array,
  actionKeys: string[],
): BunkSolanaPrepared {
  return {
    kind,
    key,
    signer: deriveBunkSolanaKey(seed, key),
    wallet,
    digest: bunkSolanaDigest(key, wallet, data, actionKeys),
    instruction: { program: key.program, accounts, data },
  };
}
/** Unsigned preparation only. Application must still verify release, finalized
 * state, simulation, rent/sponsorship and the complete serialized transport. */
export function prepareBunkSolanaInitialization(
  seed: Uint8Array,
  input: BunkSolanaScope,
  payer: string,
): BunkSolanaPrepared {
  const c = scope(input),
    key = { ...c, role: 'deployment' } as const;
  const identity = deriveBunkSolanaKey(seed, key).publicKey;
  const owner = deriveBunkSolanaKey(seed, {
    ...c,
    role: 'owner',
    epoch: 0,
    ownerIndex: 0,
  }).commitment;
  const recovery = deriveBunkSolanaKey(seed, { ...c, role: 'recovery', epoch: 0 }).commitment;
  roots(identity, owner, recovery);
  const wallet = bunkSolanaWallet(c.program, identity, c.accountIndex).address;
  const accounts = [
    ...controls(wallet, payer, identity, owner, recovery),
    meta(bunkSolanaSpent(c.program, wallet, owner).address),
    meta(bunkSolanaSpent(c.program, wallet, recovery).address),
  ];
  unique(accounts);
  const data = concatBytes(
    Uint8Array.of(0),
    bunkSolanaAddressBytes(c.genesisHash),
    bunkSolanaAddressBytes(identity),
    le(c.accountIndex, 4),
    hashBytes(owner),
    hashBytes(recovery),
  );
  return prepared('initialize', seed, key, wallet, accounts, data, []);
}
function stateFor(seed: Uint8Array, c: BunkSolanaScope, account: BunkSolanaAccount) {
  const state = decodeBunkSolanaState(c, account);
  if (state.identity !== deriveBunkSolanaKey(seed, { ...c, role: 'deployment' }).publicKey)
    throw new Error('Phrase does not match Solana deployment identity');
  return state;
}
export function prepareBunkSolanaExecution(
  seed: Uint8Array,
  input: BunkSolanaScope,
  account: BunkSolanaAccount,
  payer: string,
  action: BunkSolanaAction,
  window: { validAfter: bigint; validUntil: bigint },
): BunkSolanaPrepared {
  const c = scope(input),
    state = stateFor(seed, c, account),
    wallet = account.address;
  if (state.ownerIndex === BUNK_MAX_INDEX || state.nonce === 0xffffffffffffffffn)
    throw new Error('Solana owner/nonce exhausted');
  const key = { ...c, role: 'owner', epoch: state.epoch, ownerIndex: state.ownerIndex } as const;
  if (
    state.owner !== deriveBunkSolanaKey(seed, key).commitment ||
    state.recovery !==
      deriveBunkSolanaKey(seed, { ...c, role: 'recovery', epoch: state.epoch }).commitment
  )
    throw new Error('Phrase does not match Solana authorities');
  const next = deriveBunkSolanaKey(seed, { ...key, ownerIndex: state.ownerIndex + 1 }).commitment;
  roots(state.identity, state.owner, state.recovery, next);
  const accounts = [
    ...controls(wallet, payer, state.identity, state.owner, state.recovery, [next]),
    meta(bunkSolanaSpent(c.program, wallet, state.owner).address, true),
    meta(bunkSolanaSpent(c.program, wallet, next).address),
  ];
  unique(accounts);
  const after = uint(window.validAfter),
    until = uint(window.validUntil);
  if (until === 0n || after > until) throw new Error('Invalid Solana slot window');
  let payload: Uint8Array;
  if (action.kind === 'native') {
    if (uint(action.lamports) === 0n) throw new Error('Zero Solana transfer');
    accounts.push(meta(action.destination, true));
    unique(accounts);
    payload = concatBytes(Uint8Array.of(0), le(action.lamports, 8));
  } else if (action.kind === 'cpi') {
    if (
      !Array.isArray(action.accounts) ||
      action.accounts.length < 1 ||
      action.accounts.length > 12 ||
      !(action.data instanceof Uint8Array) ||
      action.data.length > 512
    )
      throw new Error('Invalid Solana CPI bounds');
    if (action.program === c.program) throw new Error('Self CPI forbidden');
    accounts.push(meta(action.program));
    unique(accounts);
    const forbidden = new Set(accounts.slice(1).map((a) => a.address));
    const flags: number[] = [];
    for (const a of action.accounts) {
      if (
        typeof a.writable !== 'boolean' ||
        typeof a.signer !== 'boolean' ||
        forbidden.has(a.address) ||
        (a.address === wallet ? a.writable || !a.signer : a.signer)
      )
        throw new Error('Invalid Solana CPI privileges or duplicate accounts');
      forbidden.add(a.address);
      flags.push(Number(a.writable) | (Number(a.signer) << 1));
      accounts.push(meta(a.address, a.writable));
    }
    payload = concatBytes(
      Uint8Array.of(1, action.accounts.length, ...flags),
      le(action.data.length, 2),
      action.data,
    );
  } else throw new Error('Unknown Solana action');
  const data = concatBytes(
    Uint8Array.of(1),
    le(state.epoch, 4),
    le(state.ownerIndex, 4),
    le(state.nonce, 8),
    le(after, 8),
    le(until, 8),
    hashBytes(next),
    payload,
  );
  return prepared(
    'execute',
    seed,
    key,
    wallet,
    accounts,
    data,
    accounts.slice(6).map((a) => a.address),
  );
}
export function prepareBunkSolanaRecovery(
  seed: Uint8Array,
  input: BunkSolanaScope,
  account: BunkSolanaAccount,
  payer: string,
): BunkSolanaPrepared {
  const c = scope(input),
    state = stateFor(seed, c, account),
    wallet = account.address;
  if (state.epoch === BUNK_MAX_INDEX) throw new Error('Solana generation exhausted');
  const key = { ...c, role: 'recovery', epoch: state.epoch } as const;
  if (state.recovery !== deriveBunkSolanaKey(seed, key).commitment)
    throw new Error('Phrase does not match Solana recovery authority');
  const nextOwner = deriveBunkSolanaKey(seed, {
    ...c,
    role: 'owner',
    epoch: state.epoch + 1,
    ownerIndex: 0,
  }).commitment;
  const nextRecovery = deriveBunkSolanaKey(seed, {
    ...c,
    role: 'recovery',
    epoch: state.epoch + 1,
  }).commitment;
  roots(state.identity, state.owner, state.recovery, nextOwner, nextRecovery);
  const accounts = [
    ...controls(wallet, payer, state.identity, state.owner, state.recovery, [
      nextOwner,
      nextRecovery,
    ]),
    meta(bunkSolanaSpent(c.program, wallet, state.owner).address, true),
    meta(bunkSolanaSpent(c.program, wallet, state.recovery).address, true),
    meta(bunkSolanaSpent(c.program, wallet, nextOwner).address),
    meta(bunkSolanaSpent(c.program, wallet, nextRecovery).address),
  ];
  unique(accounts);
  return prepared(
    'recover',
    seed,
    key,
    wallet,
    accounts,
    concatBytes(
      Uint8Array.of(2),
      le(state.epoch, 4),
      hashBytes(nextOwner),
      hashBytes(nextRecovery),
    ),
    [],
  );
}
/** Assemble an already-produced signature, checking canonical Ed25519 verification.
 * This function does not sign, persist a claim or authorize an operation. */
export function bunkSolanaPrecompile(
  publicKey: string,
  digest: BunkSolanaHash,
  signature: Uint8Array,
): BunkSolanaInstruction {
  const key = bunkSolanaAddressBytes(publicKey),
    message = hashBytes(digest);
  if (
    !(signature instanceof Uint8Array) ||
    signature.length !== 64 ||
    !ed25519.verify(signature, message, key, { zip215: false })
  )
    throw new Error('Invalid Solana authorization signature');
  return {
    program: BUNK_SOLANA_ED25519,
    accounts: [],
    data: concatBytes(
      Uint8Array.of(1, 0, 48, 0, 255, 255, 16, 0, 255, 255, 112, 0, 32, 0, 255, 255),
      key,
      signature,
      message,
    ),
  };
}
