import {
  type Address,
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  hashTypedData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  size,
  slice,
  toFunctionSelector,
  toHex,
  zeroHash,
} from 'viem';
import { BUNK_MAX_INDEX } from './bunk';
import {
  type BunkEvmCall,
  type BunkEvmConfig,
  type BunkEvmOperation,
  bunkEvmAddress,
  bunkEvmConfig,
  bunkEvmConfigHash,
  bunkEvmHex,
  bunkEvmIndex,
  bunkEvmInitializer,
  bunkEvmUint,
  bunkEvmValidity,
  packBunkEvmOperation,
} from './bunk-evm';

/** Explicit protocol discriminator. Registry code identities still require independent verification. */
export interface BunkEvmV3Config extends BunkEvmConfig {
  protocolVersion: 3;
}
export interface BunkEvmV3Certificate {
  entryPoint: Address;
  account: Address;
  nonce: bigint;
  callDataHash: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  maxGasCost: bigint;
  paymaster: Address;
  ownerIndex: number;
  nextCommitment: Hex;
  envelopeRoot: Hex;
  validAfter: number;
  executeUntil: number;
}
export interface BunkEvmV3Intent {
  protocolVersion: 3;
  certificate: BunkEvmV3Certificate;
  ownerSignature: Hex;
}
export const BUNK_EVM_V3_CERTIFICATE_FIELDS = [
  { name: 'entryPoint', type: 'address' },
  { name: 'account', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'callDataHash', type: 'bytes32' },
  { name: 'accountGasLimits', type: 'bytes32' },
  { name: 'preVerificationGas', type: 'uint256' },
  { name: 'maxGasCost', type: 'uint128' },
  { name: 'paymaster', type: 'address' },
  { name: 'ownerIndex', type: 'uint32' },
  { name: 'nextCommitment', type: 'bytes32' },
  { name: 'envelopeRoot', type: 'bytes32' },
  { name: 'validAfter', type: 'uint48' },
  { name: 'executeUntil', type: 'uint48' },
] as const;
const certificateTuple =
  '(address entryPoint,address account,uint256 nonce,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,uint128 maxGasCost,address paymaster,uint32 ownerIndex,bytes32 nextCommitment,bytes32 envelopeRoot,uint48 validAfter,uint48 executeUntil)';
const authorizationAbi = parseAbiParameters(
  `(${certificateTuple} certificate,uint8 attempt,bytes32[] proof,bytes ownerSignature,bytes envelopeSignature)`,
);
const callsAbi = parseAbiParameters('(address target,uint256 value,bytes data)[]');
const executeSelector = toFunctionSelector(
  'executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)',
);
const withdrawalAbi = parseAbi([
  'function withdrawTo(address withdrawAddress,uint256 withdrawAmount)',
]);

