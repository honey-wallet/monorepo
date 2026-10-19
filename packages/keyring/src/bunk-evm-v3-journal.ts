/** Internal per-owner journal primitives. Application entry points must use the v3
 * account coordinator, which fences missing history and stale generations atomically.
 * Direct use of these primitives does not establish an unused owner key. */
import { type Address, type Hex, keccak256, slice, zeroHash } from 'viem';
import {
  type BunkEvmOperation,
  bunkEvmAddress,
  bunkEvmHex,
  bunkEvmIndex,
  bunkEvmUint,
  bunkEvmUserOpHash,
} from './bunk-evm';
import type { BunkEvmObservedBlock } from './bunk-evm-observe';
import type { BunkEvmSponsorState } from './bunk-evm-sign';
import {
  BUNK_JOURNAL_MAX_BYTES,
  BunkJournalConflict,
  type BunkJournalStore,
  BunkSigningUncertain,
  checkBunkJournalRevision,
} from './bunk-evm-v2-journal';
import {
  type BunkEvmV3Certificate,
  type BunkEvmV3Config,
  type BunkEvmV3Intent,
  bunkEvmV3Attempt,
  bunkEvmV3Certificate,
  bunkEvmV3Config,
  bunkEvmV3IntentDigest,
  bunkEvmV3RecoveryCalls,
  bunkEvmV3RecoveryFee,
  bunkEvmV3Tree,
  decodeBunkEvmV3Calls,
  encodeBunkEvmV3Authorization,
  packBunkEvmV3Operation,
} from './bunk-evm-v3';
import {
  type BunkEvmV3SigningState,
  prepareBunkEvmV3Envelope,
  prepareBunkEvmV3Intent,
  recoverBunkEvmV3Signer,
  signBunkEvmV3Envelope,
  signBunkEvmV3Intent,
} from './bunk-evm-v3-sign';

