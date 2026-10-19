import { secp256k1 } from '@noble/curves/secp256k1.js';
import { HDKey } from '@scure/bip32';
import {
  type Address,
  concatHex,
  getAddress,
  type Hex,
  hexToBytes,
  keccak256,
  slice,
  toHex,
} from 'viem';
import { bunkOwnerPath } from './bunk';
import {
  type BunkEvmOperation,
  bunkEvmAddress,
  bunkEvmConfigHash,
  bunkEvmHex,
  bunkEvmIndex,
  bunkEvmSponsorshipDigest,
  bunkEvmUint,
  bunkEvmUserOpHash,
  decodeBunkEvmSponsorship,
} from './bunk-evm';
import type { BunkEvmSponsorState } from './bunk-evm-sign';
import {
  type BunkEvmV3Config,
  type BunkEvmV3Intent,
  bunkEvmV3Attempt,
  bunkEvmV3Certificate,
  bunkEvmV3Config,
  bunkEvmV3DeploymentDigest,
  bunkEvmV3IntentDigest,
  bunkEvmV3KeyScope,
  bunkEvmV3RecoveryCalls,
  bunkEvmV3RecoveryFee,
  bunkEvmV3SeedRecoveryDigest,
  bunkEvmV3Tree,
  decodeBunkEvmV3Calls,
  encodeBunkEvmV3Authorization,
  encodeBunkEvmV3Deployment,
  encodeBunkEvmV3SeedRecovery,
  packBunkEvmV3Operation,
  predictBunkEvmV3Account,
  verifyBunkEvmV3Proof,
} from './bunk-evm-v3';

export interface BunkEvmV3KeyRef {
  chainId: string;
  keyScope: Hex;
  accountIndex: number;
  epoch: number;
}
export interface BunkEvmV3OwnerRef extends BunkEvmV3KeyRef {
  ownerIndex: number;
}
/** Frozen candidate v3 namespace. Every component is hardened; scope and chain
 * each encode all 256 bits as nine big-endian 31-bit components, including zeros. */
function keyPrefix(ref: BunkEvmV3KeyRef, role: 0 | 1 | 3): string {
  const network = bunkOwnerPath({
    network: { family: 'evm', chainId: ref.chainId },
    accountIndex: ref.accountIndex,
    ownerIndex: 0,
  })
    .split('/')
    .slice(3, -2)
    .join('/');
  const scope = BigInt(bunkEvmHex(ref.keyScope, 32));
  if (scope === 0n) throw new Error('Missing Bunk key scope');
  const parts = Array.from(
    { length: 9 },
    (_, i) => `${Number((scope >> BigInt((8 - i) * 31)) & 0x7fffffffn)}'`,
  ).join('/');
  return `m/7744'/3'/${role}'/${network}/${parts}/${bunkEvmIndex(ref.accountIndex)}'/${bunkEvmIndex(ref.epoch)}'`;
}
export function bunkEvmV3OwnerPath(ref: BunkEvmV3OwnerRef): string {
  return `${keyPrefix(ref, 0)}/${bunkEvmIndex(ref.ownerIndex)}'`;
}
export function bunkEvmV3EnvelopePath(ref: BunkEvmV3OwnerRef, attempt: number): string {
  return `${keyPrefix(ref, 1)}/${bunkEvmIndex(ref.ownerIndex)}'/${bunkEvmV3Attempt(attempt)}'`;
}
export function bunkEvmV3RecoveryPath(ref: BunkEvmV3KeyRef): string {
  return keyPrefix(ref, 3);
}
export function bunkEvmV3DeploymentPath(accountIndex: number): string {
  return `m/7744'/3'/2'/60'/${bunkEvmIndex(accountIndex)}'`;
}
function nodeFor(seed: Uint8Array, path: string): HDKey {
  if (!(seed instanceof Uint8Array) || seed.length !== 64)
    throw new Error('Bunk requires a 64-byte BIP-39 seed');
  let node = HDKey.fromMasterSeed(seed);
  try {
    for (const component of path.split('/').slice(1)) {
      const part = Number(component.slice(0, -1)) + 0x80000000;
      const next = node.deriveChild(part);
      node.wipePrivateData();
      node = next;
      if (node.index !== part) throw new Error('Bunk v3 derivation skipped a child');
    }
    return node;
  } catch (error) {
    node.wipePrivateData();
    throw error;
  }
}
const publicAddress = (publicKey: Uint8Array): Address =>
  getAddress(
    slice(keccak256(toHex(secp256k1.Point.fromBytes(publicKey).toBytes(false).subarray(1))), 12),
  );
