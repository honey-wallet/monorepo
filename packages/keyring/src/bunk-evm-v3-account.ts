import {
  type Address,
  encodeAbiParameters,
  type Hex,
  keccak256,
  parseAbiParameters,
  toHex,
  zeroHash,
} from 'viem';
import { bunkEvmAddress, bunkEvmHex, bunkEvmIndex, bunkEvmUint } from './bunk-evm';
import {
  type BunkEvmObservedBlock,
  type BunkEvmRpc,
  type BunkEvmV3Observation,
  observeBunkEvmV3Account,
} from './bunk-evm-observe';
import type { BunkEvmSponsorState } from './bunk-evm-sign';
import {
  BUNK_JOURNAL_MAX_BYTES,
  BunkJournalConflict,
  type BunkJournalStore,
  BunkSigningUncertain,
  checkBunkJournalRevision,
} from './bunk-evm-v2-journal';
import {
  type BunkEvmV3Config,
  bunkEvmV3Config,
  bunkEvmV3DeploymentDigest,
  bunkEvmV3KeyScope,
  bunkEvmV3SeedRecoveryDigest,
  encodeBunkEvmV3Deployment,
  encodeBunkEvmV3SeedRecovery,
  predictBunkEvmV3Account,
} from './bunk-evm-v3';
import {
  bunkV3JournalKey,
  decodeBunkV3Journal,
  readSignedBunkV3Envelope,
  reconstructBunkV3Envelope,
  reconstructBunkV3Intent,
  reserveBunkV3Envelope,
  reserveBunkV3Intent,
  signReservedBunkV3Envelope,
  signReservedBunkV3Intent,
} from './bunk-evm-v3-journal';
import {
  type BunkEvmV3SigningState,
  deriveBunkEvmV3DeploymentIdentity,
  prepareBunkEvmV3SeedRecovery,
  recoverBunkEvmV3Signer,
  signBunkEvmV3Deployment,
  signBunkEvmV3SeedRecovery,
} from './bunk-evm-v3-sign';

