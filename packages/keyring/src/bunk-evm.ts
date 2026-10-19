import {
  type Address,
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  hashTypedData,
  hexToBigInt,
  keccak256,
  parseAbi,
  parseAbiParameters,
  size,
  slice,
  toFunctionSelector,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem';
import { BUNK_MAX_INDEX, bunkOwnerPath } from './bunk';

export interface BunkEvmCodeIdentity {
  address: Address;
  codeHash: Hex;
}
/** Trusted deployment registry input. Hashes must be checked against chain code before signing. */
export interface BunkEvmConfig {
  chainId: string;
  factory: BunkEvmCodeIdentity;
  singleton: BunkEvmCodeIdentity;
  proxyFactory: BunkEvmCodeIdentity;
  entryPoint: BunkEvmCodeIdentity;
  module: BunkEvmCodeIdentity;
  helper: BunkEvmCodeIdentity;
  proxyCreationCode: Hex;
}
export interface BunkEvmCall {
  target: Address;
  value: bigint;
  data: Hex;
}
/** EntryPoint 0.7 operation, before the rotating owner's signature. */
export interface BunkEvmOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  paymasterAndData: Hex;
}
export interface BunkEvmValidity {
  validAfter: number;
  validUntil: number;
}
export interface BunkEvmAuthorization extends BunkEvmValidity {
  ownerIndex: number;
  nextCommitment: Hex;
  signature: Hex;
}
export interface BunkEvmSponsorship extends BunkEvmValidity {
  maxCost: bigint;
  nonce: bigint;
  epoch: bigint;
  signature: Hex;
}
const callsAbi = parseAbiParameters('(address target,uint256 value,bytes data)[]');
const authorizationAbi = parseAbiParameters(
  '(uint32 ownerIndex,bytes32 nextCommitment,uint48 validAfter,uint48 validUntil,bytes signature)',
);
const sponsorshipAbi = parseAbiParameters(
  '(uint48 validAfter,uint48 validUntil,uint128 maxCost,uint256 nonce,uint64 epoch,bytes signature)',
);
const deploymentAbi = parseAbi([
  'function deploy(address identity,uint32 accountIndex,bytes32 commitment,bytes signature) returns (address)',
]);
const executeSelector = toFunctionSelector(
  'executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)',
);