function publicDescriptor(node: HDKey, path: string) {
  const publicKey = node.publicKey;
  if (!publicKey) throw new Error('Missing Bunk public key');
  const address = publicAddress(publicKey);
  return {
    derivationVersion: 3 as const,
    path,
    publicKey: toHex(publicKey),
    address,
    commitment: keccak256(address),
  };
}
export function deriveBunkEvmV3Owner(seed: Uint8Array, ref: BunkEvmV3OwnerRef) {
  const path = bunkEvmV3OwnerPath(ref),
    node = nodeFor(seed, path);
  try {
    return publicDescriptor(node, path);
  } finally {
    node.wipePrivateData();
  }
}
export function deriveBunkEvmV3Recovery(seed: Uint8Array, ref: BunkEvmV3KeyRef) {
  const path = bunkEvmV3RecoveryPath(ref),
    node = nodeFor(seed, path);
  try {
    return publicDescriptor(node, path);
  } finally {
    node.wipePrivateData();
  }
}
export function deriveBunkEvmV3DeploymentIdentity(seed: Uint8Array, accountIndex: number) {
  const path = bunkEvmV3DeploymentPath(accountIndex),
    node = nodeFor(seed, path);
  try {
    return publicDescriptor(node, path);
  } finally {
    node.wipePrivateData();
  }
}
/** Returns only public leaves/proofs. Prefix reuse avoids repeating BIP32 for all 256 leaves. */
export function deriveBunkEvmV3Envelopes(seed: Uint8Array, ref: BunkEvmV3OwnerRef) {
  const prefix = bunkEvmV3EnvelopePath(ref, 0).split('/').slice(0, -1).join('/');
  const node = nodeFor(seed, prefix);
  try {
    const signers = Array.from({ length: 256 }, (_, index) => {
      const child = node.deriveChild(index + 0x80000000);
      try {
        if (child.index !== index + 0x80000000)
          throw new Error('Bunk envelope derivation skipped a child');
        return publicDescriptor(child, `${prefix}/${index}'`);
      } finally {
        child.wipePrivateData();
      }
    });
    return { ...bunkEvmV3Tree(signers.map((x) => x.address)), signers };
  } finally {
    node.wipePrivateData();
  }
}
function sign(seed: Uint8Array, path: string, digest: Hex): Hex {
  const node = nodeFor(seed, path);
  const key = node.privateKey;
  try {
    if (!key) throw new Error('Missing Bunk signing key');
    const result = secp256k1.sign(hexToBytes(bunkEvmHex(digest, 32)), key, {
      prehash: false,
      lowS: true,
      // Journal recovery must reconstruct identical RFC6979 bytes, never a new nonce.
      extraEntropy: false,
      format: 'recovered',
    });
    if (result[0] !== 0 && result[0] !== 1) throw new Error('Unsupported Ethereum recovery ID');
    return concatHex([toHex(result.subarray(1)), toHex(result[0] + 27, { size: 1 })]);
  } finally {
    key?.fill(0);
    node.wipePrivateData();
  }
}
export function recoverBunkEvmV3Signer(digest: Hex, signature: Hex): Address {
  const bytes = hexToBytes(bunkEvmHex(signature, 65));
  if (bytes[64] !== 27 && bytes[64] !== 28) throw new Error('Invalid Bunk recovery ID');
  const recovered = new Uint8Array(65);
  recovered[0] = bytes[64] - 27;
  recovered.set(bytes.subarray(0, 64), 1);
  const hash = hexToBytes(digest),
    publicKey = secp256k1.recoverPublicKey(recovered, hash, { prehash: false });
  if (!secp256k1.verify(bytes.subarray(0, 64), hash, publicKey, { prehash: false, lowS: true }))
    throw new Error('Invalid Bunk signature');
  return publicAddress(publicKey);
}
export function signBunkEvmV3Deployment(
  seed: Uint8Array,
  input: BunkEvmV3Config,
  accountIndex: number,
) {
  const config = bunkEvmV3Config(input),
    identity = deriveBunkEvmV3DeploymentIdentity(seed, accountIndex);
  const firstOwner = deriveBunkEvmV3Owner(seed, {
    chainId: config.chainId,
    keyScope: bunkEvmV3KeyScope(config),
    accountIndex,
    epoch: 0,
    ownerIndex: 0,
  });
  const firstRecovery = deriveBunkEvmV3Recovery(seed, {
    chainId: config.chainId,
    keyScope: bunkEvmV3KeyScope(config),
    accountIndex,
    epoch: 0,
  });
  const account = predictBunkEvmV3Account(config, identity.address, accountIndex);
  const digest = bunkEvmV3DeploymentDigest(
    config,
    identity.address,
    accountIndex,
    firstOwner.commitment,
    firstRecovery.commitment,
  );
  const signature = sign(seed, identity.path, digest);
  return {
    protocolVersion: 3 as const,
    identity,
    account,
    firstOwner,
    firstRecovery,
    configHash: bunkEvmConfigHash(config),
    digest,
    signature,
    factoryData: encodeBunkEvmV3Deployment(
      identity.address,
      accountIndex,
      firstOwner.commitment,
      firstRecovery.commitment,
      signature,
    ),
  };
}
/** Caller must verify finalized code/config/state; this type is not an authenticated observation. */
export interface BunkEvmV3SigningState {
  protocolVersion: 3;
  deployed: boolean;
  account: Address;
  accountIndex: number;
  ownerIndex: number;
  commitment: Hex;
  nonce: bigint;
  epoch: number;
  recoveryCommitment: Hex;
}
function context(seed: Uint8Array, input: BunkEvmV3Config, value: BunkEvmV3SigningState) {
  const config = bunkEvmV3Config(input),
    state = { ...value };
  if (state.protocolVersion !== 3 || typeof state.deployed !== 'boolean')
    throw new Error('Expected Bunk v3 signing state');
  const ref = {
    chainId: config.chainId,
    keyScope: bunkEvmV3KeyScope(config),
    epoch: bunkEvmIndex(state.epoch),
    accountIndex: bunkEvmIndex(state.accountIndex),
    ownerIndex: bunkEvmIndex(state.ownerIndex),
  };
  bunkEvmUint(state.nonce, 64);
  if (!state.deployed && (state.nonce !== 0n || state.ownerIndex !== 0 || state.epoch !== 0))
    throw new Error('Undeployed Bunk has state');
  const identity = deriveBunkEvmV3DeploymentIdentity(seed, ref.accountIndex),
    account = predictBunkEvmV3Account(config, identity.address, ref.accountIndex);
  if (bunkEvmAddress(state.account) !== account)
    throw new Error('Bunk v3 account does not match seed/configuration');
  const recovery = deriveBunkEvmV3Recovery(seed, ref);
  if (bunkEvmHex(state.recoveryCommitment, 32) !== recovery.commitment)
    throw new Error('Bunk v3 recovery does not match chain state');
  const current = deriveBunkEvmV3Owner(seed, ref);
  if (bunkEvmHex(state.commitment, 32) !== current.commitment)
    throw new Error('Bunk v3 owner does not match chain state');
  return { config, state, ref, account, current };
}
/** One owner signature only. Persist approval/reservation before calling and atomically save
 * the returned intent before exposing it. Seed alone cannot recreate lost intent fields.
 * This offline primitive does NOT provide durable locking or multi-device coordination. */