export interface BunkV3Access {
  rpc: BunkEvmRpc;
  now: () => number;
  maxFinalizedAgeSeconds: number;
}
export interface BunkV3AccountRecord {
  format: 'honey-bunk-account';
  version: 1;
  key: string;
  config: BunkEvmV3Config;
  proxyRuntimeCodeHash: Hex;
  identity: Address;
  accountIndex: number;
  account: Address;
  phase: 'restoring' | 'ready';
  block: BunkEvmObservedBlock;
  state: BunkEvmV3SigningState | null;
  bootstrap: { owner: Hex; recovery: Hex; signature: Hex } | null;
  restore: {
    epoch: number;
    commitment: Hex;
    nextOwner: Hex;
    nextRecovery: Hex;
    digest: Hex;
    phase: 'reserved' | 'signing' | 'signed';
    signature: Hex | null;
  } | null;
  /** Canonical per-owner journal nested under the SAME atomic account revision. */
  journal: string | null;
}
export class BunkV3RestoreRequired extends Error {
  constructor(
    detail = 'Bunk history is unavailable or changed; confirm fresh-generation recovery first',
  ) {
    super(detail);
    this.name = 'BunkV3RestoreRequired';
  }
}
const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
function object(v: unknown, fields: string): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(' ') !== fields.split(' ').sort().join(' ')
  )
    throw new Error('Unexpected Bunk account fields');
  return v as Record<string, unknown>;
}
function uint(v: unknown, bits: number, wire: boolean) {
  if (wire && (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(v)))
    throw new Error('Invalid Bunk account integer');
  return bunkEvmUint(wire ? BigInt(v as string) : (v as bigint), bits);
}
function stateValue(v: unknown, wire: boolean): BunkEvmV3SigningState {
  const s = object(
    v,
    'protocolVersion deployed account accountIndex ownerIndex commitment nonce epoch recoveryCommitment',
  );
  if (s.protocolVersion !== 3 || s.deployed !== true)
    throw new Error('Expected deployed Bunk v3 state');
  const state = {
    protocolVersion: 3 as const,
    deployed: true,
    account: bunkEvmAddress(s.account as Address),
    accountIndex: bunkEvmIndex(s.accountIndex as number),
    ownerIndex: bunkEvmIndex(s.ownerIndex as number),
    commitment: bunkEvmHex(s.commitment as Hex, 32),
    nonce: uint(s.nonce, 64, wire),
    epoch: bunkEvmIndex(s.epoch as number),
    recoveryCommitment: bunkEvmHex(s.recoveryCommitment as Hex, 32),
  };
  if (
    state.commitment === zeroHash ||
    state.recoveryCommitment === zeroHash ||
    state.commitment === state.recoveryCommitment
  )
    throw new Error('Invalid Bunk account commitments');
  return state;
}
export function bunkV3AccountKey(config: BunkEvmV3Config, account: Address): string {
  const c = bunkEvmV3Config(config);
  return `bunk-v3-account:${keccak256(encodeAbiParameters(parseAbiParameters('string,uint256,bytes32,address'), ['HoneyBunkV3AccountJournal', BigInt(c.chainId), bunkEvmV3KeyScope(c), bunkEvmAddress(account)])).slice(2)}`;
}
function checkKey(key: string): string {
  if (
    typeof key !== 'string' ||
    !/^bunk-v3-account:[0-9a-f]{64}$/.test(key) ||
    key === `bunk-v3-account:${'0'.repeat(64)}`
  )
    throw new Error('Invalid Bunk account key');
  return key;
}
function payload(r: BunkV3AccountRecord) {
  if (!r.restore) throw new BunkV3RestoreRequired('Bunk recovery was not reserved');
  return {
    protocolVersion: 3 as const,
    account: r.account,
    epoch: r.restore.epoch,
    nextOwnerCommitment: r.restore.nextOwner,
    nextRecoveryCommitment: r.restore.nextRecovery,
  };
}
function normalize(value: unknown, wire: boolean): BunkV3AccountRecord {
  const r = object(
    value,
    'format version key config proxyRuntimeCodeHash identity accountIndex account phase block state bootstrap restore journal',
  );
  if (
    r.format !== 'honey-bunk-account' ||
    r.version !== 1 ||
    (r.phase !== 'restoring' && r.phase !== 'ready')
  )
    throw new Error('Unsupported Bunk account record');
  const c = object(
    r.config,
    'protocolVersion chainId factory singleton proxyFactory entryPoint module helper proxyCreationCode',
  );
  for (const name of ['factory', 'singleton', 'proxyFactory', 'entryPoint', 'module', 'helper'])
    object(c[name], 'address codeHash');
  const config = bunkEvmV3Config(c as unknown as BunkEvmV3Config);
  const identity = bunkEvmAddress(r.identity as Address),
    accountIndex = bunkEvmIndex(r.accountIndex as number),
    account = predictBunkEvmV3Account(config, identity, accountIndex);
  const key = bunkV3AccountKey(config, account),
    proxyRuntimeCodeHash = bunkEvmHex(r.proxyRuntimeCodeHash as Hex, 32);
  if (
    r.key !== key ||
    bunkEvmAddress(r.account as Address) !== account ||
    proxyRuntimeCodeHash === zeroHash ||
    proxyRuntimeCodeHash === keccak256('0x')
  )
    throw new Error('Bunk account identity mismatch');
  const b = object(r.block, 'hash number timestamp');
  const block = {
    hash: bunkEvmHex(b.hash as Hex, 32),
    number: uint(b.number, 256, wire),
    timestamp: uint(b.timestamp, 48, wire),
  };
  if (block.hash === zeroHash) throw new Error('Missing Bunk account anchor');
  const state = r.state === null ? null : stateValue(r.state, wire);
  if (state && (state.account !== account || state.accountIndex !== accountIndex))
    throw new Error('Foreign Bunk account state');
  let bootstrap: BunkV3AccountRecord['bootstrap'] = null;
  if (r.bootstrap !== null) {
    const v = object(r.bootstrap, 'owner recovery signature');
    bootstrap = {
      owner: bunkEvmHex(v.owner as Hex, 32),
      recovery: bunkEvmHex(v.recovery as Hex, 32),
      signature: bunkEvmHex(v.signature as Hex, 65),
    };
    const digest = bunkEvmV3DeploymentDigest(
      config,
      identity,
      accountIndex,
      bootstrap.owner,
      bootstrap.recovery,
    );
    if (recoverBunkEvmV3Signer(digest, bootstrap.signature) !== identity)
      throw new Error('Invalid Bunk bootstrap signature');
  }
  let restore: BunkV3AccountRecord['restore'] = null;
  if (r.restore !== null) {
    const v = object(r.restore, 'epoch commitment nextOwner nextRecovery digest phase signature');
    if (!['reserved', 'signing', 'signed'].includes(v.phase as string))
      throw new Error('Invalid Bunk recovery phase');
    restore = {
      epoch: bunkEvmIndex(v.epoch as number),
      commitment: bunkEvmHex(v.commitment as Hex, 32),
      nextOwner: bunkEvmHex(v.nextOwner as Hex, 32),
      nextRecovery: bunkEvmHex(v.nextRecovery as Hex, 32),
      digest: bunkEvmHex(v.digest as Hex, 32),
      phase: v.phase as 'reserved' | 'signing' | 'signed',
      signature: v.phase === 'signed' ? bunkEvmHex(v.signature as Hex, 65) : null,
    };
    if (restore.phase !== 'signed' && v.signature !== null)
      throw new Error('Unsigned Bunk recovery has signature');
    if (
      restore.commitment === zeroHash ||
      restore.commitment === restore.nextOwner ||
      restore.commitment === restore.nextRecovery
    )
      throw new Error('Invalid Bunk recovery commitments');
    const digest = bunkEvmV3SeedRecoveryDigest(config, {
      protocolVersion: 3,
      account,
      epoch: restore.epoch,
      nextOwnerCommitment: restore.nextOwner,
      nextRecoveryCommitment: restore.nextRecovery,
    });
    if (
      restore.digest !== digest ||
      (restore.signature &&
        keccak256(recoverBunkEvmV3Signer(digest, restore.signature)) !== restore.commitment)
    )
      throw new Error('Invalid Bunk recovery signature/digest');
    if (
      state
        ? state.epoch !== restore.epoch || state.recoveryCommitment !== restore.commitment
        : !bootstrap || restore.epoch !== 0 || restore.commitment !== bootstrap.recovery
    )
      throw new Error('Bunk recovery checkpoint mismatch');
  }
  if (r.phase === 'ready' ? !state || restore !== null : restore === null || r.journal !== null)
    throw new Error('Invalid Bunk account phase');
  if (!state && !bootstrap) throw new Error('Missing Bunk bootstrap');
  const journal = r.journal === null ? null : r.journal;
  if (journal !== null) {
    if (typeof journal !== 'string') throw new Error('Invalid Bunk account journal');
    const j = decodeBunkV3Journal(journal);
    if (json(j.config) !== json(config) || json(j.state) !== json(state))
      throw new Error('Bunk account/journal mismatch');
  }
  return {
    format: 'honey-bunk-account',
    version: 1,
    key,
    config,
    proxyRuntimeCodeHash,
    identity,
    accountIndex,
    account,
    phase: r.phase,
    block,
    state,
    bootstrap,
    restore,
    journal,
  };
}
export function encodeBunkV3Account(r: BunkV3AccountRecord): string {
  const encoded = json(normalize(r, false));
  if (encoded.length > BUNK_JOURNAL_MAX_BYTES) throw new Error('Bunk account exceeds size limit');
  return encoded;
}
export function decodeBunkV3Account(encoded: string): BunkV3AccountRecord {
  if (typeof encoded !== 'string' || encoded.length > BUNK_JOURNAL_MAX_BYTES)
    throw new Error('Bunk account exceeds size limit');
  const record = normalize(JSON.parse(encoded), true);
  if (json(record) !== encoded) throw new Error('Noncanonical Bunk account encoding');
  return record;
}
async function read(store: BunkJournalStore, key: string) {
  const row = await store.read(checkKey(key));
  if (!row) throw new BunkV3RestoreRequired();
  const record = decodeBunkV3Account(row.value);
  if (record.key !== key) throw new Error('Foreign Bunk account record');
  return { record, revision: checkBunkJournalRevision(row.revision) };
}
async function save(store: BunkJournalStore, record: BunkV3AccountRecord, revision: number | null) {
  if (!(await store.compareAndSwap(record.key, revision, encodeBunkV3Account(record))))
    throw new BunkJournalConflict();
}
async function observe(
  r: Pick<BunkV3AccountRecord, 'config' | 'identity' | 'accountIndex' | 'proxyRuntimeCodeHash'>,
  access: BunkV3Access,
) {
  return observeBunkEvmV3Account(access.rpc, {
    config: r.config,
    deploymentIdentity: r.identity,
    accountIndex: r.accountIndex,
    proxyRuntimeCodeHash: r.proxyRuntimeCodeHash,
    now: access.now,
    maxFinalizedAgeSeconds: access.maxFinalizedAgeSeconds,
  });
}
async function anchor(
  r: BunkV3AccountRecord,
  observation: BunkEvmV3Observation,
  access: BunkV3Access,
) {
  if (observation.block.number < r.block.number || observation.block.timestamp < r.block.timestamp)
    throw new BunkV3RestoreRequired('Bunk finalized observation went backwards');
  const previous = await access.rpc({
    method: 'eth_getBlockByNumber',
    params: [toHex(r.block.number), false],
  });
  if (
    !previous ||
    typeof previous !== 'object' ||
    !('hash' in previous) ||
    previous.hash !== r.block.hash
  )
    throw new BunkV3RestoreRequired('Bunk previous finalized anchor changed');
}
/** Explicit restore, including backup import even if old journal rows survive.
 * Missing history never opens ordinary signing. Undeployed accounts must first
 * deploy their fixed bootstrap, then recover; their initial owner may already be used.
 * Caller supplies a trusted release configuration/RPC and confirms this reset. */
