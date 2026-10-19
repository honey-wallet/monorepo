import {
  type Address,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  parseAbi,
  parseAbiParameters,
  recoverAddress,
  size,
  slice,
  toHex,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveBunkOwner } from './bunk';
import { type BunkEvmOperation, bunkEvmSponsorshipDigest, predictBunkEvmAccount } from './bunk-evm';
import { deriveBunkEvmDeploymentIdentity } from './bunk-evm-sign';
import { deriveBunkEvmV2DeploymentIdentity, deriveBunkEvmV2Owner } from './bunk-evm-v2-sign';
import {
  type BunkEvmV3Certificate,
  type BunkEvmV3Config,
  bunkEvmV3Config,
  bunkEvmV3IntentDigest,
  bunkEvmV3KeyScope,
  bunkEvmV3RecoveryCalls,
  bunkEvmV3RecoveryFee,
  bunkEvmV3SeedRecoveryDigest,
  bunkEvmV3Tree,
  decodeBunkEvmV3Calls,
  encodeBunkEvmV3Calls,
  packBunkEvmV3Operation,
} from './bunk-evm-v3';
import {
  bunkEvmV3EnvelopePath,
  bunkEvmV3OwnerPath,
  deriveBunkEvmV3DeploymentIdentity,
  deriveBunkEvmV3Envelopes,
  deriveBunkEvmV3Owner,
  deriveBunkEvmV3Recovery,
  signBunkEvmV3Deployment,
  signBunkEvmV3Envelope,
  signBunkEvmV3Intent,
  signBunkEvmV3SeedRecovery,
} from './bunk-evm-v3-sign';
import fixture from './fixtures/bunk-evm-v3.json';
import { mnemonicToSeed } from './index';

let seed: Uint8Array;
const trees = new Map<number, ReturnType<typeof deriveBunkEvmV3Envelopes>>();
function proofFor(index: number, attempt: number): readonly Hex[] {
  let tree = trees.get(index);
  if (!tree) {
    tree = deriveBunkEvmV3Envelopes(seed, ref(vectorAt(index)));
    trees.set(index, tree);
  }
  const proof = tree.proofs[attempt];
  if (!proof) throw new Error('Missing test proof');
  return proof;
}
beforeAll(async () => {
  seed = await mnemonicToSeed(fixture.phrase);
});
function vectorAt(index: number) {
  const v = fixture.vectors[index];
  if (!v) throw new Error('Missing vector');
  return v;
}
const config = (chainId = '1'): BunkEvmV3Config =>
  ({ ...fixture.config, protocolVersion: 3, chainId }) as BunkEvmV3Config;
const ref = (v = vectorAt(0)) => ({
  chainId: v.chainId,
  keyScope: v.keyScope as Hex,
  epoch: v.epoch,
  accountIndex: v.accountIndex,
  ownerIndex: v.ownerIndex,
});
const operation = (v = vectorAt(0)): BunkEvmOperation =>
  ({
    ...v.operation,
    nonce: BigInt(v.operation.nonce),
    verificationGasLimit: BigInt(v.operation.verificationGasLimit),
    callGasLimit: BigInt(v.operation.callGasLimit),
    preVerificationGas: BigInt(v.operation.preVerificationGas),
    maxPriorityFeePerGas: BigInt(v.operation.maxPriorityFeePerGas),
    maxFeePerGas: BigInt(v.operation.maxFeePerGas),
  }) as BunkEvmOperation;
