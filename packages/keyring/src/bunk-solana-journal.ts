import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  BunkJournalConflict,
  type BunkJournalStore,
  BunkSigningUncertain,
  checkBunkJournalRevision,
} from './bunk-evm-v2-journal';
import {
  type BunkSolanaAccount,
  type BunkSolanaAction,
  type BunkSolanaHash,
  type BunkSolanaPrepared,
  type BunkSolanaScope,
  bunkSolanaAddressBytes,
  bunkSolanaPrecompile,
  bunkSolanaPrivateKey,
  bunkSolanaWallet,
  decodeBunkSolanaState,
  deriveBunkSolanaKey,
  prepareBunkSolanaExecution,
  prepareBunkSolanaInitialization,
  prepareBunkSolanaRecovery,
} from './bunk-solana';
import {
  type BunkSolanaAccess,
  type BunkSolanaCheckpoint,
  type BunkSolanaObservation,
  type BunkSolanaRelease,
  checkBunkSolanaRelease,
  observeBunkSolanaAccount,
} from './bunk-solana-observe';

type WireAction =
  | { kind: 'native'; destination: string; lamports: string }
  | {
      kind: 'cpi';
      program: string;
      accounts: { address: string; writable: boolean; signer: boolean }[];
      data: string;
    };
type Slot = {
  kind: 'initialize' | 'execute' | 'recover';
  baseline: string | null;
  action: WireAction | null;
  validAfter: string | null;
  validUntil: string | null;
  payer: string;
  digest: BunkSolanaHash;
  phase: 'reserved' | 'signing' | 'signed';
  signature: string | null;
};
interface RecordValue {
  format: 'honey-solana-account';
  version: 1;
  key: string;
  release: BunkSolanaRelease;
  accountIndex: number;
  identity: string;
  wallet: string;
  phase: 'restoring' | 'ready';
  checkpoint: BunkSolanaCheckpoint;
  account: string | null;
  bootstrap: Slot | null;
  recovery: Slot | null;
  owner: Slot | null;
}
export class BunkSolanaRestoreRequired extends Error {
  constructor(detail = 'Solana history is unavailable or changed; start generation recovery') {
    super(detail);
    this.name = 'BunkSolanaRestoreRequired';
  }
}
function json(v: unknown): string {
  return JSON.stringify(v);
}
function fields(v: unknown, names: string): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(' ') !== names.split(' ').sort().join(' ')
  )
    throw new Error('Invalid Solana journal fields');
}
function decimal(v: unknown): bigint {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v) || BigInt(v) > 0xffffffffffffffffn)
    throw new Error('Invalid Solana journal integer');
  return BigInt(v);
}
function bytes(v: unknown, max: number): Uint8Array {
  if (typeof v !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(v) || v.length > max * 2)
    throw new Error('Invalid Solana journal bytes');
  return hexToBytes(v);
}
function wireAction(a: BunkSolanaAction): WireAction {
  if (a.kind === 'native' && typeof a.lamports !== 'bigint')
    throw new Error('Expected bigint lamports');
  if (a.kind === 'native')
    return { kind: 'native', destination: a.destination, lamports: a.lamports.toString() };
  return {
    kind: 'cpi',
    program: a.program,
    accounts: a.accounts.map((m) => ({
      address: m.address,
      writable: m.writable,
      signer: m.signer,
    })),
    data: bytesToHex(a.data),
  };
}
function action(a: WireAction): BunkSolanaAction {
  if (a.kind === 'native') {
    fields(a, 'kind destination lamports');
    return { ...a, lamports: decimal(a.lamports) };
  }
  fields(a, 'kind program accounts data');
  if (a.kind !== 'cpi' || !Array.isArray(a.accounts))
    throw new Error('Invalid Solana journal action');
  for (const m of a.accounts) fields(m, 'address writable signer');
  return { ...a, data: bytes(a.data, 512), accounts: a.accounts.map((m) => ({ ...m })) };
}
function scope(r: RecordValue): BunkSolanaScope {
  return {
    genesisHash: r.release.genesisHash,
    program: r.release.program,
    accountIndex: r.accountIndex,
  };
}
function account(r: RecordValue, data: string): BunkSolanaAccount {
  return { address: r.wallet, owner: r.release.program, executable: false, data: bytes(data, 157) };
}
export function bunkSolanaAccountJournalKey(c: BunkSolanaScope, wallet: string): string {
  return `bunk-solana-account:${bytesToHex(sha256(concatBytes(utf8ToBytes('HoneySolanaAccountJournalV1'), bunkSolanaAddressBytes(c.genesisHash), bunkSolanaAddressBytes(c.program), bunkSolanaAddressBytes(wallet))))}`;
}
function checkKey(key: string) {
  if (
    typeof key !== 'string' ||
    !/^bunk-solana-account:[0-9a-f]{64}$/.test(key) ||
    key.endsWith('0'.repeat(64))
  )
    throw new Error('Invalid Solana journal key');
}
function prepare(
  seed: Uint8Array,
  r: RecordValue,
  s: Slot,
  live?: BunkSolanaAccount,
  payer = s.payer,
): BunkSolanaPrepared {
  if (s.kind === 'initialize') return prepareBunkSolanaInitialization(seed, scope(r), payer);
  if (!s.baseline) throw new Error('Missing Solana approval baseline');
  const a = live ?? account(r, s.baseline);
  if (s.kind === 'recover') return prepareBunkSolanaRecovery(seed, scope(r), a, payer);
  if (!s.action) throw new Error('Missing Solana action');
  return prepareBunkSolanaExecution(seed, scope(r), a, payer, action(s.action), {
    validAfter: decimal(s.validAfter),
    validUntil: decimal(s.validUntil),
  });
}
function slot(
  seed: Uint8Array,
  r: RecordValue,
  kind: Slot['kind'],
  baseline: string | null,
  payer: string,
  a: WireAction | null = null,
  validity?: { validAfter: bigint; validUntil: bigint },
): Slot {
  const s: Slot = {
    kind,
    baseline,
    action: a,
    validAfter: validity?.validAfter.toString() ?? null,
    validUntil: validity?.validUntil.toString() ?? null,
    payer,
    digest: '0x',
    phase: 'reserved',
    signature: null,
  };
  s.digest = prepare(seed, r, s).digest;
  return s;
}
function validateSlot(seed: Uint8Array, r: RecordValue, s: Slot, kind: Slot['kind']) {
  fields(s, 'kind baseline action validAfter validUntil payer digest phase signature');
  if (s.kind !== kind || !['reserved', 'signing', 'signed'].includes(s.phase))
    throw new Error('Invalid Solana approval phase');
  if (kind !== 'execute' && (s.action !== null || s.validAfter !== null || s.validUntil !== null))
    throw new Error('Unexpected Solana approval action');
  if (kind === 'initialize' && s.baseline !== null)
    throw new Error('Unexpected initialization baseline');
  const p = prepare(seed, r, s);
  if (p.digest !== s.digest) throw new Error('Solana journal digest mismatch');
  if (s.phase === 'signed')
    bunkSolanaPrecompile(p.signer.publicKey, p.digest, bytes(s.signature, 64));
  else if (s.signature !== null) throw new Error('Unexpected uncommitted signature');
}
function decode(value: string, seed: Uint8Array): RecordValue {
  if (typeof value !== 'string' || value.length > 64 * 1024)
    throw new Error('Oversized Solana journal');
  const raw: unknown = JSON.parse(value);
  fields(
    raw,
    'format version key release accountIndex identity wallet phase checkpoint account bootstrap recovery owner',
  );
  const r = raw as unknown as RecordValue;
  if (
    r.format !== 'honey-solana-account' ||
    r.version !== 1 ||
    !['restoring', 'ready'].includes(r.phase)
  )
    throw new Error('Unsupported Solana journal');
  fields(r.release, 'genesisHash program programData codeSha256 codeLength upgradeAuthority');
  const release = checkBunkSolanaRelease(r.release);
  if (json(release) !== json(r.release)) throw new Error('Noncanonical Solana release');
  const c = scope(r),
    identity = deriveBunkSolanaKey(seed, { ...c, role: 'deployment' }).publicKey;
  if (
    identity !== r.identity ||
    bunkSolanaWallet(c.program, identity, c.accountIndex).address !== r.wallet ||
    bunkSolanaAccountJournalKey(c, r.wallet) !== r.key
  )
    throw new Error('Foreign Solana journal');
  checkKey(r.key);
  fields(r.checkpoint, 'slot blockhash blockTime');
  for (const n of [r.checkpoint.slot, r.checkpoint.blockTime])
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid Solana checkpoint');
  bunkSolanaAddressBytes(r.checkpoint.blockhash);
  const state = r.account === null ? null : decodeBunkSolanaState(c, account(r, r.account));
  if (state && state.identity !== identity) throw new Error('Foreign wallet identity');
  if (r.phase === 'ready') {
    if (!state || r.bootstrap !== null || r.recovery !== null)
      throw new Error('Invalid ready Solana journal');
    if (
      state.owner !==
        deriveBunkSolanaKey(seed, {
          ...c,
          role: 'owner',
          epoch: state.epoch,
          ownerIndex: state.ownerIndex,
        }).commitment ||
      state.recovery !==
        deriveBunkSolanaKey(seed, { ...c, role: 'recovery', epoch: state.epoch }).commitment
    )
      throw new Error('Unknown ready Solana authority');
  } else if (!r.recovery || r.owner !== null) throw new Error('Invalid Solana restore plan');
  if (r.bootstrap) validateSlot(seed, r, r.bootstrap, 'initialize');
  if (r.recovery) validateSlot(seed, r, r.recovery, 'recover');
  if (r.owner) validateSlot(seed, r, r.owner, 'execute');
  if (json(r) !== value) throw new Error('Noncanonical Solana journal');
  return r;
}
async function read(store: BunkJournalStore, key: string, seed: Uint8Array) {
  checkKey(key);
  const row = await store.read(key);
  if (!row) throw new BunkSolanaRestoreRequired();
  const r = decode(row.value, seed);
  if (r.key !== key) throw new Error('Substituted Solana journal');
  return { r, revision: checkBunkJournalRevision(row.revision) };
}
async function save(store: BunkJournalStore, r: RecordValue, revision: number | null) {
  const value = json(r);
  if (value.length > 64 * 1024) throw new Error('Oversized Solana journal');
  if (!(await store.compareAndSwap(r.key, revision, value))) throw new BunkJournalConflict();
}
async function withSeed<T>(input: Uint8Array, run: (seed: Uint8Array) => Promise<T>): Promise<T> {
  if (!(input instanceof Uint8Array) || input.length !== 64)
    throw new Error('Expected BIP-39 seed');
  const seed = input.slice();
  try {
    return await run(seed);
  } finally {
    seed.fill(0);
  }
}
function nonregressing(r: RecordValue, o: BunkSolanaObservation) {
  if (!r.account) return;
  const before = decodeBunkSolanaState(scope(r), account(r, r.account)),
    next = o.state;
  if (
    !next ||
    next.nonce < before.nonce ||
    next.epoch < before.epoch ||
    (next.epoch === before.epoch && next.ownerIndex < before.ownerIndex)
  )
    throw new BunkSolanaRestoreRequired('Solana state disappeared or regressed');
}
const observe = async (r: RecordValue, access: BunkSolanaAccess) => {
  const o = await observeBunkSolanaAccount(
    r.release,
    r.identity,
    r.accountIndex,
    access,
    r.checkpoint,
  );
  nonregressing(r, o);
  return o;
};
const stateHex = (o: BunkSolanaObservation) => (o.account ? bytesToHex(o.account.data) : null);
function syntheticInitial(p: BunkSolanaPrepared, c: BunkSolanaScope): string {
  const data = p.instruction.data,
    identity = p.signer.publicKey;
  return bytesToHex(
    concatBytes(
      utf8ToBytes('HNYBUNK1'),
      data.slice(1, 69),
      new Uint8Array(16),
      data.slice(69),
      Uint8Array.of(bunkSolanaWallet(c.program, identity, c.accountIndex).bump),
    ),
  );
}
/** Explicit import/new-account recovery. Even an undeployed address bootstraps
 * then resets into a new generation before ordinary signing is permitted. */