export async function startBunkV3Restore(
  store: BunkJournalStore,
  seed: Uint8Array,
  input: { config: BunkEvmV3Config; accountIndex: number; proxyRuntimeCodeHash: Hex },
  access: BunkV3Access,
) {
  const config = bunkEvmV3Config(input.config),
    accountIndex = bunkEvmIndex(input.accountIndex),
    identity = deriveBunkEvmV3DeploymentIdentity(seed, accountIndex).address;
  const request = {
    config,
    accountIndex,
    identity,
    proxyRuntimeCodeHash: bunkEvmHex(input.proxyRuntimeCodeHash, 32),
  };
  const observation = await observe(request, access),
    account = observation.account,
    key = bunkV3AccountKey(config, account);
  const old = await store.read(key);
  if (old) {
    const prior = decodeBunkV3Account(old.value);
    if (prior.key !== key) throw new Error('Foreign Bunk account record');
    await anchor(prior, observation, access);
  }
  const deployed = observation.status === 'deployed';
  const deployment = deployed ? null : signBunkEvmV3Deployment(seed, config, accountIndex);
  const state = deployed ? stateValue(observation.state, false) : null;
  const recoveryCommitment = state?.recoveryCommitment ?? deployment?.firstRecovery.commitment;
  if (!recoveryCommitment) throw new Error('Missing Bunk recovery state');
  const prepared = prepareBunkEvmV3SeedRecovery(seed, config, {
    protocolVersion: 3,
    account,
    accountIndex,
    epoch: state?.epoch ?? 0,
    recoveryCommitment,
  });
  const r: BunkV3AccountRecord = {
    format: 'honey-bunk-account',
    version: 1,
    key,
    ...request,
    account,
    phase: 'restoring',
    block: observation.block,
    state,
    bootstrap: deployment
      ? {
          owner: deployment.firstOwner.commitment,
          recovery: deployment.firstRecovery.commitment,
          signature: deployment.signature,
        }
      : null,
    restore: {
      epoch: prepared.recovery.epoch,
      commitment: prepared.currentRecovery.commitment,
      nextOwner: prepared.nextOwner.commitment,
      nextRecovery: prepared.nextRecovery.commitment,
      digest: prepared.digest,
      phase: 'reserved',
      signature: null,
    },
    journal: null,
  };
  // A repeated request cannot clear a claimed/signed recovery slot in this epoch.
  if (old) {
    const prior = decodeBunkV3Account(old.value);
    if (prior.restore?.digest === prepared.digest) r.restore = prior.restore;
  }
  await save(store, r, old?.revision ?? null);
  return { key, digest: prepared.digest, bootstrapRequired: !state };
}
export async function readBunkV3Bootstrap(store: BunkJournalStore, key: string) {
  const { record: r } = await read(store, key);
  if (r.phase !== 'restoring' || r.state || !r.bootstrap)
    throw new BunkV3RestoreRequired('Bunk bootstrap is not pending');
  return {
    to: r.config.factory.address,
    value: 0n,
    data: encodeBunkEvmV3Deployment(
      r.identity,
      r.accountIndex,
      r.bootstrap.owner,
      r.bootstrap.recovery,
      r.bootstrap.signature,
    ),
  };
}
/** Reconcile only verified finalized state. A relay acknowledgement is insufficient. */
export async function refreshBunkV3Account(
  store: BunkJournalStore,
  key: string,
  access: BunkV3Access,
) {
  const { record: r, revision } = await read(store, key),
    o = await observe(r, access);
  await anchor(r, o, access);
  const state = o.status === 'deployed' ? stateValue(o.state, false) : null;
  if (r.phase === 'restoring') {
    const plan = r.restore;
    if (!plan) throw new Error('Missing Bunk recovery plan');
    if (
      state &&
      state.epoch === plan.epoch + 1 &&
      state.ownerIndex === 0 &&
      state.commitment === plan.nextOwner &&
      state.recoveryCommitment === plan.nextRecovery &&
      state.nonce >= (r.state?.nonce ?? 0n)
    ) {
      // Even if signature persistence was lost, exact finalized successors prove reset.
      r.phase = 'ready';
      r.restore = null;
      r.bootstrap = null;
    } else if (state) {
      if (
        state.epoch !== plan.epoch ||
        state.recoveryCommitment !== plan.commitment ||
        state.nonce < (r.state?.nonce ?? 0n)
      )
        throw new BunkV3RestoreRequired(
          'Unexpected Bunk recovery outcome; start another verified recovery',
        );
    } else if (r.state) throw new BunkV3RestoreRequired('Deployed Bunk account disappeared');
  } else {
    const previous = r.state;
    if (!previous) throw new Error('Missing Bunk account state');
    if (!state) throw new BunkV3RestoreRequired('Deployed Bunk account disappeared');
    if (json(state) !== json(previous)) {
      const j = r.journal ? decodeBunkV3Journal(r.journal) : null;
      if (
        j?.owner.phase !== 'signed' ||
        state.epoch !== previous.epoch ||
        state.recoveryCommitment !== previous.recoveryCommitment ||
        state.ownerIndex !== previous.ownerIndex + 1 ||
        state.nonce !== previous.nonce + 1n ||
        state.commitment !== j.certificate.nextCommitment
      )
        throw new BunkV3RestoreRequired('Bunk state advanced outside recorded approval');
      r.journal = null;
    }
  }
  r.state = state;
  r.block = o.block;
  await save(store, r, revision);
  return { key: r.key, phase: r.phase, state: r.state, block: r.block };
}
function recoveryState(r: BunkV3AccountRecord) {
  if (r.phase !== 'restoring' || !r.restore || !r.state)
    throw new BunkV3RestoreRequired('Finalize Bunk bootstrap before signing recovery');
  return {
    protocolVersion: 3 as const,
    account: r.account,
    accountIndex: r.accountIndex,
    epoch: r.restore.epoch,
    recoveryCommitment: r.restore.commitment,
  };
}
function recoveryTransaction(r: BunkV3AccountRecord) {
  if (r.restore?.phase !== 'signed' || !r.restore.signature) throw new BunkSigningUncertain();
  return {
    digest: r.restore.digest,
    transaction: {
      to: r.config.module.address,
      value: 0n,
      data: encodeBunkEvmV3SeedRecovery(payload(r), r.restore.signature),
    },
  };
}
async function signRecovery(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  access: BunkV3Access,
  expectedDigest: Hex,
  reconstruct: boolean,
) {
  await refreshBunkV3Account(store, key, access);
  const { record: r, revision } = await read(store, key),
    state = recoveryState(r),
    plan = r.restore;
  if (!plan) throw new Error('Missing Bunk recovery plan');
  const prepared = prepareBunkEvmV3SeedRecovery(seed, r.config, state);
  if (prepared.digest !== plan.digest) throw new Error('Bunk recovery seed/approval mismatch');
  if (bunkEvmHex(expectedDigest, 32) !== plan.digest)
    throw new Error('Bunk recovery approval digest mismatch');
  if (plan.phase === 'signed') return recoveryTransaction(r);
  if (reconstruct ? plan.phase !== 'signing' : plan.phase !== 'reserved')
    throw new BunkSigningUncertain();
  plan.phase = 'signing';
  await save(store, r, revision);
  const signed = signBunkEvmV3SeedRecovery(seed, r.config, state);
  plan.signature = signed.signature;
  plan.phase = 'signed';
  await save(store, r, revision + 1);
  return recoveryTransaction(r);
}
export const signBunkV3Restore = (
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  digest: Hex,
  access: BunkV3Access,
) => signRecovery(store, seed, key, access, digest, false);
export const reconstructBunkV3Restore = (
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  digest: Hex,
  access: BunkV3Access,
) => signRecovery(store, seed, key, access, digest, true);
/** Private adapter keeps owner claims/signatures and restore fences on one CAS key.
 * Recovery may invalidate a claimed signer, which then cannot persist/expose bytes. */