export function bunkEvmV3Config(input: BunkEvmV3Config): BunkEvmV3Config {
  if (input.protocolVersion !== 3) throw new Error('Expected Bunk protocol version 3');
  return { ...bunkEvmConfig(input), protocolVersion: 3 };
}
export function predictBunkEvmV3Account(
  input: BunkEvmV3Config,
  identity: Address,
  accountIndex: number,
): Address {
  const c = bunkEvmV3Config(input);
  const nonce = keccak256(
    encodeAbiParameters(parseAbiParameters('string,address,uint32'), [
      'HoneyBunkAccountV3',
      bunkEvmAddress(identity),
      bunkEvmIndex(accountIndex),
    ]),
  );
  const salt = keccak256(concatHex([keccak256(bunkEvmInitializer(c)), nonce]));
  const initHash = keccak256(
    concatHex([c.proxyCreationCode, toHex(BigInt(c.singleton.address), { size: 32 })]),
  );
  return getAddress(
    slice(keccak256(concatHex(['0xff', c.proxyFactory.address, salt, initHash])), 12),
  );
}
export function bunkEvmV3DeploymentDigest(
  input: BunkEvmV3Config,
  identity: Address,
  accountIndex: number,
  commitment: Hex,
  recoveryCommitment: Hex,
): Hex {
  const c = bunkEvmV3Config(input),
    hash = bunkEvmHex(commitment, 32),
    recovery = bunkEvmHex(recoveryCommitment, 32);
  if (hash === zeroHash || recovery === zeroHash || hash === recovery)
    throw new Error('Invalid initial commitments');
  return hashTypedData({
    domain: {
      name: 'HoneyBunkDeployment',
      version: '3',
      chainId: BigInt(c.chainId),
      verifyingContract: c.factory.address,
    },
    primaryType: 'BunkDeployment',
    types: {
      BunkDeployment: [
        { name: 'identity', type: 'address' },
        { name: 'accountIndex', type: 'uint32' },
        { name: 'account', type: 'address' },
        { name: 'commitment', type: 'bytes32' },
        { name: 'recoveryCommitment', type: 'bytes32' },
        { name: 'configHash', type: 'bytes32' },
      ],
    },
    message: {
      identity: bunkEvmAddress(identity),
      accountIndex: bunkEvmIndex(accountIndex),
      account: predictBunkEvmV3Account(c, identity, accountIndex),
      commitment: hash,
      recoveryCommitment: recovery,
      configHash: bunkEvmConfigHash(c),
    },
  });
}
/** Canonical CALL batch. Empty batches are available only through the reserved recovery helper. */
export function encodeBunkEvmV3Calls(
  input: BunkEvmV3Config,
  accountInput: Address,
  calls: readonly BunkEvmCall[],
): Hex {
  const c = bunkEvmV3Config(input),
    account = bunkEvmAddress(accountInput);
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 16)
    throw new Error('Bunk requires 1 to 16 calls');
  const forbidden = new Set(
    [account, c.factory.address, c.module.address].map((x) => x.toLowerCase()),
  );
  const checked = calls.map((call) => {
    const target = bunkEvmAddress(call.target),
      value = bunkEvmUint(call.value, 256),
      data = bunkEvmHex(call.data);
    if (forbidden.has(target.toLowerCase()))
      throw new Error('Forbidden Bunk administration target');
    if (size(data) > 6144) throw new Error('Bunk call data too large');
    if (target === c.entryPoint.address) {
      if (value !== 0n || size(data) !== 68) throw new Error('Invalid Bunk gas-deposit withdrawal');
      const amount = BigInt(slice(data, 36));
      if (
        data !==
        encodeFunctionData({
          abi: withdrawalAbi,
          functionName: 'withdrawTo',
          args: [account, amount],
        })
      )
        throw new Error('Invalid Bunk gas-deposit withdrawal');
    }
    return { target, value, data };
  });
  const encoded = concatHex([executeSelector, encodeAbiParameters(callsAbi, [checked])]);
  if (size(encoded) > 6144) throw new Error('Bunk call data too large');
  return encoded;
}
export function decodeBunkEvmV3Calls(
  c: BunkEvmV3Config,
  account: Address,
  input: Hex,
): readonly BunkEvmCall[] {
  const encoded = bunkEvmHex(input);
  if (size(encoded) < 4 || size(encoded) > 6144 || slice(encoded, 0, 4) !== executeSelector)
    throw new Error('Invalid Bunk call selector/length');
  const [calls] = decodeAbiParameters(callsAbi, slice(encoded, 4));
  if (encodeBunkEvmV3Calls(c, account, calls) !== encoded)
    throw new Error('Noncanonical Bunk calls');
  return calls;
}
export const bunkEvmV3RecoveryCalls = (): Hex =>
  concatHex([executeSelector, encodeAbiParameters(callsAbi, [[]])]);
