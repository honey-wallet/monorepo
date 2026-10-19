import { secp256k1 } from '@noble/curves/secp256k1.js';
import { HDKey } from '@scure/bip32';
import {
  type Address,
  concatHex,
  getAddress,
  type Hex,
  hexToBytes,
  keccak256,
  size,
  slice,
  toHex,
} from 'viem';
import {
  BUNK_DERIVATION_VERSION,
  bunkPrivateKeyFor,
  deriveBunkOwner,
  deriveBunkRotation,
} from './bunk';
import {
  type BunkEvmCodeIdentity,
  type BunkEvmConfig,
  type BunkEvmOperation,
  type BunkEvmValidity,
  bunkEvmAddress,
  bunkEvmConfig,
  bunkEvmConfigHash,
  bunkEvmDeploymentDigest,
  bunkEvmHex,
  bunkEvmIndex,
  bunkEvmOwnerDigest,
  bunkEvmSponsorshipDigest,
  bunkEvmUint,
  bunkEvmUserOpHash,
  bunkEvmValidity,
  decodeBunkEvmCalls,
  decodeBunkEvmSponsorship,
  encodeBunkEvmAuthorization,
  encodeBunkEvmDeployment,
  packBunkEvmOperation,
  predictBunkEvmAccount,
} from './bunk-evm';

/** Frozen v1 role. This third component cannot overlap coin branches 0, 60 or 501. */
const DEPLOYMENT_ROLE = 2147483647;
export function bunkEvmDeploymentPath(accountIndex: number): string {
  return `m/7744'/1'/${DEPLOYMENT_ROLE}'/60'/${bunkEvmIndex(accountIndex)}'`;
}
function deploymentKey(seed: Uint8Array, accountIndex: number): Uint8Array {
  if (!(seed instanceof Uint8Array) || seed.length !== 64)
    throw new Error('Bunk requires a 64-byte BIP-39 seed');
  bunkEvmIndex(accountIndex);
  let node = HDKey.fromMasterSeed(seed);
  try {
    for (const part of [7744, BUNK_DERIVATION_VERSION, DEPLOYMENT_ROLE, 60, accountIndex]) {
      const next = node.deriveChild(part + 0x80000000);
      node.wipePrivateData();
      node = next;
      if (node.index !== part + 0x80000000)
        throw new Error('Bunk deployment derivation skipped a child');
    }
    const key = node.privateKey;
    if (!key) throw new Error('Bunk deployment derivation failed');
    return key.slice();
  } finally {
    node.wipePrivateData();
  }
}
const publicAddress = (publicKey: Uint8Array): Address =>
  getAddress(
    slice(keccak256(toHex(secp256k1.Point.fromBytes(publicKey).toBytes(false).subarray(1))), 12),
  );