function request(index = 0) {
  const v = fixture.vectors[index];
  if (!v) throw new Error('Missing vector');
  const certificate: BunkEvmV3Certificate = {
    ...v.certificate,
    nonce: BigInt(v.certificate.nonce),
    preVerificationGas: BigInt(v.certificate.preVerificationGas),
    maxGasCost: BigInt(v.certificate.maxGasCost),
  } as BunkEvmV3Certificate;
  return {
    config: config(v.chainId),
    state: {
      protocolVersion: 3 as const,
      deployed: v.epoch !== 0 || v.ownerIndex !== 0,
      account: v.account as Address,
      accountIndex: v.accountIndex,
      ownerIndex: v.ownerIndex,
      commitment: v.owner.commitment as Hex,
      nonce: BigInt(v.nonce),
      epoch: v.epoch,
      recoveryCommitment: v.recoveryKey.commitment as Hex,
    },
    intent: { protocolVersion: 3 as const, certificate, ownerSignature: v.ownerSignature as Hex },
    operation: operation(v),
    attempt: v.attempt,
    proof: proofFor(index, v.attempt),
    purpose: v.attempt === 255 ? ('cleanup' as const) : ('action' as const),
    now: v.attempt === 255 ? 2001 : 1100,
  };
}
function intentRequest(index = 0) {
  const r = request(index),
    c = r.intent.certificate;
  return {
    config: r.config,
    state: r.state,
    callData: vectorAt(index).callData as Hex,
    verificationGasLimit: r.operation.verificationGasLimit,
    callGasLimit: r.operation.callGasLimit,
    preVerificationGas: c.preVerificationGas,
    maximumGasCost: c.maxGasCost,
    paymaster: c.paymaster,
    validAfter: c.validAfter,
    executeUntil: c.executeUntil,
  };
}

describe('Independent v3 BIP32 / ABI / EIP-712 / Merkle / exact-signature vectors', {
  timeout: 15000,
}, () => {
  for (const [index, v] of fixture.vectors.entries()) {
    it(`matches chain ${v.chainId}, account ${v.accountIndex}, owner ${v.ownerIndex}, leaf ${v.attempt}`, async () => {
      const r = request(index),
        owner = deriveBunkEvmV3Owner(seed, ref(v));
      expect(owner.path).toBe(v.owner.path);
      expect(owner.publicKey).toBe(v.owner.publicKey);
      expect(owner.address.toLowerCase()).toBe(v.owner.address);
      expect(owner.commitment).toBe(v.owner.commitment);
      const deployment = signBunkEvmV3Deployment(seed, r.config, v.accountIndex);
      expect(deployment.account.toLowerCase()).toBe(v.account);
      expect(deployment.identity.path).toBe(v.identity.path);
      expect(deployment.identity.publicKey).toBe(v.identity.publicKey);
      expect(deployment.digest).toBe(v.deploymentDigest);
      expect(deployment.signature).toBe(v.deploymentSignature);
      expect(deployment.factoryData).toBe(v.factoryData);
      expect(deployment.firstRecovery.commitment).toBe(v.firstRecovery.commitment);
      expect(bunkEvmV3KeyScope(r.config)).toBe(v.keyScope);
      const recovered = signBunkEvmV3SeedRecovery(seed, r.config, r.state);
      expect(recovered.currentRecovery.publicKey).toBe(v.recoveryKey.publicKey);
      expect(recovered.currentRecovery.path).toBe(v.recoveryKey.path);
      expect(recovered.nextOwner.commitment).toBe(v.resetOwner.commitment);
      expect(recovered.nextOwner.path).toBe(v.resetOwner.path);
      expect(recovered.nextRecovery.commitment).toBe(v.nextRecovery.commitment);
      expect(recovered.digest).toBe(v.recoveryDigest);
      expect(recovered.signature).toBe(v.recoverySignature);
      expect(recovered.transaction.data).toBe(v.recoveryData);
      expect(recovered.transaction.to).toBe(r.config.module.address);
      expect(recovered.transaction.value).toBe(0n);
      const tree = deriveBunkEvmV3Envelopes(seed, ref(v));
      expect(tree.signers.map((s) => s.address.toLowerCase())).toEqual(v.envelopeAddresses);
      expect(tree.signers[v.attempt]?.path).toBe(v.envelope.path);
      expect(tree.signers[v.attempt]?.publicKey).toBe(v.envelope.publicKey);
      expect(tree.root).toBe(v.certificate.envelopeRoot);
      expect(tree.proofs[v.attempt]).toEqual(v.proof);
      const signed = signBunkEvmV3Intent(seed, intentRequest(index));
      expect(signed.digest).toBe(v.intentDigest);
      expect(signed.intent.ownerSignature).toBe(v.ownerSignature);
      expect(signed.nextOwner.commitment).toBe(v.successor.commitment);
      const envelope = signBunkEvmV3Envelope(seed, { ...r, intent: signed.intent });
      expect(envelope.userOpHash).toBe(v.userOpHash);
      expect(envelope.operation.signature).toBe(v.authorization);
      expect(size(envelope.operation.signature)).toBe(1120);
      expect(
        (
          await recoverAddress({ hash: envelope.userOpHash, signature: v.envelopeSignature as Hex })
        ).toLowerCase(),
      ).toBe(v.envelope.address);
    });
  }
  it('separates all v1, v3 owner, envelope and deployment branches', () => {
    const seedBefore = seed.slice();
    const v = vectorAt(0),
      r = ref(v);
    const owner = deriveBunkEvmV3Owner(seed, r),
      identity = deriveBunkEvmV3DeploymentIdentity(seed, 0),
      tree = deriveBunkEvmV3Envelopes(seed, r);
    const old = deriveBunkOwner(seed, {
      network: { family: 'evm', chainId: '1' },
      accountIndex: 0,
      ownerIndex: 0,
    });
    expect(
      new Set([
        owner.address,
        identity.address,
        ...tree.signers.map((x) => x.address),
        old.ownerAddress,
        deriveBunkEvmDeploymentIdentity(seed, 0).address,
      ]).size,
    ).toBe(260);
    expect(owner.path).toMatch(/^m\/7744'\/3'\/0'\/60'/);
    expect(tree.signers[0]?.path).toMatch(/^m\/7744'\/3'\/1'\/60'/);
    expect(predictBunkEvmAccount(config(), identity.address, 0)).not.toBe(request().state.account);
    expect(seed).toEqual(seedBefore);
  });
  it('uses the full chain identity and rejects malformed indices/networks', () => {
    expect(bunkEvmV3OwnerPath({ ...ref(), chainId: (2n ** 255n + 1n).toString() })).not.toBe(
      bunkEvmV3OwnerPath({ ...ref(), chainId: '1' }),
    );
    for (const value of [-1, 256, 0.5, NaN])
      expect(() => bunkEvmV3EnvelopePath(ref(), value)).toThrow();
    for (const chainId of ['0', '01', '-1', (2n ** 256n).toString()])
      expect(() => bunkEvmV3OwnerPath({ ...ref(), chainId })).toThrow();
    expect(() => deriveBunkEvmV3Owner(new Uint8Array(32), ref())).toThrow();
    expect(() => bunkEvmV3OwnerPath({ ...ref(), accountIndex: 2147483648 })).toThrow();
  });
});