type SignatureSlot = { phase: 'reserved' | 'signing' | 'signed'; signature: Hex | null };
export interface BunkV3JournalEnvelope extends SignatureSlot {
  attempt: number;
  deployed: boolean;
  purpose: 'action' | 'cleanup';
  operation: BunkEvmOperation;
  userOpHash: Hex;
}
export interface BunkV3Journal {
  format: 'honey-bunk-journal';
  version: 2;
  key: string;
  config: BunkEvmV3Config;
  state: BunkEvmV3SigningState;
  observation: BunkEvmObservedBlock;
  callData: Hex;
  certificate: BunkEvmV3Certificate;
  envelopeSigners: Address[];
  owner: SignatureSlot;
  envelopes: BunkV3JournalEnvelope[];
}
/** Same key for the same derived owner, even under another wallet label/configuration. */
export function bunkV3JournalKey(commitment: Hex): string {
  const hash = bunkEvmHex(commitment, 32);
  if (hash === zeroHash) throw new Error('Empty Bunk owner commitment');
  return `bunk-v3:${hash.slice(2)}`;
}
export function checkBunkV3JournalKey(key: string): string {
  if (
    typeof key !== 'string' ||
    !/^bunk-v3:[0-9a-f]{64}$/.test(key) ||
    key === `bunk-v3:${'0'.repeat(64)}`
  )
    throw new Error('Invalid Bunk journal key');
  return key;
}
function object(value: unknown, fields: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Bunk journal object');
  const keys = fields.split(' ').sort();
  if (Object.keys(value).sort().join(' ') !== keys.join(' '))
    throw new Error('Unexpected Bunk journal fields');
  return value as Record<string, unknown>;
}
function integer(value: unknown, bits: number, wire: boolean): bigint {
  if (wire) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value))
      throw new Error('Invalid Bunk journal integer');
    return bunkEvmUint(BigInt(value), bits);
  }
  return bunkEvmUint(value as bigint, bits);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid Bunk journal boolean');
  return value;
}
function slot(value: unknown): SignatureSlot {
  const s = object(value, 'phase signature');
  if (!['reserved', 'signing', 'signed'].includes(s.phase as string))
    throw new Error('Invalid Bunk signing phase');
  if (s.phase === 'signed')
    return { phase: 'signed', signature: bunkEvmHex(s.signature as Hex, 65) };
  if (s.signature !== null) throw new Error('Unsigned Bunk slot contains a signature');
  return { phase: s.phase as 'reserved' | 'signing', signature: null };
}
function operation(value: unknown, wire: boolean): BunkEvmOperation {
  const o = object(
    value,
    'sender nonce initCode callData verificationGasLimit callGasLimit preVerificationGas maxPriorityFeePerGas maxFeePerGas paymasterAndData',
  );
  const result = {
    sender: bunkEvmAddress(o.sender as Address),
    nonce: integer(o.nonce, 64, wire),
    initCode: bunkEvmHex(o.initCode as Hex),
    callData: bunkEvmHex(o.callData as Hex),
    verificationGasLimit: integer(o.verificationGasLimit, 120, wire),
    callGasLimit: integer(o.callGasLimit, 120, wire),
    preVerificationGas: integer(o.preVerificationGas, 120, wire),
    maxPriorityFeePerGas: integer(o.maxPriorityFeePerGas, 120, wire),
    maxFeePerGas: integer(o.maxFeePerGas, 120, wire),
    paymasterAndData: bunkEvmHex(o.paymasterAndData as Hex),
  };
  packBunkEvmV3Operation(result);
  return result;
}
function normalize(value: unknown, wire: boolean): BunkV3Journal {
  const r = object(
    value,
    'format version key config state observation callData certificate envelopeSigners owner envelopes',
  );
  if (r.format !== 'honey-bunk-journal' || r.version !== 2)
    throw new Error('Unsupported Bunk journal');
  const configValue = object(
    r.config,
    'protocolVersion chainId factory singleton proxyFactory entryPoint module helper proxyCreationCode',
  );
  for (const name of ['factory', 'singleton', 'proxyFactory', 'entryPoint', 'module', 'helper'])
    object(configValue[name], 'address codeHash');
  const config = bunkEvmV3Config(configValue as unknown as BunkEvmV3Config);
  const s = object(
    r.state,
    'protocolVersion deployed account accountIndex ownerIndex commitment nonce epoch recoveryCommitment',
  );
  if (s.protocolVersion !== 3) throw new Error('Expected Bunk v3 state');
  const state: BunkEvmV3SigningState = {
    protocolVersion: 3,
    deployed: boolean(s.deployed),
    account: bunkEvmAddress(s.account as Address),
    accountIndex: bunkEvmIndex(s.accountIndex as number),
    ownerIndex: bunkEvmIndex(s.ownerIndex as number),
    commitment: bunkEvmHex(s.commitment as Hex, 32),
    nonce: integer(s.nonce, 64, wire),
    epoch: bunkEvmIndex(s.epoch as number),
    recoveryCommitment: bunkEvmHex(s.recoveryCommitment as Hex, 32),
  };
  if (!state.deployed && (state.ownerIndex !== 0 || state.nonce !== 0n || state.epoch !== 0))
    throw new Error('Undeployed Bunk journal has state');
  if (state.recoveryCommitment === zeroHash || state.recoveryCommitment === state.commitment)
    throw new Error('Invalid Bunk recovery commitment');
  const key = bunkV3JournalKey(state.commitment);
  if (r.key !== key) throw new Error('Bunk journal key mismatch');
  const b = object(r.observation, 'hash number timestamp');
  const observation = {
    hash: bunkEvmHex(b.hash as Hex, 32),
    number: integer(b.number, 256, wire),
    timestamp: integer(b.timestamp, 48, wire),
  };
  if (observation.hash === zeroHash) throw new Error('Missing Bunk observation hash');
  const c = object(
    r.certificate,
    'entryPoint account nonce callDataHash accountGasLimits preVerificationGas maxGasCost paymaster ownerIndex nextCommitment envelopeRoot validAfter executeUntil',
  );
  const certificate = bunkEvmV3Certificate({
    entryPoint: c.entryPoint as Address,
    account: c.account as Address,
    nonce: integer(c.nonce, 64, wire),
    callDataHash: c.callDataHash as Hex,
    accountGasLimits: c.accountGasLimits as Hex,
    preVerificationGas: integer(c.preVerificationGas, 120, wire),
    maxGasCost: integer(c.maxGasCost, 128, wire),
    paymaster: c.paymaster as Address,
    ownerIndex: c.ownerIndex as number,
    nextCommitment: c.nextCommitment as Hex,
    envelopeRoot: c.envelopeRoot as Hex,
    validAfter: c.validAfter as number,
    executeUntil: c.executeUntil as number,
  });
  const callData = bunkEvmHex(r.callData as Hex);
  decodeBunkEvmV3Calls(config, state.account, callData);
  if (
    certificate.entryPoint !== config.entryPoint.address ||
    certificate.account !== state.account ||
    certificate.nonce !== state.nonce ||
    certificate.ownerIndex !== state.ownerIndex ||
    certificate.nextCommitment === state.commitment ||
    certificate.callDataHash !== keccak256(callData)
  )
    throw new Error('Bunk journal intent/state mismatch');
  bunkEvmV3RecoveryFee(certificate);
  if (!Array.isArray(r.envelopeSigners) || r.envelopeSigners.length !== 256)
    throw new Error('Missing Bunk envelope tree');
  const envelopeSigners = r.envelopeSigners.map((a) => bunkEvmAddress(a as Address));
  const tree = bunkEvmV3Tree(envelopeSigners);
  if (tree.root !== certificate.envelopeRoot)
    throw new Error('Bunk journal envelope root mismatch');
  const owner = slot(r.owner);
  if (
    owner.signature !== null &&
    keccak256(
      recoverBunkEvmV3Signer(bunkEvmV3IntentDigest(config, certificate), owner.signature),
    ) !== state.commitment
  )
    throw new Error('Bunk journal owner signature mismatch');
  if (
    !Array.isArray(r.envelopes) ||
    r.envelopes.length > 256 ||
    (owner.phase !== 'signed' && r.envelopes.length !== 0)
  )
    throw new Error('Invalid Bunk journal envelopes');
  const used = new Set<number>();
  const envelopes = r.envelopes.map((value) => {
    const e = object(value, 'phase signature attempt deployed purpose operation userOpHash');
    const auth = slot({ phase: e.phase, signature: e.signature }),
      attempt = bunkEvmV3Attempt(e.attempt as number);
    if (used.has(attempt)) throw new Error('Duplicate Bunk leaf reservation');
    used.add(attempt);
    if (e.purpose !== 'action' && e.purpose !== 'cleanup')
      throw new Error('Invalid Bunk envelope purpose');
    const op = operation(e.operation, wire),
      packed = packBunkEvmV3Operation(op),
      deployed = boolean(e.deployed);
    const userOpHash = bunkEvmUserOpHash(config, op);
    if (
      bunkEvmHex(e.userOpHash as Hex, 32) !== userOpHash ||
      op.sender !== state.account ||
      op.nonce !== state.nonce ||
      packed.accountGasLimits !== certificate.accountGasLimits ||
      op.preVerificationGas !== certificate.preVerificationGas ||
      (state.deployed && !deployed) ||
      (deployed && op.initCode !== '0x')
    )
      throw new Error('Bunk journal envelope scope mismatch');
    if (attempt === 255) {
      const fee = bunkEvmV3RecoveryFee(certificate);
      if (
        e.purpose !== 'cleanup' ||
        !deployed ||
        op.initCode !== '0x' ||
        op.paymasterAndData !== '0x' ||
        op.callData !== bunkEvmV3RecoveryCalls() ||
        op.maxFeePerGas !== fee ||
        op.maxPriorityFeePerGas !== fee
      )
        throw new Error('Invalid Bunk reserved recovery');
    } else if (keccak256(op.callData) !== certificate.callDataHash)
      throw new Error('Bunk journal call hash mismatch');
    const gas =
      op.verificationGasLimit +
      op.callGasLimit +
      op.preVerificationGas +
      (op.paymasterAndData === '0x' ? 0n : 200000n);
    if (
      gas * op.maxFeePerGas > certificate.maxGasCost ||
      (op.paymasterAndData !== '0x' &&
        bunkEvmAddress(slice(op.paymasterAndData, 0, 20)) !== certificate.paymaster)
    )
      throw new Error('Bunk journal gas/paymaster mismatch');
    const signer = envelopeSigners[attempt];
    if (
      !signer ||
      (auth.signature !== null && recoverBunkEvmV3Signer(userOpHash, auth.signature) !== signer)
    )
      throw new Error('Bunk journal envelope signature mismatch');
    return {
      ...auth,
      attempt,
      deployed,
      purpose: e.purpose,
      operation: op,
      userOpHash,
    } as BunkV3JournalEnvelope;
  });
  return {
    format: 'honey-bunk-journal',
    version: 2,
    key,
    config,
    state,
    observation,
    callData,
    certificate,
    envelopeSigners,
    owner,
    envelopes,
  };
}
const json = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
export function encodeBunkV3Journal(record: BunkV3Journal): string {
  const encoded = json(normalize(record, false));
  if (encoded.length > BUNK_JOURNAL_MAX_BYTES) throw new Error('Bunk journal exceeds size limit');
  return encoded;
}
/** Strict canonical JSON: decimal bigint strings, no unknown/duplicate keys or alternate encodings. */
export function decodeBunkV3Journal(encoded: string): BunkV3Journal {
  if (typeof encoded !== 'string' || encoded.length > BUNK_JOURNAL_MAX_BYTES)
    throw new Error('Bunk journal exceeds size limit');
  const record = normalize(JSON.parse(encoded), true);
  if (json(record) !== encoded) throw new Error('Noncanonical Bunk journal encoding');
  return record;
}
function intentRequest(r: BunkV3Journal) {
  return {
    config: r.config,
    state: r.state,
    callData: r.callData,
    verificationGasLimit: BigInt(slice(r.certificate.accountGasLimits, 0, 16)),
    callGasLimit: BigInt(slice(r.certificate.accountGasLimits, 16)),
    preVerificationGas: r.certificate.preVerificationGas,
    maximumGasCost: r.certificate.maxGasCost,
    paymaster: r.certificate.paymaster,
    validAfter: r.certificate.validAfter,
    executeUntil: r.certificate.executeUntil,
  };
}
async function read(store: BunkJournalStore, key: string) {
  const snapshot = await store.read(checkBunkV3JournalKey(key));
  if (!snapshot) throw new Error('Bunk journal not found');
  checkBunkJournalRevision(snapshot.revision);
  const record = decodeBunkV3Journal(snapshot.value);
  if (record.key !== key) throw new Error('Foreign Bunk journal record');
  return { record, revision: snapshot.revision };
}
async function save(store: BunkJournalStore, revision: number, record: BunkV3Journal) {
  checkBunkJournalRevision(revision);
  if (!(await store.compareAndSwap(record.key, revision, encodeBunkV3Journal(record))))
    throw new BunkJournalConflict();
  return revision + 1;
}
export async function reserveBunkV3Intent(
  store: BunkJournalStore,
  seed: Uint8Array,
  request: Parameters<typeof prepareBunkEvmV3Intent>[1],
  observation: BunkEvmObservedBlock,
): Promise<string> {
  const prepared = prepareBunkEvmV3Intent(seed, request);
  const key = bunkV3JournalKey(prepared.currentOwner.commitment);
  const encoded = encodeBunkV3Journal({
    format: 'honey-bunk-journal',
    version: 2,
    key,
    config: request.config,
    state: request.state,
    observation,
    callData: request.callData,
    certificate: prepared.certificate,
    envelopeSigners: prepared.envelopes.signers.map((x) => x.address),
    owner: { phase: 'reserved', signature: null },
    envelopes: [],
  });
  if (!(await store.compareAndSwap(key, null, encoded)))
    throw new BunkJournalConflict('Owner already reserved; load its original approval');
  return key;
}
/** Claims once. A crash after claiming deliberately leaves a signing-uncertain tombstone. */
export async function signReservedBunkV3Intent(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
): Promise<BunkEvmV3Intent> {
  const { record: r, revision } = await read(store, key);
  const prepared = prepareBunkEvmV3Intent(seed, intentRequest(r));
  if (
    prepared.digest !== bunkEvmV3IntentDigest(r.config, r.certificate) ||
    prepared.currentOwner.commitment !== r.state.commitment
  )
    throw new Error('Bunk journal seed/approval mismatch');
  if (r.owner.phase === 'signed' && r.owner.signature)
    return { protocolVersion: 3, certificate: r.certificate, ownerSignature: r.owner.signature };
  if (r.owner.phase !== 'reserved') throw new BunkSigningUncertain();
  r.owner = { phase: 'signing', signature: null };
  const claimed = await save(store, revision, r);
  const signed = signBunkEvmV3Intent(seed, intentRequest(r));
  r.owner = { phase: 'signed', signature: signed.intent.ownerSignature };
  await save(store, claimed, r);
  return signed.intent;
}
/** Explicit crash recovery, never an automatic retry. Recomputes the identical
 * deterministic signature for the durable approval; it cannot approve new bytes.
 * The caller pins the digest reviewed for recovery. This guarantees one distinct
 * signed message per key, NOT one execution of the signing primitive. */