export function bunkEvmHex(value: Hex, bytes?: number): Hex {
  if (
    typeof value !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
    (bytes !== undefined && size(value) !== bytes)
  )
    throw new Error('Invalid Bunk hex encoding');
  return value.toLowerCase() as Hex;
}
export function bunkEvmAddress(value: Address): Address {
  bunkEvmHex(value, 20);
  if (value.toLowerCase() === zeroAddress) throw new Error('Zero Bunk address');
  return getAddress(value);
}
export function bunkEvmUint(value: bigint, bits: number): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(bits))
    throw new Error(`Bunk value exceeds uint${bits}`);
  return value;
}
export function bunkEvmIndex(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > BUNK_MAX_INDEX)
    throw new Error('Invalid Bunk account/owner index');
  return value;
}
export function bunkEvmValidity(value: BunkEvmValidity): BunkEvmValidity {
  const { validAfter, validUntil } = value;
  if (
    ![validAfter, validUntil].every((n) => Number.isSafeInteger(n) && n >= 0 && n < 2 ** 48) ||
    validUntil <= validAfter ||
    validUntil - validAfter > 3600
  )
    throw new Error('Bunk validity must be positive and at most one hour');
  return { validAfter, validUntil };
}
export function bunkEvmConfig(config: BunkEvmConfig): BunkEvmConfig {
  // Reuse the frozen network parser; never coerce an unsafe number into a chain ID.
  bunkOwnerPath({
    network: { family: 'evm', chainId: config.chainId },
    accountIndex: 0,
    ownerIndex: 0,
  });
  const identity = (value: BunkEvmCodeIdentity) => {
    const address = bunkEvmAddress(value.address),
      codeHash = bunkEvmHex(value.codeHash, 32);
    if (codeHash === zeroHash || codeHash === keccak256('0x'))
      throw new Error('Missing Bunk code identity');
    return { address, codeHash };
  };
  const out = {
    chainId: config.chainId,
    factory: identity(config.factory),
    singleton: identity(config.singleton),
    proxyFactory: identity(config.proxyFactory),
    entryPoint: identity(config.entryPoint),
    module: identity(config.module),
    helper: identity(config.helper),
    proxyCreationCode: bunkEvmHex(config.proxyCreationCode),
  };
  if (size(out.proxyCreationCode) === 0 || size(out.proxyCreationCode) > 24576)
    throw new Error('Invalid Safe proxy creation code');
  if (
    new Set(
      [out.factory, out.singleton, out.proxyFactory, out.entryPoint, out.module, out.helper].map(
        (x) => x.address.toLowerCase(),
      ),
    ).size !== 6
  )
    throw new Error('Bunk dependency addresses must be distinct');
  return out;
}
export function bunkEvmConfigHash(input: BunkEvmConfig): Hex {
  const c = bunkEvmConfig(input);
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'address,bytes32,address,bytes32,address,bytes32,address,bytes32,address,bytes32',
      ),
      [
        c.singleton.address,
        c.singleton.codeHash,
        c.proxyFactory.address,
        c.proxyFactory.codeHash,
        c.entryPoint.address,
        c.entryPoint.codeHash,
        c.module.address,
        c.module.codeHash,
        c.helper.address,
        c.helper.codeHash,
      ],
    ),
  );
}
export function bunkEvmInitializer(input: BunkEvmConfig): Hex {
  const c = bunkEvmConfig(input);
  return encodeFunctionData({
    abi: parseAbi([
      'function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)',
    ]),
    functionName: 'setup',
    args: [
      [c.module.address],
      1n,
      c.helper.address,
      toFunctionSelector('setup()'),
      c.module.address,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });
}
export function predictBunkEvmAccount(
  input: BunkEvmConfig,
  identity: Address,
  accountIndex: number,
): Address {
  const c = bunkEvmConfig(input);
  const saltNonce = keccak256(
    encodeAbiParameters(parseAbiParameters('string,address,uint32'), [
      'HoneyBunkAccountV1',
      bunkEvmAddress(identity),
      bunkEvmIndex(accountIndex),
    ]),
  );
  const salt = keccak256(concatHex([keccak256(bunkEvmInitializer(c)), saltNonce]));
  const initHash = keccak256(
    concatHex([c.proxyCreationCode, toHex(BigInt(c.singleton.address), { size: 32 })]),
  );
  return getAddress(
    slice(keccak256(concatHex(['0xff', c.proxyFactory.address, salt, initHash])), 12),
  );
}
export function bunkEvmDeploymentDigest(
  input: BunkEvmConfig,
  identity: Address,
  accountIndex: number,
  commitment: Hex,
): Hex {
  const c = bunkEvmConfig(input);
  const hash = bunkEvmHex(commitment, 32);
  if (hash === zeroHash) throw new Error('Empty initial commitment');
  return hashTypedData({
    domain: {
      name: 'HoneyBunkDeployment',
      version: '1',
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
        { name: 'configHash', type: 'bytes32' },
      ],
    },
    message: {
      identity: bunkEvmAddress(identity),
      accountIndex: bunkEvmIndex(accountIndex),
      account: predictBunkEvmAccount(c, identity, accountIndex),
      commitment: hash,
      configHash: bunkEvmConfigHash(c),
    },
  });
}
export function encodeBunkEvmDeployment(
  identity: Address,
  accountIndex: number,
  commitment: Hex,
  signature: Hex,
): Hex {
  return encodeFunctionData({
    abi: deploymentAbi,
    functionName: 'deploy',
    args: [
      bunkEvmAddress(identity),
      bunkEvmIndex(accountIndex),
      bunkEvmHex(commitment, 32),
      bunkEvmHex(signature, 65),
    ],
  });
}
export function encodeBunkEvmCalls(
  input: BunkEvmConfig,
  account: Address,
  calls: readonly BunkEvmCall[],
): Hex {
  const c = bunkEvmConfig(input);
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 16)
    throw new Error('Bunk requires 1 to 16 calls');
  const forbidden = new Set(
    [
      zeroAddress,
      bunkEvmAddress(account),
      c.module.address,
      c.factory.address,
      c.entryPoint.address,
    ].map((x) => x.toLowerCase()),
  );
  const values = calls.map((call) => {
    const target = bunkEvmAddress(call.target);
    if (forbidden.has(target.toLowerCase()))
      throw new Error('Forbidden Bunk administration target');
    const data = bunkEvmHex(call.data);
    if (size(data) > 6144) throw new Error('Bunk call data too large');
    return { target, value: bunkEvmUint(call.value, 256), data };
  });
  const encoded = concatHex([executeSelector, encodeAbiParameters(callsAbi, [values])]);
  if (size(encoded) > 6144) throw new Error('Bunk call data too large');
  return encoded;
}
/** Strict canonical decoding prevents a review/encoding disagreement or appended payload. */
export function decodeBunkEvmCalls(
  c: BunkEvmConfig,
  account: Address,
  data: Hex,
): readonly BunkEvmCall[] {
  const encoded = bunkEvmHex(data);
  if (size(encoded) < 4 || size(encoded) > 6144 || slice(encoded, 0, 4) !== executeSelector)
    throw new Error('Invalid Bunk call selector/length');
  const [calls] = decodeAbiParameters(callsAbi, slice(encoded, 4));
  if (encodeBunkEvmCalls(c, account, calls) !== encoded) throw new Error('Noncanonical Bunk calls');
  return calls;
}
export function packBunkEvmOperation(op: BunkEvmOperation) {
  const sender = bunkEvmAddress(op.sender),
    initCode = bunkEvmHex(op.initCode),
    callData = bunkEvmHex(op.callData),
    paymasterAndData = bunkEvmHex(op.paymasterAndData);
  if (size(initCode) > 1024 || size(callData) > 6144 || ![0, 404].includes(size(paymasterAndData)))
    throw new Error('Invalid Bunk operation field length');
  for (const value of [
    op.verificationGasLimit,
    op.callGasLimit,
    op.preVerificationGas,
    op.maxPriorityFeePerGas,
    op.maxFeePerGas,
  ])
    bunkEvmUint(value, 120);
  if (
    op.verificationGasLimit === 0n ||
    op.verificationGasLimit > 500000n ||
    op.callGasLimit === 0n ||
    op.preVerificationGas === 0n ||
    op.maxFeePerGas === 0n ||
    op.maxPriorityFeePerGas > op.maxFeePerGas
  )
    throw new Error('Invalid Bunk gas limits/fees');
  if (size(paymasterAndData) !== 0) {
    bunkEvmAddress(slice(paymasterAndData, 0, 20));
    const verification = hexToBigInt(slice(paymasterAndData, 20, 36));
    if (
      verification === 0n ||
      verification > 500000n ||
      hexToBigInt(slice(paymasterAndData, 36, 52)) !== 0n
    )
      throw new Error('Invalid Honey paymaster gas limits');
  }
  const packed = {
    sender,
    nonce: bunkEvmUint(op.nonce, 256),
    initCode,
    callData,
    accountGasLimits: concatHex([
      toHex(op.verificationGasLimit, { size: 16 }),
      toHex(op.callGasLimit, { size: 16 }),
    ]),
    preVerificationGas: op.preVerificationGas,
    gasFees: concatHex([
      toHex(op.maxPriorityFeePerGas, { size: 16 }),
      toHex(op.maxFeePerGas, { size: 16 }),
    ]),
    paymasterAndData,
  };
  // The final ABI-encoded PackedUserOperation includes the 320-byte owner authorization.
  const encoded = encodeAbiParameters(
    parseAbiParameters('(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)'),
    [
      [
        packed.sender,
        packed.nonce,
        packed.initCode,
        packed.callData,
        packed.accountGasLimits,
        packed.preVerificationGas,
        packed.gasFees,
        packed.paymasterAndData,
        toHex(new Uint8Array(320)),
      ],
    ],
  );
  if (size(encoded) > 8192) throw new Error('Bunk operation exceeds 8 KiB');
  return packed;
}
export function bunkEvmUserOpHash(input: BunkEvmConfig, op: BunkEvmOperation): Hex {
  const c = bunkEvmConfig(input),
    p = packBunkEvmOperation(op);
  const hash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('address,uint256,bytes32,bytes32,bytes32,uint256,bytes32,bytes32'),
      [
        p.sender,
        p.nonce,
        keccak256(p.initCode),
        keccak256(p.callData),
        p.accountGasLimits,
        p.preVerificationGas,
        p.gasFees,
        keccak256(p.paymasterAndData),
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32,address,uint256'), [
      hash,
      c.entryPoint.address,
      BigInt(c.chainId),
    ]),
  );
}
export function bunkEvmOwnerDigest(
  input: BunkEvmConfig,
  op: BunkEvmOperation,
  auth: Omit<BunkEvmAuthorization, 'signature'>,
): Hex {
  const c = bunkEvmConfig(input),
    validity = bunkEvmValidity(auth),
    next = bunkEvmHex(auth.nextCommitment, 32);
  if (next === zeroHash || bunkEvmIndex(auth.ownerIndex) === BUNK_MAX_INDEX)
    throw new Error('Invalid next Bunk owner');
  return hashTypedData({
    domain: {
      name: 'HoneyBunkOwner',
      version: '1',
      chainId: BigInt(c.chainId),
      verifyingContract: c.module.address,
    },
    primaryType: 'BunkOwnerOperation',
    types: {
      BunkOwnerOperation: [
        { name: 'userOpHash', type: 'bytes32' },
        { name: 'ownerIndex', type: 'uint32' },
        { name: 'nextCommitment', type: 'bytes32' },
        { name: 'validAfter', type: 'uint48' },
        { name: 'validUntil', type: 'uint48' },
      ],
    },
    message: {
      userOpHash: bunkEvmUserOpHash(c, op),
      ownerIndex: auth.ownerIndex,
      nextCommitment: next,
      ...validity,
    },
  });
}
export function encodeBunkEvmAuthorization(auth: BunkEvmAuthorization): Hex {
  return encodeAbiParameters(authorizationAbi, [
    {
      ownerIndex: bunkEvmIndex(auth.ownerIndex),
      nextCommitment: bunkEvmHex(auth.nextCommitment, 32),
      ...bunkEvmValidity(auth),
      signature: bunkEvmHex(auth.signature, 65),
    },
  ]);
}
export function decodeBunkEvmSponsorship(data: Hex): BunkEvmSponsorship {
  const encoded = bunkEvmHex(data, 404);
  const [grant] = decodeAbiParameters(sponsorshipAbi, slice(encoded, 52));
  bunkEvmValidity(grant);
  bunkEvmHex(grant.signature, 65);
  if (encodeAbiParameters(sponsorshipAbi, [grant]) !== slice(encoded, 52))
    throw new Error('Noncanonical Bunk sponsor grant');
  return grant;
}
export function bunkEvmSponsorshipDigest(
  input: BunkEvmConfig,
  op: BunkEvmOperation,
  grant: BunkEvmSponsorship,
): Hex {
  const c = bunkEvmConfig(input),
    p = packBunkEvmOperation(op);
  if (size(p.paymasterAndData) !== 404) throw new Error('Missing Honey sponsorship');
  const operationHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('address,address,uint256,bytes32,bytes32,bytes32,uint256,bytes32,bytes32'),
      [
        c.entryPoint.address,
        p.sender,
        p.nonce,
        keccak256(p.initCode),
        keccak256(p.callData),
        p.accountGasLimits,
        p.preVerificationGas,
        p.gasFees,
        keccak256(slice(p.paymasterAndData, 0, 52)),
      ],
    ),
  );
  return hashTypedData({
    domain: {
      name: 'HoneyBunkSponsorship',
      version: '1',
      chainId: BigInt(c.chainId),
      verifyingContract: bunkEvmAddress(slice(p.paymasterAndData, 0, 20)),
    },
    primaryType: 'BunkSponsorship',
    types: {
      BunkSponsorship: [
        { name: 'operationHash', type: 'bytes32' },
        { name: 'validAfter', type: 'uint48' },
        { name: 'validUntil', type: 'uint48' },
        { name: 'maxCost', type: 'uint128' },
        { name: 'nonce', type: 'uint256' },
        { name: 'epoch', type: 'uint64' },
      ],
    },
    message: {
      operationHash,
      ...bunkEvmValidity(grant),
      maxCost: bunkEvmUint(grant.maxCost, 128),
      nonce: bunkEvmUint(grant.nonce, 256),
      epoch: bunkEvmUint(grant.epoch, 64),
    },
  });
}