function journalStore(store: BunkJournalStore, accountKey: string): BunkJournalStore {
  async function current(key: string) {
    const row = await read(store, accountKey),
      r = row.record;
    if (r.phase !== 'ready' || !r.state) throw new BunkV3RestoreRequired();
    if (key !== bunkV3JournalKey(r.state.commitment))
      throw new BunkV3RestoreRequired('Bunk signing key is no longer current');
    return row;
  }
  return {
    async read(key) {
      const { record: r, revision } = await current(key);
      return r.journal === null ? null : { revision, value: r.journal };
    },
    async compareAndSwap(key, expectedRevision, value) {
      const { record: r, revision } = await current(key);
      if (
        expectedRevision === null
          ? r.journal !== null
          : r.journal === null || expectedRevision !== revision
      )
        return false;
      const j = decodeBunkV3Journal(value);
      if (j.key !== key || json(j.config) !== json(r.config) || json(j.state) !== json(r.state))
        throw new BunkJournalConflict('Bunk approval is outside account checkpoint');
      r.journal = value;
      return store.compareAndSwap(accountKey, revision, encodeBunkV3Account(r));
    },
  };
}
async function ready(
  store: BunkJournalStore,
  key: string,
  access: BunkV3Access,
  expectedOwner?: string,
) {
  await refreshBunkV3Account(store, key, access);
  const { record: r } = await read(store, key);
  if (r.phase !== 'ready' || !r.state) throw new BunkV3RestoreRequired();
  const ownerKey = bunkV3JournalKey(r.state.commitment);
  if (expectedOwner !== undefined && expectedOwner !== ownerKey)
    throw new BunkV3RestoreRequired('Reviewed Bunk approval is no longer current');
  return { ...r, state: r.state, ownerKey };
}
export async function reserveBunkV3Approval(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  request: Omit<Parameters<typeof reserveBunkV3Intent>[2], 'config' | 'state'>,
  access: BunkV3Access,
) {
  request = { ...request };
  const r = await ready(store, key, access);
  return reserveBunkV3Intent(
    journalStore(store, key),
    seed,
    { ...request, config: r.config, state: r.state },
    r.block,
  );
}
export async function signBunkV3Approval(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  ownerKey: string,
  access: BunkV3Access,
) {
  const r = await ready(store, key, access, ownerKey);
  return signReservedBunkV3Intent(journalStore(store, key), seed, r.ownerKey);
}
export async function reconstructBunkV3Approval(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  ownerKey: string,
  digest: Hex,
  access: BunkV3Access,
) {
  const r = await ready(store, key, access, ownerKey);
  return reconstructBunkV3Intent(journalStore(store, key), seed, r.ownerKey, digest);
}
export async function reserveBunkV3Attempt(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  ownerKey: string,
  request: Omit<Parameters<typeof reserveBunkV3Envelope>[3], 'deployed' | 'now'>,
  access: BunkV3Access,
) {
  request = {
    ...request,
    operation: { ...request.operation },
    sponsor: copySponsor(request.sponsor),
  };
  const r = await ready(store, key, access, ownerKey);
  return reserveBunkV3Envelope(journalStore(store, key), seed, r.ownerKey, {
    ...request,
    deployed: true,
    now: access.now(),
  });
}
export async function signBunkV3Attempt(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  ownerKey: string,
  attempt: number,
  access: BunkV3Access,
  sponsor?: BunkEvmSponsorState,
) {
  sponsor = copySponsor(sponsor);
  const r = await ready(store, key, access, ownerKey);
  return signReservedBunkV3Envelope(
    journalStore(store, key),
    seed,
    r.ownerKey,
    attempt,
    access.now(),
    sponsor,
  );
}
export async function reconstructBunkV3Attempt(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  ownerKey: string,
  attempt: number,
  hash: Hex,
  access: BunkV3Access,
  sponsor?: BunkEvmSponsorState,
) {
  sponsor = copySponsor(sponsor);
  const r = await ready(store, key, access, ownerKey);
  return reconstructBunkV3Envelope(
    journalStore(store, key),
    seed,
    r.ownerKey,
    attempt,
    hash,
    access.now(),
    sponsor,
  );
}
export async function readBunkV3Attempt(
  store: BunkJournalStore,
  key: string,
  ownerKey: string,
  attempt: number,
) {
  return readSignedBunkV3Envelope(journalStore(store, key), ownerKey, attempt);
}
function copySponsor(sponsor?: BunkEvmSponsorState) {
  return sponsor ? { ...sponsor, paymaster: { ...sponsor.paymaster } } : undefined;
}