export function bunkEvmV3Attempt(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 255)
    throw new Error('Invalid Bunk envelope attempt');
  return attempt;
}
export function bunkEvmV3Leaf(attempt: number, signer: Address): Hex {
  return keccak256(
    keccak256(
      encodeAbiParameters(parseAbiParameters('uint8,address'), [
        bunkEvmV3Attempt(attempt),
        bunkEvmAddress(signer),
      ]),
    ),
  );
}
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('Incomplete Bunk Merkle tree');
  return value;
}
const pair = (a: Hex, b: Hex): Hex => keccak256(concatHex(a < b ? [a, b] : [b, a]));
/** Fixed index tree, sorted pairs. This is not a sorted-leaf tree. */
export function bunkEvmV3Tree(signers: readonly Address[]) {
  if (
    signers.length !== 256 ||
    new Set(signers.map((x) => bunkEvmAddress(x).toLowerCase())).size !== 256
  )
    throw new Error('Bunk needs 256 distinct envelope signers');
  const levels: Hex[][] = [signers.map((address, i) => bunkEvmV3Leaf(i, address))];
  for (let width = 256; width > 1; width /= 2) {
    const previous = at(levels, levels.length - 1);
    levels.push(
      Array.from({ length: width / 2 }, (_, i) =>
        pair(at(previous, i * 2), at(previous, i * 2 + 1)),
      ),
    );
  }
  return {
    root: at(at(levels, 8), 0),
    proofs: signers.map((_, index) =>
      levels.slice(0, 8).map((level, depth) => at(level, (index >> depth) ^ 1)),
    ),
  };
}
export function verifyBunkEvmV3Proof(
  root: Hex,
  attempt: number,
  signer: Address,
  proof: readonly Hex[],
): boolean {
  if (proof.length !== 8) throw new Error('Invalid Bunk envelope proof length');
  return (
    proof.reduce(
      (hash, sibling) => pair(hash, bunkEvmHex(sibling, 32)),
      bunkEvmV3Leaf(attempt, signer),
    ) === bunkEvmHex(root, 32)
  );
}
export function bunkEvmV3Certificate(input: BunkEvmV3Certificate): BunkEvmV3Certificate {
  const c = {
    ...input,
    entryPoint: bunkEvmAddress(input.entryPoint),
    account: bunkEvmAddress(input.account),
    nonce: bunkEvmUint(input.nonce, 64),
    callDataHash: bunkEvmHex(input.callDataHash, 32),
    accountGasLimits: bunkEvmHex(input.accountGasLimits, 32),
    preVerificationGas: bunkEvmUint(input.preVerificationGas, 120),
    maxGasCost: bunkEvmUint(input.maxGasCost, 128),
    paymaster: getAddress(bunkEvmHex(input.paymaster, 20)),
    ownerIndex: bunkEvmIndex(input.ownerIndex),
    nextCommitment: bunkEvmHex(input.nextCommitment, 32),
    envelopeRoot: bunkEvmHex(input.envelopeRoot, 32),
  };
  bunkEvmValidity({ validAfter: c.validAfter, validUntil: c.executeUntil });
  const verification = BigInt(slice(c.accountGasLimits, 0, 16)),
    call = BigInt(slice(c.accountGasLimits, 16));
  if (
    verification === 0n ||
    verification > 500000n ||
    call === 0n ||
    call >= 1n << 120n ||
    c.preVerificationGas === 0n ||
    c.maxGasCost === 0n ||
    c.ownerIndex === BUNK_MAX_INDEX ||
    c.nextCommitment === zeroHash ||
    c.envelopeRoot === zeroHash ||
    c.executeUntil === 2 ** 48 - 1
  )
    throw new Error('Invalid Bunk v3 certificate');
  return c;
}
export function bunkEvmV3IntentDigest(input: BunkEvmV3Config, value: BunkEvmV3Certificate): Hex {
  const config = bunkEvmV3Config(input),
    c = bunkEvmV3Certificate(value);
  if (c.entryPoint !== config.entryPoint.address)
    throw new Error('Bunk intent EntryPoint mismatch');
  return hashTypedData({
    domain: {
      name: 'HoneyBunkOwner',
      version: '3',
      chainId: BigInt(config.chainId),
      verifyingContract: config.module.address,
    },
    primaryType: 'BunkOwnerIntent',
    types: { BunkOwnerIntent: BUNK_EVM_V3_CERTIFICATE_FIELDS },
    message: c,
  });
}
export function bunkEvmV3RecoveryFee(value: BunkEvmV3Certificate): bigint {
  const c = bunkEvmV3Certificate(value);
  const fee =
    c.maxGasCost /
    (BigInt(slice(c.accountGasLimits, 0, 16)) +
      BigInt(slice(c.accountGasLimits, 16)) +
      c.preVerificationGas);
  if (fee === 0n || fee >= 1n << 120n)
    throw new Error('Bunk recovery fee is outside supported bounds');
  return fee;
}
/** v1's shared EntryPoint packing is identical except for v3's larger authorization. */
export function packBunkEvmV3Operation(op: BunkEvmOperation) {
  const packed = packBunkEvmOperation(op);
  const pad = (n: number) => Math.ceil(n / 32) * 32;
  if (
    448 +
      pad(size(packed.initCode)) +
      pad(size(packed.callData)) +
      pad(size(packed.paymasterAndData)) +
      1120 >
    8192
  )
    throw new Error('Bunk v3 operation exceeds 8 KiB');
  if (
    packed.paymasterAndData !== '0x' &&
    BigInt(slice(packed.paymasterAndData, 20, 36)) !== 200000n
  )
    throw new Error('Bunk v3 requires 200000 paymaster verification gas');
  bunkEvmUint(packed.nonce, 64);
  return packed;
}
export function encodeBunkEvmV3Authorization(
  intent: BunkEvmV3Intent,
  attempt: number,
  proof: readonly Hex[],
  envelopeSignature: Hex,
): Hex {
  if (intent.protocolVersion !== 3 || proof.length !== 8)
    throw new Error('Invalid Bunk v3 authorization');
  return encodeAbiParameters(authorizationAbi, [
    {
      certificate: bunkEvmV3Certificate(intent.certificate),
      attempt: bunkEvmV3Attempt(attempt),
      proof: proof.map((p) => bunkEvmHex(p, 32)),
      ownerSignature: bunkEvmHex(intent.ownerSignature, 65),
      envelopeSignature: bunkEvmHex(envelopeSignature, 65),
    },
  ]);
}