export async function startBunkSolanaRestore(
  store: BunkJournalStore,
  inputSeed: Uint8Array,
  releaseInput: BunkSolanaRelease,
  accountIndex: number,
  payer: string,
  access: BunkSolanaAccess,
) {
  const release = checkBunkSolanaRelease(releaseInput);
  return withSeed(inputSeed, async (seed) => {
    const c = { genesisHash: release.genesisHash, program: release.program, accountIndex };
    const identity = deriveBunkSolanaKey(seed, { ...c, role: 'deployment' }).publicKey;
    const wallet = bunkSolanaWallet(c.program, identity, accountIndex).address,
      key = bunkSolanaAccountJournalKey(c, wallet);
    const old = await store.read(key),
      prior = old ? decode(old.value, seed) : null;
    if (prior && (prior.key !== key || json(prior.release) !== json(release)))
      throw new Error('Solana release migration required');
    const o = await observeBunkSolanaAccount(
      release,
      identity,
      accountIndex,
      access,
      prior?.checkpoint,
    );
    if (prior) nonregressing(prior, o);
    const r: RecordValue = {
      format: 'honey-solana-account',
      version: 1,
      key,
      release,
      accountIndex,
      identity,
      wallet,
      phase: 'restoring',
      checkpoint: o.checkpoint,
      account: stateHex(o),
      bootstrap: null,
      recovery: null,
      owner: null,
    };
    const init = prepareBunkSolanaInitialization(seed, c, payer);
    if (!o.account) {
      if (prior?.account) throw new BunkSolanaRestoreRequired('Deployed Solana wallet disappeared');
      r.bootstrap = slot(seed, r, 'initialize', null, payer);
      if (prior?.bootstrap?.digest === r.bootstrap.digest) r.bootstrap = prior.bootstrap;
    }
    r.recovery = slot(seed, r, 'recover', r.account ?? syntheticInitial(init, c), payer);
    if (prior?.recovery?.digest === r.recovery.digest) r.recovery = prior.recovery;
    await save(store, r, old ? checkBunkJournalRevision(old.revision) : null);
    return {
      key,
      wallet,
      bootstrapRequired: r.bootstrap !== null,
      recoveryDigest: r.recovery.digest,
    };
  });
}
export async function refreshBunkSolanaAccount(
  store: BunkJournalStore,
  key: string,
  inputSeed: Uint8Array,
  access: BunkSolanaAccess,
) {
  return withSeed(inputSeed, async (seed) => {
    const { r, revision } = await read(store, key, seed),
      o = await observe(r, access);
    const previous = r.account ? decodeBunkSolanaState(scope(r), account(r, r.account)) : null;
    if (previous && (!o.state || o.state.nonce < previous.nonce))
      throw new BunkSolanaRestoreRequired('Solana state disappeared or regressed');
    if (r.phase === 'restoring') {
      const s = r.recovery;
      if (!s?.baseline) throw new Error('Missing Solana recovery plan');
      const baseline = decodeBunkSolanaState(scope(r), account(r, s.baseline));
      if (o.state) {
        const p = prepare(seed, r, s),
          nextOwner = `0x${bytesToHex(p.instruction.data.slice(5, 37))}`,
          nextRecovery = `0x${bytesToHex(p.instruction.data.slice(37, 69))}`;
        if (
          o.state.epoch === baseline.epoch + 1 &&
          o.state.ownerIndex === 0 &&
          o.state.owner === nextOwner &&
          o.state.recovery === nextRecovery &&
          o.state.nonce >= baseline.nonce
        ) {
          r.phase = 'ready';
          r.recovery = null;
          r.bootstrap = null;
        } else if (
          o.state.epoch !== baseline.epoch ||
          o.state.recovery !== baseline.recovery ||
          o.state.ownerIndex < baseline.ownerIndex ||
          o.state.nonce < baseline.nonce
        )
          throw new BunkSolanaRestoreRequired('Unexpected Solana recovery outcome');
        else r.bootstrap = null;
      }
    } else if (stateHex(o) !== r.account) {
      if (!previous || !o.state || !r.owner) throw new BunkSolanaRestoreRequired();
      const p = prepare(seed, r, r.owner),
        next = `0x${bytesToHex(p.instruction.data.slice(33, 65))}`;
      if (
        o.state.epoch !== previous.epoch ||
        o.state.ownerIndex !== previous.ownerIndex + 1 ||
        o.state.nonce !== previous.nonce + 1n ||
        o.state.owner !== next ||
        o.state.recovery !== previous.recovery
      )
        throw new BunkSolanaRestoreRequired('Unexpected Solana owner transition');
      // This proves authority advancement, not the semantic outcome of an action.
      r.owner = null;
    }
    r.account = stateHex(o);
    r.checkpoint = o.checkpoint;
    await save(store, r, revision);
    return { phase: r.phase, wallet: r.wallet, checkpoint: r.checkpoint, state: o.state };
  });
}
export async function reserveBunkSolanaAction(
  store: BunkJournalStore,
  key: string,
  inputSeed: Uint8Array,
  payer: string,
  inputAction: BunkSolanaAction,
  window: { validAfter: bigint; validUntil: bigint },
  access: BunkSolanaAccess,
) {
  // Snapshot caller-owned buffers/objects before the first await.
  const a = wireAction(inputAction),
    validity = { ...window };
  if (typeof validity.validAfter !== 'bigint' || typeof validity.validUntil !== 'bigint')
    throw new Error('Expected bigint slot window');
  return withSeed(inputSeed, async (seed) => {
    const { r, revision } = await read(store, key, seed);
    if (r.phase !== 'ready' || !r.account) throw new BunkSolanaRestoreRequired();
    const o = await observe(r, access);
    if (stateHex(o) !== r.account)
      throw new BunkSolanaRestoreRequired('Refresh Solana authority before reserving');
    if (
      BigInt(o.checkpoint.slot) < validity.validAfter ||
      BigInt(o.checkpoint.slot) > validity.validUntil
    )
      throw new Error('Solana approval is outside its slot window');
    const next = slot(seed, r, 'execute', r.account, payer, a, validity);
    if (r.owner) {
      if (r.owner.digest !== next.digest)
        throw new BunkJournalConflict('Solana owner already reserved for another digest');
      return { key, digest: r.owner.digest, phase: r.owner.phase };
    }
    r.owner = next;
    r.checkpoint = o.checkpoint;
    await save(store, r, revision);
    return { key, digest: next.digest, phase: next.phase };
  });
}
function submission(
  seed: Uint8Array,
  r: RecordValue,
  s: Slot,
  o: BunkSolanaObservation,
  payer: string,
) {
  if (s.kind === 'initialize') {
    if (r.phase !== 'restoring' || o.account !== null)
      throw new BunkSolanaRestoreRequired('Refresh the Solana bootstrap first');
  } else if (!o.account || !o.state)
    throw new BunkSolanaRestoreRequired('Solana wallet is not deployed');
  if (s.kind === 'execute' && (r.phase !== 'ready' || stateHex(o) !== s.baseline))
    throw new BunkSolanaRestoreRequired('Solana owner approval is stale');
  if (s.kind === 'recover' && r.phase !== 'restoring') throw new BunkSolanaRestoreRequired();
  const p = prepare(seed, r, s, o.account ?? undefined, payer);
  if (p.digest !== s.digest)
    throw new BunkSolanaRestoreRequired('Solana approval changed; independent recovery required');
  if (
    s.kind === 'execute' &&
    (BigInt(o.checkpoint.slot) < decimal(s.validAfter) ||
      BigInt(o.checkpoint.slot) > decimal(s.validUntil))
  )
    throw new BunkSolanaRestoreRequired(
      'Solana approval expired; never sign a replacement with this owner',
    );
  return p;
}
/** Persist claim BEFORE computing a signature, then persist signature BEFORE
 * exposing it. `reconstruct` explicitly permits only the same deterministic digest. */