export async function reconstructBunkV3Intent(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  expectedIntentDigest: Hex,
): Promise<BunkEvmV3Intent> {
  const { record: r, revision } = await read(store, key);
  const digest = bunkEvmV3IntentDigest(r.config, r.certificate);
  if (digest !== bunkEvmHex(expectedIntentDigest, 32))
    throw new Error('Bunk recovery approval digest mismatch');
  if (r.owner.phase === 'reserved') throw new Error('Bunk owner signing was not claimed');
  const prepared = prepareBunkEvmV3Intent(seed, intentRequest(r));
  if (prepared.digest !== digest || prepared.currentOwner.commitment !== r.state.commitment)
    throw new Error('Bunk journal seed/approval mismatch');
  if (r.owner.phase === 'signed' && r.owner.signature)
    return { protocolVersion: 3, certificate: r.certificate, ownerSignature: r.owner.signature };
  // Fence the snapshot before computing anything. The slot remains uncertain if
  // either this write or the final write fails; no reservation is ever released.
  const claimed = await save(store, revision, r);
  const { intent } = signBunkEvmV3Intent(seed, intentRequest(r));
  r.owner = { phase: 'signed', signature: intent.ownerSignature };
  if (await store.compareAndSwap(key, claimed, encodeBunkV3Journal(r))) return intent;
  // A live original signer or another explicit recovery may have saved the same
  // deterministic bytes. Return only after verifying those exact bytes are durable.
  const latest = await read(store, key);
  if (
    latest.record.owner.phase === 'signed' &&
    latest.record.owner.signature === intent.ownerSignature &&
    bunkEvmV3IntentDigest(latest.record.config, latest.record.certificate) === digest
  )
    return intent;
  throw new BunkJournalConflict('Bunk owner reconstruction was not persisted');
}
function envelopeRequest(
  r: BunkV3Journal,
  e: BunkV3JournalEnvelope,
  now: number,
  sponsor?: BunkEvmSponsorState,
) {
  if (!r.owner.signature) throw new Error('Bunk owner intent is not signed');
  const proof = bunkEvmV3Tree(r.envelopeSigners).proofs[e.attempt];
  if (!proof) throw new Error('Missing Bunk envelope proof');
  return {
    config: r.config,
    state: { ...r.state, deployed: e.deployed },
    intent: {
      protocolVersion: 3 as const,
      certificate: r.certificate,
      ownerSignature: r.owner.signature,
    },
    operation: e.operation,
    attempt: e.attempt,
    proof,
    purpose: e.purpose,
    now,
    sponsor,
  };
}
export async function reserveBunkV3Envelope(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  request: {
    operation: BunkEvmOperation;
    attempt: number;
    deployed: boolean;
    purpose: 'action' | 'cleanup';
    now: number;
    sponsor?: BunkEvmSponsorState;
  },
): Promise<void> {
  request = {
    ...request,
    operation: { ...request.operation },
    sponsor: request.sponsor
      ? { ...request.sponsor, paymaster: { ...request.sponsor.paymaster } }
      : undefined,
  };
  const { record: r, revision } = await read(store, key);
  const attempt = bunkEvmV3Attempt(request.attempt);
  if (r.envelopes.some((e) => e.attempt === attempt))
    throw new BunkJournalConflict('Envelope leaf already reserved; reuse its exact saved bytes');
  const e: BunkV3JournalEnvelope = {
    phase: 'reserved',
    signature: null,
    attempt,
    deployed: request.deployed,
    purpose: request.purpose,
    operation: { ...request.operation },
    userOpHash: bunkEvmUserOpHash(r.config, request.operation),
  };
  prepareBunkEvmV3Envelope(seed, envelopeRequest(r, e, request.now, request.sponsor));
  r.envelopes.push(e);
  await save(store, revision, r);
}
function signedEnvelope(r: BunkV3Journal, e: BunkV3JournalEnvelope) {
  if (!r.owner.signature || !e.signature || e.phase !== 'signed')
    throw new Error('Bunk envelope not durably signed');
  const proof = bunkEvmV3Tree(r.envelopeSigners).proofs[e.attempt];
  if (!proof) throw new Error('Missing Bunk envelope proof');
  return {
    userOpHash: e.userOpHash,
    operation: {
      ...packBunkEvmV3Operation(e.operation),
      signature: encodeBunkEvmV3Authorization(
        { protocolVersion: 3, certificate: r.certificate, ownerSignature: r.owner.signature },
        e.attempt,
        proof,
        e.signature,
      ),
    },
  };
}
export async function signReservedBunkV3Envelope(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  attempt: number,
  now: number,
  sponsor?: BunkEvmSponsorState,
) {
  sponsor = sponsor ? { ...sponsor, paymaster: { ...sponsor.paymaster } } : undefined;
  const { record: r, revision } = await read(store, key);
  const e = r.envelopes.find((e) => e.attempt === bunkEvmV3Attempt(attempt));
  if (!e) throw new Error('Bunk envelope was not reserved');
  const request = envelopeRequest(r, e, now, sponsor);
  prepareBunkEvmV3Envelope(seed, request);
  if (e.phase === 'signed') return signedEnvelope(r, e);
  if (e.phase !== 'reserved') throw new BunkSigningUncertain();
  e.phase = 'signing';
  await save(store, revision, r);
  const signed = signBunkEvmV3Envelope(seed, request);
  return persistEnvelopeSignature(store, r, e, signed);
}
/** Explicit reconstruction of one uncertain leaf's exact reserved operation.
 * Fee/grant/call changes cannot be supplied here. Existing time and sponsor checks
 * still apply; reconstructing bytes does not prove current on-chain acceptance. */