describe('One-time owner intent and scoped retries', { timeout: 20000 }, () => {
  it('retries with a new envelope signature and the same owner certificate', () => {
    const r = request(1),
      before = structuredClone(r.intent);
    const first = signBunkEvmV3Envelope(seed, { ...r, attempt: 0, proof: proofFor(1, 0) });
    const second = signBunkEvmV3Envelope(seed, {
      ...r,
      attempt: 1,
      proof: proofFor(1, 1),
      operation: { ...r.operation, maxFeePerGas: 3000000000n },
    });
    expect(first.userOpHash).not.toBe(second.userOpHash);
    expect(first.digest).toBe(second.digest);
    expect(r.intent).toEqual(before);
    expect(signBunkEvmV3Envelope(seed, { ...r, attempt: 0, proof: proofFor(1, 0) })).toEqual(first);
  });
  it.each([
    'account',
    'commitment',
    'nonce',
    'ownerIndex',
    'accountIndex',
    'protocolVersion',
  ] as const)('rejects wrong observed %s', (field) => {
    const r = request(1);
    const values = {
      account: fixture.config.factory.address,
      commitment: `0x${'11'.repeat(32)}`,
      nonce: 9n,
      ownerIndex: 4,
      accountIndex: 1,
      protocolVersion: 1,
    };
    expect(() =>
      signBunkEvmV3Envelope(seed, { ...r, state: { ...r.state, [field]: values[field] } }),
    ).toThrow();
  });
  it.each([
    'entryPoint',
    'account',
    'nonce',
    'callDataHash',
    'accountGasLimits',
    'preVerificationGas',
    'maxGasCost',
    'paymaster',
    'ownerIndex',
    'nextCommitment',
    'envelopeRoot',
    'validAfter',
    'executeUntil',
  ] as const)('rejects changed certificate %s', (field) => {
    const r = request(1),
      c = r.intent.certificate;
    const value = c[field];
    const replacement =
      typeof value === 'bigint'
        ? value + 1n
        : typeof value === 'number'
          ? value + 1
          : value.length === 42
            ? fixture.config.factory.address
            : `0x${'ab'.repeat(32)}`;
    expect(() =>
      signBunkEvmV3Envelope(seed, {
        ...r,
        intent: { ...r.intent, certificate: { ...c, [field]: replacement } },
      }),
    ).toThrow();
  });
  it('rejects wrong, altered, short and oversized envelope proofs', () => {
    const r = request(1);
    expect(() => signBunkEvmV3Envelope(seed, { ...r, attempt: 1 })).toThrow();
    for (const proof of [
      r.proof.slice(1),
      [...r.proof, r.proof[0] as Hex],
      [keccak256('0x11'), ...r.proof.slice(1)],
    ]) {
      expect(() => signBunkEvmV3Envelope(seed, { ...r, proof })).toThrow();
    }
  });
  it('rejects v1 config/state, wrong chain, malformed and high-S owner signatures', () => {
    const r = request(1);
    expect(() =>
      bunkEvmV3Config({ ...r.config, protocolVersion: 1 } as unknown as BunkEvmV3Config),
    ).toThrow();
    expect(() => signBunkEvmV3Envelope(seed, { ...r, config: config('1') })).toThrow();
    expect(() =>
      signBunkEvmV3Envelope(seed, { ...r, intent: { ...r.intent, ownerSignature: '0x' } }),
    ).toThrow();
    const sig = r.intent.ownerSignature,
      order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = concatHex([
      slice(sig, 0, 32),
      toHex(order - BigInt(slice(sig, 32, 64)), { size: 32 }),
      toHex(BigInt(slice(sig, 64)) === 27n ? 28 : 27, { size: 1 }),
    ]);
    expect(() =>
      signBunkEvmV3Envelope(seed, { ...r, intent: { ...r.intent, ownerSignature: high } }),
    ).toThrow();
  });
  it.each([
    'callData',
    'callGasLimit',
    'preVerificationGas',
    'nonce',
    'sender',
    'initCode',
  ] as const)('rejects changed operation %s', (field) => {
    const r = request(1),
      values = {
        callData: bunkEvmV3RecoveryCalls(),
        callGasLimit: 499999n,
        preVerificationGas: 99999n,
        nonce: 9n,
        sender: fixture.config.factory.address,
        initCode: '0x1234',
      };
    expect(() =>
      signBunkEvmV3Envelope(seed, { ...r, operation: { ...r.operation, [field]: values[field] } }),
    ).toThrow();
  });
  it('enforces the signed gas liability before emitting an envelope', () => {
    const r = request(1);
    expect(() =>
      signBunkEvmV3Envelope(seed, {
        ...r,
        operation: { ...r.operation, maxFeePerGas: 10000000001n },
      }),
    ).toThrow('gas cost');
  });
  it('rejects missing/foreign counterfactual data and nonzero undeployed state', () => {
    const r = request();
    expect(() =>
      signBunkEvmV3Envelope(seed, { ...r, operation: { ...r.operation, initCode: '0x' } }),
    ).toThrow('deployment data');
    expect(() =>
      signBunkEvmV3Envelope(seed, {
        ...r,
        operation: {
          ...r.operation,
          initCode: concatHex([
            fixture.config.module.address as Hex,
            slice(r.operation.initCode, 20),
          ]),
        },
      }),
    ).toThrow();
    expect(() => signBunkEvmV3Envelope(seed, { ...r, state: { ...r.state, nonce: 1n } })).toThrow(
      'Undeployed',
    );
  });
  it('does not allow implicit expired execution or early cleanup', () => {
    const r = request(1);
    expect(() => signBunkEvmV3Envelope(seed, { ...r, now: 2001 })).toThrow('time');
    expect(() => signBunkEvmV3Envelope(seed, { ...r, now: 2000, purpose: 'cleanup' })).toThrow(
      'time',
    );
    expect(() => signBunkEvmV3Envelope(seed, { ...r, now: 999 })).toThrow('time');
    expect(signBunkEvmV3Envelope(seed, { ...r, now: 2001, purpose: 'cleanup' }).purpose).toBe(
      'cleanup',
    );
  });
  it('reserved leaf 255 has fixed fees, no calls or initialization, and starts after expiry', () => {
    const r = request(2);
    expect(bunkEvmV3RecoveryFee(r.intent.certificate)).toBe(10000000000n);
    expect(signBunkEvmV3Envelope(seed, r).calls).toEqual([]);
    for (const operation of [
      { ...r.operation, maxFeePerGas: 10000000001n },
      { ...r.operation, maxPriorityFeePerGas: 1n },
      { ...r.operation, callData: vectorAt(2).callData as Hex },
      { ...r.operation, initCode: '0x12' as Hex },
    ])
      expect(() => signBunkEvmV3Envelope(seed, { ...r, operation })).toThrow();
    expect(() => signBunkEvmV3Envelope(seed, { ...r, purpose: 'action', now: 2000 })).toThrow(
      'reserved',
    );
    expect(() => signBunkEvmV3Intent(seed, { ...intentRequest(1), maximumGasCost: 1n })).toThrow(
      'recovery fee',
    );
    expect(() => signBunkEvmV3Intent(seed, { ...intentRequest(1), executeUntil: 5000 })).toThrow(
      'one hour',
    );
  });
});