/** Spending/recovery key scope also binds the factory identity and proxy code,
 * which the factory's own configHash intentionally omits. Never use a new scope
 * with previously derived keys. Network ID is separately encoded in the path. */
export function bunkEvmV3KeyScope(input: BunkEvmV3Config): Hex {
  const c = bunkEvmV3Config(input);
  return keccak256(
    encodeAbiParameters(parseAbiParameters('string,address,bytes32,bytes32,bytes32'), [
      'HoneyBunkKeysV3',
      c.factory.address,
      c.factory.codeHash,
      bunkEvmConfigHash(c),
      keccak256(c.proxyCreationCode),
    ]),
  );
}
export function encodeBunkEvmV3Deployment(
  identity: Address,
  accountIndex: number,
  commitment: Hex,
  recoveryCommitment: Hex,
  signature: Hex,
): Hex {
  const owner = bunkEvmHex(commitment, 32),
    recovery = bunkEvmHex(recoveryCommitment, 32);
  if (owner === zeroHash || recovery === zeroHash || owner === recovery)
    throw new Error('Invalid initial commitments');
  return encodeFunctionData({
    abi: parseAbi([
      'function deploy(address identity,uint32 accountIndex,bytes32 commitment,bytes32 recoveryCommitment,bytes signature)',
    ]),
    functionName: 'deploy',
    args: [
      bunkEvmAddress(identity),
      bunkEvmIndex(accountIndex),
      owner,
      recovery,
      bunkEvmHex(signature, 65),
    ],
  });
}
export interface BunkEvmV3SeedRecovery {
  protocolVersion: 3;
  account: Address;
  epoch: number;
  nextOwnerCommitment: Hex;
  nextRecoveryCommitment: Hex;
}
function checkedRecovery(value: BunkEvmV3SeedRecovery): BunkEvmV3SeedRecovery {
  if (value.protocolVersion !== 3) throw new Error('Expected Bunk protocol version 3');
  const epoch = bunkEvmIndex(value.epoch),
    nextOwnerCommitment = bunkEvmHex(value.nextOwnerCommitment, 32),
    nextRecoveryCommitment = bunkEvmHex(value.nextRecoveryCommitment, 32);
  if (
    epoch === BUNK_MAX_INDEX ||
    nextOwnerCommitment === zeroHash ||
    nextRecoveryCommitment === zeroHash ||
    nextOwnerCommitment === nextRecoveryCommitment
  )
    throw new Error('Invalid Bunk seed recovery');
  return {
    protocolVersion: 3,
    account: bunkEvmAddress(value.account),
    epoch,
    nextOwnerCommitment,
    nextRecoveryCommitment,
  };
}
export function bunkEvmV3SeedRecoveryDigest(
  input: BunkEvmV3Config,
  value: BunkEvmV3SeedRecovery,
): Hex {
  const c = bunkEvmV3Config(input),
    recovery = checkedRecovery(value);
  return hashTypedData({
    domain: {
      name: 'HoneyBunkOwner',
      version: '3',
      chainId: BigInt(c.chainId),
      verifyingContract: c.module.address,
    },
    primaryType: 'BunkSeedRecovery',
    types: {
      BunkSeedRecovery: [
        { name: 'entryPoint', type: 'address' },
        { name: 'account', type: 'address' },
        { name: 'epoch', type: 'uint32' },
        { name: 'nextOwnerCommitment', type: 'bytes32' },
        { name: 'nextRecoveryCommitment', type: 'bytes32' },
      ],
    },
    message: {
      entryPoint: c.entryPoint.address,
      account: recovery.account,
      epoch: recovery.epoch,
      nextOwnerCommitment: recovery.nextOwnerCommitment,
      nextRecoveryCommitment: recovery.nextRecoveryCommitment,
    },
  });
}
export function encodeBunkEvmV3SeedRecovery(value: BunkEvmV3SeedRecovery, signature: Hex): Hex {
  const r = checkedRecovery(value);
  return encodeFunctionData({
    abi: parseAbi([
      'function recoverFromSeed(address account,uint32 epoch,bytes32 nextOwnerCommitment,bytes32 nextRecoveryCommitment,bytes signature)',
    ]),
    functionName: 'recoverFromSeed',
    args: [
      r.account,
      r.epoch,
      r.nextOwnerCommitment,
      r.nextRecoveryCommitment,
      bunkEvmHex(signature, 65),
    ],
  });
}
