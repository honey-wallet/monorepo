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
  encodeBunkEvmDeployment,
} from './bunk-evm';
import type { BunkEvmSponsorState } from './bunk-evm-sign';
import {
  type BunkEvmV2Config,
  type BunkEvmV2Intent,
  bunkEvmV2Attempt,
  bunkEvmV2Certificate,
  bunkEvmV2Config,
  bunkEvmV2DeploymentDigest,
  bunkEvmV2IntentDigest,
  bunkEvmV2RecoveryCalls,
  bunkEvmV2RecoveryFee,
  bunkEvmV2Tree,
  decodeBunkEvmV2Calls,
  encodeBunkEvmV2Authorization,
  packBunkEvmV2Operation,
  predictBunkEvmV2Account,
  verifyBunkEvmV2Proof,
} from './bunk-evm-v2';

export interface BunkEvmV2OwnerRef {
  chainId: string;
  accountIndex: number;
  ownerIndex: number;
}
/** Frozen v2 candidate namespace: 0 owner, 1 envelope, 2 deployment. All hardened.
 * This is separate from ALL v1 and conventional wallet paths; v1 keys are never migrated in place. */
export function bunkEvmV2OwnerPath(ref: BunkEvmV2OwnerRef): string {
  const suffix = bunkOwnerPath({
    network: { family: 'evm', chainId: ref.chainId },
    accountIndex: ref.accountIndex,
    ownerIndex: ref.ownerIndex,
  })
    .split('/')
    .slice(3)
    .join('/');
  return `m/7744'/2'/0'/${suffix}`;
}
export function bunkEvmV2EnvelopePath(ref: BunkEvmV2OwnerRef, attempt: number): string {
  return `${bunkEvmV2OwnerPath(ref).replace("/2'/0'/", "/2'/1'/")}/${bunkEvmV2Attempt(attempt)}'`;
}
export function bunkEvmV2DeploymentPath(accountIndex: number): string {
  return `m/7744'/2'/2'/60'/${bunkEvmIndex(accountIndex)}'`;
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
      if (node.index !== part) throw new Error('Bunk v2 derivation skipped a child');
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
    derivationVersion: 2 as const,
    path,
    publicKey: toHex(publicKey),
    address,
    commitment: keccak256(address),
  };
}
export function deriveBunkEvmV2Owner(seed: Uint8Array, ref: BunkEvmV2OwnerRef) {
  const path = bunkEvmV2OwnerPath(ref),
    node = nodeFor(seed, path);
  try {
    return publicDescriptor(node, path);
  } finally {
    node.wipePrivateData();
  }
}
export function deriveBunkEvmV2DeploymentIdentity(seed: Uint8Array, accountIndex: number) {
  const path = bunkEvmV2DeploymentPath(accountIndex),
    node = nodeFor(seed, path);
  try {
    return publicDescriptor(node, path);
  } finally {
    node.wipePrivateData();
  }
}
/** Returns only public leaves/proofs. Prefix reuse avoids repeating BIP32 for all 256 leaves. */
export function deriveBunkEvmV2Envelopes(seed: Uint8Array, ref: BunkEvmV2OwnerRef) {
  const prefix = bunkEvmV2EnvelopePath(ref, 0).split('/').slice(0, -1).join('/');
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
    return { ...bunkEvmV2Tree(signers.map((x) => x.address)), signers };
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
export function recoverBunkEvmV2Signer(digest: Hex, signature: Hex): Address {
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
export function signBunkEvmV2Deployment(
  seed: Uint8Array,
  input: BunkEvmV2Config,
  accountIndex: number,
) {
  const config = bunkEvmV2Config(input),
    identity = deriveBunkEvmV2DeploymentIdentity(seed, accountIndex);
  const firstOwner = deriveBunkEvmV2Owner(seed, {
    chainId: config.chainId,
    accountIndex,
    ownerIndex: 0,
  });
  const account = predictBunkEvmV2Account(config, identity.address, accountIndex);
  const digest = bunkEvmV2DeploymentDigest(
    config,
    identity.address,
    accountIndex,
    firstOwner.commitment,
  );
  const signature = sign(seed, identity.path, digest);
  return {
    protocolVersion: 2 as const,
    identity,
    account,
    firstOwner,
    configHash: bunkEvmConfigHash(config),
    digest,
    signature,
    factoryData: encodeBunkEvmDeployment(
      identity.address,
      accountIndex,
      firstOwner.commitment,
      signature,
    ),
  };
}
/** Caller must verify finalized code/config/state; this type is not an authenticated observation. */
export interface BunkEvmV2SigningState {
  protocolVersion: 2;
  deployed: boolean;
  account: Address;
  accountIndex: number;
  ownerIndex: number;
  commitment: Hex;
  nonce: bigint;
}
function context(seed: Uint8Array, input: BunkEvmV2Config, value: BunkEvmV2SigningState) {
  const config = bunkEvmV2Config(input),
    state = { ...value };
  if (state.protocolVersion !== 2 || typeof state.deployed !== 'boolean')
    throw new Error('Expected Bunk v2 signing state');
  const ref = {
    chainId: config.chainId,
    accountIndex: bunkEvmIndex(state.accountIndex),
    ownerIndex: bunkEvmIndex(state.ownerIndex),
  };
  bunkEvmUint(state.nonce, 64);
  if (!state.deployed && (state.nonce !== 0n || state.ownerIndex !== 0))
    throw new Error('Undeployed Bunk has state');
  const identity = deriveBunkEvmV2DeploymentIdentity(seed, ref.accountIndex),
    account = predictBunkEvmV2Account(config, identity.address, ref.accountIndex);
  if (bunkEvmAddress(state.account) !== account)
    throw new Error('Bunk v2 account does not match seed/configuration');
  const current = deriveBunkEvmV2Owner(seed, ref);
  if (bunkEvmHex(state.commitment, 32) !== current.commitment)
    throw new Error('Bunk v2 owner does not match chain state');
  return { config, state, ref, account, current };
}
/** One owner signature only. Persist approval/reservation before calling and atomically save
 * the returned intent before exposing it. Seed alone cannot recreate lost intent fields.
 * This offline primitive does NOT provide durable locking or multi-device coordination. */
export function prepareBunkEvmV2Intent(
  seed: Uint8Array,
  request: {
    config: BunkEvmV2Config;
    state: BunkEvmV2SigningState;
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
  const calls = decodeBunkEvmV2Calls(config, account, request.callData);
  const next = deriveBunkEvmV2Owner(seed, { ...ref, ownerIndex: ref.ownerIndex + 1 });
  const tree = deriveBunkEvmV2Envelopes(seed, ref);
  const certificate = bunkEvmV2Certificate({
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
  bunkEvmV2RecoveryFee(certificate);
  const digest = bunkEvmV2IntentDigest(config, certificate);
  return { certificate, digest, calls, currentOwner: current, nextOwner: next, envelopes: tree };
}
/** Sign only after a durable approval reservation. Preparation itself does not sign. */
export function signBunkEvmV2Intent(
  seed: Uint8Array,
  request: Parameters<typeof prepareBunkEvmV2Intent>[1],
) {
  const prepared = prepareBunkEvmV2Intent(seed, request);
  const intent: BunkEvmV2Intent = {
    protocolVersion: 2,
    certificate: prepared.certificate,
    ownerSignature: sign(seed, prepared.currentOwner.path, prepared.digest),
  };
  return { ...prepared, intent };
}
/** Retry signs ONLY a fresh envelope key. Owner certificate is checked, never re-signed.
 * Caller must durably reserve the leaf before signing; retry identical bytes from storage.
 * cleanup explicitly acknowledges an expired action. Leaf 255 is cleanup-only. */
export function prepareBunkEvmV2Envelope(
  seed: Uint8Array,
  request: {
    config: BunkEvmV2Config;
    state: BunkEvmV2SigningState;
    intent: BunkEvmV2Intent;
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
    packed = packBunkEvmV2Operation(op),
    attempt = bunkEvmV2Attempt(request.attempt);
  if (request.intent.protocolVersion !== 2) throw new Error('Expected Bunk v2 intent');
  const c = bunkEvmV2Certificate(request.intent.certificate),
    digest = bunkEvmV2IntentDigest(config, c);
  const next = deriveBunkEvmV2Owner(seed, { ...ref, ownerIndex: ref.ownerIndex + 1 });
  const envelopePath = bunkEvmV2EnvelopePath(ref, attempt);
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
    !verifyBunkEvmV2Proof(c.envelopeRoot, attempt, envelopeAddress, proof) ||
    recoverBunkEvmV2Signer(digest, request.intent.ownerSignature) !== current.address
  )
    throw new Error('Bunk v2 intent does not match seed/state');
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
  let calls: ReturnType<typeof decodeBunkEvmV2Calls>;
  if (attempt === 255) {
    const fee = bunkEvmV2RecoveryFee(c);
    if (
      request.purpose !== 'cleanup' ||
      !state.deployed ||
      packed.initCode !== '0x' ||
      packed.paymasterAndData !== '0x' ||
      packed.callData !== bunkEvmV2RecoveryCalls() ||
      op.maxFeePerGas !== fee ||
      op.maxPriorityFeePerGas !== fee
    )
      throw new Error('Invalid Bunk reserved recovery envelope');
    calls = [];
  } else {
    calls = decodeBunkEvmV2Calls(config, account, packed.callData);
    if (keccak256(packed.callData) !== c.callDataHash)
      throw new Error('Bunk envelope changed approved calls');
    if (state.deployed) {
      if (packed.initCode !== '0x') throw new Error('Deployed Bunk must omit initCode');
    } else {
      const deployment = signBunkEvmV2Deployment(seed, config, state.accountIndex);
      if (
        packed.initCode !==
        concatHex([config.factory.address, deployment.factoryData]).toLowerCase()
      )
        throw new Error('Bunk v2 deployment data mismatch');
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
      recoverBunkEvmV2Signer(bunkEvmSponsorshipDigest(config, op, grant), grant.signature) !==
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
export function signBunkEvmV2Envelope(
  seed: Uint8Array,
  request: Parameters<typeof prepareBunkEvmV2Envelope>[1],
) {
  const prepared = prepareBunkEvmV2Envelope(seed, request);
  const envelopeSignature = sign(seed, prepared.envelopePath, prepared.userOpHash);
  return {
    operation: {
      ...prepared.packed,
      signature: encodeBunkEvmV2Authorization(
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