describe('Canonical call and operation boundaries', () => {
  it('allows only canonical zero-value EntryPoint withdrawal back to this Safe', () => {
    const r = request(1),
      abi = parseAbi(['function withdrawTo(address,uint256)']);
    const data = encodeFunctionData({
      abi,
      functionName: 'withdrawTo',
      args: [r.state.account, 123n],
    });
    const call = { target: r.config.entryPoint.address, value: 0n, data };
    expect(
      decodeBunkEvmV3Calls(
        r.config,
        r.state.account,
        encodeBunkEvmV3Calls(r.config, r.state.account, [call]),
      )[0]?.data,
    ).toBe(data);
    for (const change of [
      { value: 1n },
      { data: concatHex([data, '0x00']) },
      { data: concatHex(['0x00000000', slice(data, 4)]) },
      {
        data: encodeFunctionData({
          abi,
          functionName: 'withdrawTo',
          args: [r.config.factory.address, 123n],
        }),
      },
      { data: concatHex([slice(data, 0, 4), '0x01', slice(data, 5)]) },
    ])
      expect(() =>
        encodeBunkEvmV3Calls(r.config, r.state.account, [{ ...call, ...change }]),
      ).toThrow();
  });
  it('rejects direct administration, empty ordinary calls and noncanonical bytes', () => {
    const r = request(1);
    for (const target of [
      r.state.account,
      r.config.module.address,
      r.config.factory.address,
      zeroAddress,
    ])
      expect(() =>
        encodeBunkEvmV3Calls(r.config, r.state.account, [{ target, value: 0n, data: '0x' }]),
      ).toThrow();
    expect(() => encodeBunkEvmV3Calls(r.config, r.state.account, [])).toThrow();
    expect(() =>
      decodeBunkEvmV3Calls(r.config, r.state.account, concatHex([r.operation.callData, '0x00'])),
    ).toThrow();
    expect(() => bunkEvmV3Tree(Array(256).fill(r.state.account))).toThrow('distinct');
  });
  it('counts the entire 1120-byte authorization in the 8 KiB operation bound', () => {
    const r = request();
    expect(() =>
      packBunkEvmV3Operation({
        ...r.operation,
        initCode: toHex(new Uint8Array(1024)),
        callData: toHex(new Uint8Array(6144)),
      }),
    ).toThrow('8 KiB');
    expect(() => packBunkEvmV3Operation({ ...r.operation, nonce: 1n << 64n })).toThrow('uint64');
  });
});