export function prepareBunkEvmV3Intent(
  seed: Uint8Array,
  request: {
    config: BunkEvmV3Config;
    state: BunkEvmV3SigningState;
    callData: Hex;
    verificationGasLimit: bigint;
    callGasLimit: bigint;
    preVerificationGas: bigint;
    maximumGasCost: bigint;
    paymaster: Address;
    validAfter: number;
    executeUntil: number;
  },
) {
  const { config, state, ref, account, current } = context(seed, request.config, request.state);
  const calls = decodeBunkEvmV3Calls(config, account, request.callData);
  const next = deriveBunkEvmV3Owner(seed, { ...ref, ownerIndex: ref.ownerIndex + 1 });
  const tree = deriveBunkEvmV3Envelopes(seed, ref);
  const certificate = bunkEvmV3Certificate({
    entryPoint: config.entryPoint.address,
    account,
    nonce: state.nonce,
    callDataHash: keccak256(request.callData),
    accountGasLimits: concatHex([
      toHex(bunkEvmUint(request.verificationGasLimit, 128), { size: 16 }),
      toHex(bunkEvmUint(request.callGasLimit, 128), { size: 16 }),
    ]),
    preVerificationGas: request.preVerificationGas,
    maxGasCost: request.maximumGasCost,
    paymaster: request.paymaster,
    ownerIndex: ref.ownerIndex,
    nextCommitment: next.commitment,
    envelopeRoot: tree.root,
    validAfter: request.validAfter,
    executeUntil: request.executeUntil,
  });
  bunkEvmV3RecoveryFee(certificate);
  const digest = bunkEvmV3IntentDigest(config, certificate);
  return { certificate, digest, calls, currentOwner: current, nextOwner: next, envelopes: tree };
}
/** Sign only after a durable approval reservation. Preparation itself does not sign. */
export function signBunkEvmV3Intent(
  seed: Uint8Array,
  request: Parameters<typeof prepareBunkEvmV3Intent>[1],
) {
  const prepared = prepareBunkEvmV3Intent(seed, request);
  const intent: BunkEvmV3Intent = {
    protocolVersion: 3,
    certificate: prepared.certificate,
    ownerSignature: sign(seed, prepared.currentOwner.path, prepared.digest),
  };
  return { ...prepared, intent };
}
/** Retry signs ONLY a fresh envelope key. Owner certificate is checked, never re-signed.
 * Caller must durably reserve the leaf before signing; retry identical bytes from storage.
 * cleanup explicitly acknowledges an expired action. Leaf 255 is cleanup-only. */