export async function reconstructBunkV3Envelope(
  store: BunkJournalStore,
  seed: Uint8Array,
  key: string,
  attempt: number,
  expectedUserOpHash: Hex,
  now: number,
  sponsor?: BunkEvmSponsorState,
) {
  sponsor = sponsor ? { ...sponsor, paymaster: { ...sponsor.paymaster } } : undefined;
  const { record: r, revision } = await read(store, key);
  const e = r.envelopes.find((entry) => entry.attempt === bunkEvmV3Attempt(attempt));
  if (!e) throw new Error('Bunk envelope was not reserved');
  if (e.userOpHash !== bunkEvmHex(expectedUserOpHash, 32))
    throw new Error('Bunk recovery operation hash mismatch');
  if (e.phase === 'reserved') throw new Error('Bunk envelope signing was not claimed');
  const request = envelopeRequest(r, e, now, sponsor);
  prepareBunkEvmV3Envelope(seed, request);
  if (e.phase === 'signed') return signedEnvelope(r, e);
  await save(store, revision, r);
  return persistEnvelopeSignature(store, r, e, signBunkEvmV3Envelope(seed, request));
}
async function persistEnvelopeSignature(
  store: BunkJournalStore,
  r: BunkV3Journal,
  e: BunkV3JournalEnvelope,
  signed: ReturnType<typeof signBunkEvmV3Envelope>,
) {
  // Another leaf may be reserved while this signature is being persisted. Merge
  // only this claimed leaf; retry storage CAS, never the signing operation.
  for (let retry = 0; retry < 8; retry++) {
    const latest = await read(store, r.key);
    const target = latest.record.envelopes.find((entry) => entry.attempt === e.attempt);
    if (
      !target ||
      target.userOpHash !== e.userOpHash ||
      latest.record.owner.signature !== r.owner.signature ||
      bunkEvmV3IntentDigest(latest.record.config, latest.record.certificate) !== signed.digest
    ) {
      throw new BunkJournalConflict('Bunk signing claim changed before signature persistence');
    }
    if (target.phase === 'signed' && target.signature === signed.envelopeSignature)
      return signedEnvelope(latest.record, target);
    if (target.phase !== 'signing')
      throw new BunkJournalConflict('Bunk envelope reconstruction conflicts with saved signature');
    target.phase = 'signed';
    target.signature = signed.envelopeSignature;
    if (await store.compareAndSwap(r.key, latest.revision, encodeBunkV3Journal(latest.record))) {
      return signedEnvelope(latest.record, target);
    }
  }
  throw new BunkJournalConflict(
    'Bunk signature not persisted after concurrent changes; signing remains uncertain',
  );
}
/** Reconstructs identical bytes without any key derivation/signing. It does not imply
 * the grant is still usable, the owner is current, or the action will execute. */
export async function readSignedBunkV3Envelope(
  store: BunkJournalStore,
  key: string,
  attempt: number,
) {
  const { record } = await read(store, key);
  const entry = record.envelopes.find((e) => e.attempt === bunkEvmV3Attempt(attempt));
  if (!entry) throw new Error('Bunk envelope was not reserved');
  return signedEnvelope(record, entry);
}