it('verifies renewed sponsorship independently, with self-funding limited by the same intent', async () => {
  const r = request(1),
    sponsorKey = privateKeyToAccount(toHex(4n, { size: 32 }));
  const paymaster = '0x8888888888888888888888888888888888888888' as Address;
  const signed = signBunkEvmV3Intent(seed, { ...intentRequest(1), paymaster });
  const grant = {
    validAfter: 1000,
    validUntil: 1200,
    maxCost: 5000000000000000n,
    nonce: 0n,
    epoch: 0n,
    signature: toHex(new Uint8Array(65)),
  };
  const encode = (g: typeof grant) =>
    concatHex([
      paymaster,
      toHex(200000n, { size: 16 }),
      toHex(0n, { size: 16 }),
      encodeAbiParameters(
        parseAbiParameters(
          '(uint48 validAfter,uint48 validUntil,uint128 maxCost,uint256 nonce,uint64 epoch,bytes signature)',
        ),
        [g],
      ),
    ]);
  let op = { ...r.operation, paymasterAndData: encode(grant) };
  grant.signature = await sponsorKey.sign({ hash: bunkEvmSponsorshipDigest(r.config, op, grant) });
  op = { ...op, paymasterAndData: encode(grant) };
  const sponsor = {
    paymaster: { address: paymaster, codeHash: keccak256('0x1234') },
    signer: sponsorKey.address,
    epoch: 0n,
    maxCostPerOperation: 5000000000000000n,
  };
  const sponsored = { ...r, intent: signed.intent, operation: op, sponsor };
  expect(signBunkEvmV3Envelope(seed, sponsored).maximumGasCost).toBe(2600000000000000n);
  expect(() => signBunkEvmV3Envelope(seed, { ...sponsored, now: 1201 })).toThrow('grant');
  expect(() =>
    signBunkEvmV3Envelope(seed, { ...sponsored, sponsor: { ...sponsor, epoch: 1n } }),
  ).toThrow('grant');
  expect(() =>
    signBunkEvmV3Envelope(seed, { ...sponsored, operation: { ...op, maxFeePerGas: 2100000000n } }),
  ).toThrow('signature');
  expect(() => signBunkEvmV3Envelope(seed, { ...sponsored, sponsor: undefined })).toThrow(
    'Missing',
  );
  expect(() =>
    signBunkEvmV3Envelope(seed, {
      ...sponsored,
      operation: {
        ...op,
        paymasterAndData: concatHex([
          paymaster,
          toHex(199999n, { size: 16 }),
          slice(op.paymasterAndData, 36),
        ]),
      },
    }),
  ).toThrow('200000');
  expect(
    signBunkEvmV3Envelope(seed, { ...r, intent: signed.intent, attempt: 1, proof: proofFor(1, 1) })
      .maximumGasCost,
  ).toBe(2200000000000000n);
  expect(bunkEvmV3IntentDigest(r.config, signed.intent.certificate)).toBe(signed.digest);
}, 20000);