export async function signBunkSolanaApproval(
  store: BunkJournalStore,
  key: string,
  inputSeed: Uint8Array,
  kind: 'bootstrap' | 'recovery' | 'owner',
  payer: string,
  access: BunkSolanaAccess,
  reconstruct = false,
) {
  if (!['bootstrap', 'recovery', 'owner'].includes(kind))
    throw new Error('Invalid Solana approval kind');
  return withSeed(inputSeed, async (seed) => {
    const { r, revision } = await read(store, key, seed),
      s = r[kind];
    if (!s) throw new BunkSolanaRestoreRequired('No Solana approval reserved');
    const o = await observe(r, access),
      p = submission(seed, r, s, o, payer);
    let signature: Uint8Array;
    if (s.phase === 'signed') signature = bytes(s.signature, 64);
    else {
      if (s.phase === 'signing' && !reconstruct) throw new BunkSigningUncertain();
      if (reconstruct && s.phase !== 'signing')
        throw new Error('Only an uncertain Solana signature may be reconstructed');
      s.phase = 'signing';
      r.checkpoint = o.checkpoint;
      await save(store, r, revision);
      const privateKey = bunkSolanaPrivateKey(seed, p.key);
      try {
        signature = ed25519.sign(hexToBytes(p.digest.slice(2)), privateKey);
      } finally {
        privateKey.fill(0);
      }
      s.signature = bytesToHex(signature);
      s.phase = 'signed';
      await save(store, r, revision + 1);
    }
    const proof = bunkSolanaPrecompile(p.signer.publicKey, p.digest, signature);
    return { digest: p.digest, wallet: p.wallet, instructions: [proof, p.instruction] };
  });
}