export function prepareBunkEvmV3Envelope(
  seed: Uint8Array,
  request: {
    config: BunkEvmV3Config;
    state: BunkEvmV3SigningState;
    intent: BunkEvmV3Intent;
    operation: BunkEvmOperation;
    attempt: number;
    proof: readonly Hex[];
    purpose: 'action' | 'cleanup';
    now: number;
    sponsor?: BunkEvmSponsorState;
  },
) {
  const { config, state, ref, account, current } = context(seed, request.config, request.state);
  const op = { ...request.operation },
    packed = packBunkEvmV3Operation(op),
    attempt = bunkEvmV3Attempt(request.attempt);
  if (request.intent.protocolVersion !== 3) throw new Error('Expected Bunk v3 intent');
  const c = bunkEvmV3Certificate(request.intent.certificate),
    digest = bunkEvmV3IntentDigest(config, c);
  const next = deriveBunkEvmV3Owner(seed, { ...ref, ownerIndex: ref.ownerIndex + 1 });
  const envelopePath = bunkEvmV3EnvelopePath(ref, attempt);
  const node = nodeFor(seed, envelopePath);
  let envelopeAddress: Address;
  try {
    envelopeAddress = publicDescriptor(node, envelopePath).address;
  } finally {
    node.wipePrivateData();
  }
  const proof = request.proof.map((p) => bunkEvmHex(p, 32));
  if (
    c.account !== account ||
    packed.sender !== account ||
    c.nonce !== state.nonce ||
    packed.nonce !== state.nonce ||
    c.ownerIndex !== ref.ownerIndex ||
    c.nextCommitment !== next.commitment ||
    !verifyBunkEvmV3Proof(c.envelopeRoot, attempt, envelopeAddress, proof) ||
    recoverBunkEvmV3Signer(digest, request.intent.ownerSignature) !== current.address
  )
    throw new Error('Bunk v3 intent does not match seed/state');
  if (
    c.accountGasLimits !== packed.accountGasLimits ||
    c.preVerificationGas !== packed.preVerificationGas
  )
    throw new Error('Bunk envelope changed signed gas limits');
  if (!Number.isSafeInteger(request.now) || request.now < 0 || request.now >= 2 ** 48)
    throw new Error('Invalid Bunk signing clock');
  if (request.purpose !== 'action' && request.purpose !== 'cleanup')
    throw new Error('Invalid Bunk envelope purpose');
  if (
    request.now < c.validAfter ||
    (request.purpose === 'action' ? request.now > c.executeUntil : request.now <= c.executeUntil)
  )
    throw new Error('Bunk action/cleanup time mismatch');
  let calls: ReturnType<typeof decodeBunkEvmV3Calls>;
  if (attempt === 255) {
    const fee = bunkEvmV3RecoveryFee(c);
    if (
      request.purpose !== 'cleanup' ||
      !state.deployed ||
      packed.initCode !== '0x' ||
      packed.paymasterAndData !== '0x' ||
      packed.callData !== bunkEvmV3RecoveryCalls() ||
      op.maxFeePerGas !== fee ||
      op.maxPriorityFeePerGas !== fee
    )
      throw new Error('Invalid Bunk reserved recovery envelope');
    calls = [];
  } else {
    calls = decodeBunkEvmV3Calls(config, account, packed.callData);
    if (keccak256(packed.callData) !== c.callDataHash)
      throw new Error('Bunk envelope changed approved calls');
    if (state.deployed) {
      if (packed.initCode !== '0x') throw new Error('Deployed Bunk must omit initCode');
    } else {
      const deployment = signBunkEvmV3Deployment(seed, config, state.accountIndex);
      if (
        packed.initCode !==
        concatHex([config.factory.address, deployment.factoryData]).toLowerCase()
      )
        throw new Error('Bunk v3 deployment data mismatch');
    }
  }
  let gas = op.verificationGasLimit + op.callGasLimit + op.preVerificationGas;
  if (packed.paymasterAndData !== '0x') gas += 200000n;
  const maximumGasCost = gas * op.maxFeePerGas;
  if (maximumGasCost > c.maxGasCost) throw new Error('Bunk gas cost exceeds signed intent');
  if (packed.paymasterAndData !== '0x') {
    const sponsor = request.sponsor;
    if (!sponsor) throw new Error('Missing verified Honey sponsor state');
    const paymaster = bunkEvmAddress(slice(packed.paymasterAndData, 0, 20));
    if (paymaster !== c.paymaster || paymaster !== bunkEvmAddress(sponsor.paymaster.address))
      throw new Error('Unexpected Honey paymaster');
    const codeHash = bunkEvmHex(sponsor.paymaster.codeHash, 32);
    if (BigInt(codeHash) === 0n || codeHash === keccak256('0x'))
      throw new Error('Missing Honey paymaster code identity');
    const grant = decodeBunkEvmSponsorship(packed.paymasterAndData);
    if (
      grant.epoch !== bunkEvmUint(sponsor.epoch, 64) ||
      grant.validAfter > request.now ||
      grant.validUntil <= request.now ||
      maximumGasCost > grant.maxCost ||
      maximumGasCost > bunkEvmUint(sponsor.maxCostPerOperation, 128)
    )
      throw new Error('Honey sponsor grant cannot cover this envelope');
    if (
      recoverBunkEvmV3Signer(bunkEvmSponsorshipDigest(config, op, grant), grant.signature) !==
      bunkEvmAddress(sponsor.signer)
    )
      throw new Error('Honey sponsor signature mismatch');
  } else if (request.sponsor) throw new Error('Expected Honey sponsorship is missing');
  const userOpHash = bunkEvmUserOpHash(config, op);
  return {
    packed,
    envelopePath,
    proof,
    userOpHash,
    digest,
    calls,
    maximumGasCost,
    purpose: request.purpose,
  };
}
/** Sign only after the exact leaf/hash has been durably reserved. */
export function signBunkEvmV3Envelope(
  seed: Uint8Array,
  request: Parameters<typeof prepareBunkEvmV3Envelope>[1],
) {
  const prepared = prepareBunkEvmV3Envelope(seed, request);
  const envelopeSignature = sign(seed, prepared.envelopePath, prepared.userOpHash);
  return {
    operation: {
      ...prepared.packed,
      signature: encodeBunkEvmV3Authorization(
        request.intent,
        request.attempt,
        prepared.proof,
        envelopeSignature,
      ),
    },
    envelopeSignature,
    userOpHash: prepared.userOpHash,
    digest: prepared.digest,
    calls: prepared.calls,
    maximumGasCost: prepared.maximumGasCost,
    purpose: prepared.purpose,
  };
}