/** Public, chain-independent deployment identity. No private deployment-key API. */
export function deriveBunkEvmDeploymentIdentity(seed: Uint8Array, accountIndex: number) {
  const key = deploymentKey(seed, accountIndex);
  try {
    const publicKey = secp256k1.getPublicKey(key, true);
    return {
      derivationVersion: BUNK_DERIVATION_VERSION,
      accountIndex,
      path: bunkEvmDeploymentPath(accountIndex),
      publicKey: toHex(publicKey),
      address: publicAddress(publicKey),
    };
  } finally {
    key.fill(0);
  }
}
function signDigest(key: Uint8Array, digest: Hex): Hex {
  const recovered = secp256k1.sign(hexToBytes(bunkEvmHex(digest, 32)), key, {
    prehash: false,
    lowS: true,
    format: 'recovered',
  });
  const recovery = recovered[0];
  if (recovery !== 0 && recovery !== 1) throw new Error('Unsupported Ethereum recovery ID');
  return concatHex([toHex(recovered.subarray(1)), toHex(27 + recovery, { size: 1 })]);
}
function recoverSigner(digest: Hex, signature: Hex): Address {
  const bytes = hexToBytes(bunkEvmHex(signature, 65)),
    v = bytes[64];
  if (v !== 27 && v !== 28) throw new Error('Invalid Honey sponsor recovery ID');
  const recovered = new Uint8Array(65);
  recovered[0] = v - 27;
  recovered.set(bytes.subarray(0, 64), 1);
  const hash = hexToBytes(digest),
    publicKey = secp256k1.recoverPublicKey(recovered, hash, { prehash: false });
  if (!secp256k1.verify(bytes.subarray(0, 64), hash, publicKey, { prehash: false, lowS: true }))
    throw new Error('Invalid Honey sponsor signature');
  return publicAddress(publicKey);
}
/** Deployment certificate only: always derives owner zero from this seed/network. */
export function signBunkEvmDeployment(
  seed: Uint8Array,
  input: BunkEvmConfig,
  accountIndex: number,
) {
  const config = bunkEvmConfig(input),
    identity = deriveBunkEvmDeploymentIdentity(seed, accountIndex);
  const firstOwner = deriveBunkOwner(seed, {
    network: { family: 'evm', chainId: config.chainId },
    accountIndex,
    ownerIndex: 0,
  });
  const account = predictBunkEvmAccount(config, identity.address, accountIndex);
  const digest = bunkEvmDeploymentDigest(
    config,
    identity.address,
    accountIndex,
    firstOwner.commitment,
  );
  const key = deploymentKey(seed, accountIndex);
  try {
    const signature = signDigest(key, digest);
    return {
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
  } finally {
    key.fill(0);
  }
}
/** Public observation supplied by the caller after finalized chain/config verification.
 * This type alone does not authenticate an RPC response or resolve pending operations. */
export interface BunkEvmSigningState {
  account: Address;
  accountIndex: number;
  ownerIndex: number;
  commitment: Hex;
  /** v1 client uses EntryPoint nonce key zero. */
  nonce: bigint;
}
export interface BunkEvmSponsorState {
  paymaster: BunkEvmCodeIdentity;
  signer: Address;
  epoch: bigint;
  maxCostPerOperation: bigint;
}
/** Exact operation signing primitive, not a website-message or transaction signer.
 * Caller must verify registry/code/chain state and persist an approved operation
 * before exposing the signature. This function does not consume/advance an owner. */
export function signBunkEvmOperation(
  seed: Uint8Array,
  request: {
    config: BunkEvmConfig;
    state: BunkEvmSigningState;
    operation: BunkEvmOperation;
    validity: BunkEvmValidity;
    maximumGasCost: bigint;
    sponsor?: BunkEvmSponsorState;
  },
) {
  const config = bunkEvmConfig(request.config),
    state = { ...request.state },
    op = { ...request.operation },
    validity = bunkEvmValidity(request.validity);
  const packed = packBunkEvmOperation(op),
    identity = deriveBunkEvmDeploymentIdentity(seed, state.accountIndex);
  const account = predictBunkEvmAccount(config, identity.address, state.accountIndex);
  if (bunkEvmAddress(state.account) !== account || packed.sender !== account)
    throw new Error('Bunk account does not match the seed/configuration');
  if (bunkEvmUint(state.nonce, 64) !== op.nonce) throw new Error('Bunk EntryPoint nonce mismatch');
  const ref = {
    network: { family: 'evm' as const, chainId: config.chainId },
    accountIndex: state.accountIndex,
    ownerIndex: state.ownerIndex,
  };
  const rotation = deriveBunkRotation(seed, ref);
  if (bunkEvmHex(state.commitment, 32) !== rotation.current.commitment)
    throw new Error('Bunk current owner does not match chain state');
  const calls = decodeBunkEvmCalls(config, account, op.callData);
  if (size(packed.initCode) !== 0) {
    if (state.ownerIndex !== 0 || state.nonce !== 0n)
      throw new Error('Bunk initialization is only valid for the first owner/nonce');
    const certificate = signBunkEvmDeployment(seed, config, state.accountIndex);
    if (
      packed.initCode !== concatHex([config.factory.address, certificate.factoryData]).toLowerCase()
    )
      throw new Error('Bunk deployment data differs from the approved seed/configuration');
  }
  let gas = op.verificationGasLimit + op.callGasLimit + op.preVerificationGas;
  if (size(packed.paymasterAndData) !== 0) gas += BigInt(slice(packed.paymasterAndData, 20, 36));
  const maximumCost = gas * op.maxFeePerGas;
  if (maximumCost > bunkEvmUint(request.maximumGasCost, 256))
    throw new Error('Bunk gas cost exceeds approval');
  if (size(packed.paymasterAndData) !== 0) {
    const sponsor = request.sponsor;
    if (!sponsor) throw new Error('Missing verified Honey sponsor state');
    const address = bunkEvmAddress(slice(packed.paymasterAndData, 0, 20));
    if (address !== bunkEvmAddress(sponsor.paymaster.address))
      throw new Error('Unexpected Honey paymaster');
    // Code hashes are trust anchors supplied by a registry, never inferred from the grant.
    const codeHash = bunkEvmHex(sponsor.paymaster.codeHash, 32);
    if (BigInt(codeHash) === 0n || codeHash === keccak256('0x'))
      throw new Error('Missing Honey paymaster code identity');
    const grant = decodeBunkEvmSponsorship(packed.paymasterAndData);
    if (
      grant.epoch !== bunkEvmUint(sponsor.epoch, 64) ||
      grant.validAfter > validity.validAfter ||
      grant.validUntil < validity.validUntil ||
      maximumCost > grant.maxCost ||
      maximumCost > bunkEvmUint(sponsor.maxCostPerOperation, 128)
    )
      throw new Error('Honey sponsor grant cannot cover this approval');
    if (
      recoverSigner(bunkEvmSponsorshipDigest(config, op, grant), grant.signature) !==
      bunkEvmAddress(sponsor.signer)
    )
      throw new Error('Honey sponsor signature mismatch');
  } else if (request.sponsor) throw new Error('Expected Honey sponsorship is missing');
  const authorization = {
    ownerIndex: state.ownerIndex,
    nextCommitment: rotation.next.commitment,
    ...validity,
  };
  const digest = bunkEvmOwnerDigest(config, op, authorization),
    userOpHash = bunkEvmUserOpHash(config, op);
  const key = bunkPrivateKeyFor(seed, ref);
  try {
    const signature = encodeBunkEvmAuthorization({
      ...authorization,
      signature: signDigest(key, digest),
    });
    return {
      operation: { ...packed, signature },
      userOpHash,
      digest,
      currentOwner: rotation.current,
      nextOwner: rotation.next,
      calls,
      maximumGasCost: maximumCost,
    };
  } finally {
    key.fill(0);
  }
}