describe('v3 generation and seed-only recovery boundaries', () => {
  it('preserves the same account across networks while separating all spending/recovery keys', () => {
    const first = signBunkEvmV3Deployment(seed, config('1'), 0);
    const second = signBunkEvmV3Deployment(seed, config('8453'), 0);
    expect(first.account).toBe(second.account);
    expect(first.identity.address).toBe(second.identity.address);
    expect(first.firstOwner.address).not.toBe(second.firstOwner.address);
    expect(first.firstRecovery.address).not.toBe(second.firstRecovery.address);
    const r = ref();
    expect(
      new Set([
        first.firstOwner.address,
        first.firstRecovery.address,
        first.identity.address,
        deriveBunkEvmV3Owner(seed, { ...r, epoch: 1 }).address,
        deriveBunkEvmV3Recovery(seed, { ...r, epoch: 1 }).address,
        deriveBunkEvmV2Owner(seed, { chainId: '1', accountIndex: 0, ownerIndex: 0 }).address,
        deriveBunkEvmV2DeploymentIdentity(seed, 0).address,
      ]).size,
    ).toBe(7);
  });
  it('binds every deployment identity to a different spending and recovery namespace', () => {
    const original = config(),
      originalScope = bunkEvmV3KeyScope(original);
    const alternatives: BunkEvmV3Config[] = [
      {
        ...original,
        factory: { ...original.factory, address: '0x9999999999999999999999999999999999999999' },
      },
      { ...original, factory: { ...original.factory, codeHash: keccak256('0xaaaa') } },
      { ...original, module: { ...original.module, codeHash: keccak256('0xbbbb') } },
      { ...original, proxyCreationCode: '0x60016000f3' },
    ];
    const keys = alternatives.map((c) => {
      const keyScope = bunkEvmV3KeyScope(c);
      expect(keyScope).not.toBe(originalScope);
      return deriveBunkEvmV3Recovery(seed, { ...ref(), keyScope }).address;
    });
    expect(new Set([...keys, deriveBunkEvmV3Recovery(seed, ref()).address]).size).toBe(5);
  });
  it('reconstructs only fixed successors independently of the lost owner/nonce/approval', () => {
    const r = request(2);
    const state = {
      protocolVersion: 3 as const,
      account: r.state.account,
      accountIndex: r.state.accountIndex,
      epoch: r.state.epoch,
      recoveryCommitment: r.state.recoveryCommitment,
    };
    const recovered = signBunkEvmV3SeedRecovery(seed, r.config, state);
    expect(signBunkEvmV3SeedRecovery(seed, r.config, state)).toEqual(recovered);
    expect(recovered.recovery.nextOwnerCommitment).toBe(
      deriveBunkEvmV3Owner(seed, { ...ref(vectorAt(2)), epoch: r.state.epoch + 1, ownerIndex: 0 })
        .commitment,
    );
    const changed = { ...recovered.recovery, nextOwnerCommitment: keccak256('0x33') };
    expect(bunkEvmV3SeedRecoveryDigest(r.config, changed)).not.toBe(recovered.digest);
    expect(signBunkEvmV3SeedRecovery(seed, r.config, state).signature).toBe(
      vectorAt(2).recoverySignature,
    );
  });
  it('rejects wrong recovery seed, account, commitment, epoch and version', () => {
    const r = request(2);
    for (const change of [
      { recoveryCommitment: keccak256('0x1234') },
      { account: r.config.factory.address },
      { epoch: r.state.epoch + 1 },
      { accountIndex: r.state.accountIndex + 1 },
      { protocolVersion: 2 },
    ])
      expect(() =>
        signBunkEvmV3SeedRecovery(seed, r.config, { ...r.state, ...change } as typeof r.state),
      ).toThrow();
    expect(() =>
      signBunkEvmV3SeedRecovery(new Uint8Array(64).fill(1), r.config, r.state),
    ).toThrow();
    expect(() => signBunkEvmV3SeedRecovery(seed, config(), r.state)).toThrow();
  });
  it('refuses generation/index overflow and zero or truncated scope without changing the seed', () => {
    const before = seed.slice();
    for (const value of [-1, 2 ** 31, NaN, 0.5])
      expect(() => bunkEvmV3OwnerPath({ ...ref(), epoch: value })).toThrow();
    for (const keyScope of ['0x', `0x${'00'.repeat(32)}`, `0x${'11'.repeat(31)}`])
      expect(() => bunkEvmV3OwnerPath({ ...ref(), keyScope: keyScope as Hex })).toThrow();
    const c = config(),
      epoch = 2 ** 31 - 1;
    const recoveryCommitment = deriveBunkEvmV3Recovery(seed, { ...ref(), epoch }).commitment;
    expect(() =>
      signBunkEvmV3SeedRecovery(seed, c, { ...request().state, epoch, recoveryCommitment }),
    ).toThrow();
    expect(seed).toEqual(before);
  });
  it('rejects ordinary signing under the wrong epoch or recovery commitment', () => {
    const r = request(2);
    for (const state of [
      { ...r.state, epoch: 0 },
      { ...r.state, recoveryCommitment: vectorAt(0).recoveryKey.commitment as Hex },
    ])
      expect(() => signBunkEvmV3Envelope(seed, { ...r, state })).toThrow();
    const original = request();
    expect(() =>
      signBunkEvmV3Intent(seed, { ...intentRequest(), state: { ...original.state, epoch: 1 } }),
    ).toThrow('Undeployed');
  });
});