/** Caller must verify finalized code/account/recovery state. Recovery deliberately
 * does not require the lost/current ordinary owner, its index, nonce or journal. */
export interface BunkEvmV3RecoveryState {
  protocolVersion: 3;
  account: Address;
  accountIndex: number;
  epoch: number;
  recoveryCommitment: Hex;
}
export function prepareBunkEvmV3SeedRecovery(
  seed: Uint8Array,
  input: BunkEvmV3Config,
  state: BunkEvmV3RecoveryState,
) {
  const config = bunkEvmV3Config(input);
  if (state.protocolVersion !== 3) throw new Error('Expected Bunk v3 recovery state');
  const ref = {
    chainId: config.chainId,
    keyScope: bunkEvmV3KeyScope(config),
    accountIndex: bunkEvmIndex(state.accountIndex),
    epoch: bunkEvmIndex(state.epoch),
  };
  const identity = deriveBunkEvmV3DeploymentIdentity(seed, ref.accountIndex);
  const account = predictBunkEvmV3Account(config, identity.address, ref.accountIndex);
  if (bunkEvmAddress(state.account) !== account)
    throw new Error('Bunk recovery account does not match seed/configuration');
  const currentRecovery = deriveBunkEvmV3Recovery(seed, ref);
  if (bunkEvmHex(state.recoveryCommitment, 32) !== currentRecovery.commitment)
    throw new Error('Bunk recovery key does not match chain state');
  const nextRef = { ...ref, epoch: bunkEvmIndex(ref.epoch + 1) };
  const nextOwner = deriveBunkEvmV3Owner(seed, { ...nextRef, ownerIndex: 0 });
  const nextRecovery = deriveBunkEvmV3Recovery(seed, nextRef);
  const recovery = {
    protocolVersion: 3 as const,
    account,
    epoch: ref.epoch,
    nextOwnerCommitment: nextOwner.commitment,
    nextRecoveryCommitment: nextRecovery.commitment,
  };
  const digest = bunkEvmV3SeedRecoveryDigest(config, recovery);
  return {
    recovery,
    digest,
    currentRecovery,
    nextOwner,
    nextRecovery,
  };
}
/** The account coordinator persists a claim before invoking this primitive. */
export function signBunkEvmV3SeedRecovery(
  seed: Uint8Array,
  input: BunkEvmV3Config,
  state: BunkEvmV3RecoveryState,
) {
  const prepared = prepareBunkEvmV3SeedRecovery(seed, input, state);
  const signature = sign(seed, prepared.currentRecovery.path, prepared.digest);
  return {
    ...prepared,
    signature,
    transaction: {
      to: bunkEvmV3Config(input).module.address,
      value: 0n,
      data: encodeBunkEvmV3SeedRecovery(prepared.recovery, signature),
    },
  };
}
