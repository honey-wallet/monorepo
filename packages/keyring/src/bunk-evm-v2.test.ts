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
import {
  type BunkEvmV2Certificate,
  type BunkEvmV2Config,
  bunkEvmV2Config,
  bunkEvmV2IntentDigest,
  bunkEvmV2RecoveryCalls,
  bunkEvmV2RecoveryFee,
  bunkEvmV2Tree,
  decodeBunkEvmV2Calls,
  encodeBunkEvmV2Calls,
  packBunkEvmV2Operation,
} from './bunk-evm-v2';
import {
  bunkEvmV2EnvelopePath,
  bunkEvmV2OwnerPath,
  deriveBunkEvmV2DeploymentIdentity,
  deriveBunkEvmV2Envelopes,
  deriveBunkEvmV2Owner,
  signBunkEvmV2Deployment,
  signBunkEvmV2Envelope,
  signBunkEvmV2Intent,
} from './bunk-evm-v2-sign';
import fixture from './fixtures/bunk-evm-v2.json';
import { mnemonicToSeed } from './index';

let seed: Uint8Array;
const trees = new Map<number, ReturnType<typeof deriveBunkEvmV2Envelopes>>();
function proofFor(index: number, attempt: number): readonly Hex[] {
  let tree = trees.get(index);
  if (!tree) {
    tree = deriveBunkEvmV2Envelopes(seed, ref(vectorAt(index)));
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
const config = (chainId = '1'): BunkEvmV2Config =>
  ({ ...fixture.config, protocolVersion: 2, chainId }) as BunkEvmV2Config;
const ref = (v = vectorAt(0)) => ({
  chainId: v.chainId,
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
  const certificate: BunkEvmV2Certificate = {
    ...v.certificate,
    nonce: BigInt(v.certificate.nonce),
    preVerificationGas: BigInt(v.certificate.preVerificationGas),
    maxGasCost: BigInt(v.certificate.maxGasCost),
  } as BunkEvmV2Certificate;
  return {
    config: config(v.chainId),
    state: {
      protocolVersion: 2 as const,
      deployed: v.ownerIndex !== 0,
      account: v.account as Address,
      accountIndex: v.accountIndex,
      ownerIndex: v.ownerIndex,
      commitment: v.owner.commitment as Hex,
      nonce: BigInt(v.ownerIndex),
    },
    intent: { protocolVersion: 2 as const, certificate, ownerSignature: v.ownerSignature as Hex },
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

describe('Independent v2 BIP32 / ABI / EIP-712 / Merkle / exact-signature vectors', {
  timeout: 15000,
}, () => {
  for (const [index, v] of fixture.vectors.entries()) {
    it(`matches chain ${v.chainId}, account ${v.accountIndex}, owner ${v.ownerIndex}, leaf ${v.attempt}`, async () => {
      const r = request(index),
        owner = deriveBunkEvmV2Owner(seed, ref(v));
      expect(owner.path).toBe(v.owner.path);
      expect(owner.publicKey).toBe(v.owner.publicKey);
      expect(owner.address.toLowerCase()).toBe(v.owner.address);
      expect(owner.commitment).toBe(v.owner.commitment);
      const deployment = signBunkEvmV2Deployment(seed, r.config, v.accountIndex);
      expect(deployment.account.toLowerCase()).toBe(v.account);
      expect(deployment.identity.path).toBe(v.identity.path);
      expect(deployment.identity.publicKey).toBe(v.identity.publicKey);
      expect(deployment.digest).toBe(v.deploymentDigest);
      expect(deployment.signature).toBe(v.deploymentSignature);
      expect(deployment.factoryData).toBe(v.factoryData);
      const tree = deriveBunkEvmV2Envelopes(seed, ref(v));
      expect(tree.signers.map((s) => s.address.toLowerCase())).toEqual(v.envelopeAddresses);
      expect(tree.signers[v.attempt]?.path).toBe(v.envelope.path);
      expect(tree.signers[v.attempt]?.publicKey).toBe(v.envelope.publicKey);
      expect(tree.root).toBe(v.certificate.envelopeRoot);
      expect(tree.proofs[v.attempt]).toEqual(v.proof);
      const signed = signBunkEvmV2Intent(seed, intentRequest(index));
      expect(signed.digest).toBe(v.intentDigest);
      expect(signed.intent.ownerSignature).toBe(v.ownerSignature);
      expect(signed.nextOwner.commitment).toBe(v.successor.commitment);
      const envelope = signBunkEvmV2Envelope(seed, { ...r, intent: signed.intent });
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
  it('separates all v1, v2 owner, envelope and deployment branches', () => {
    const seedBefore = seed.slice();
    const v = vectorAt(0),
      r = ref(v);
    const owner = deriveBunkEvmV2Owner(seed, r),
      identity = deriveBunkEvmV2DeploymentIdentity(seed, 0),
      tree = deriveBunkEvmV2Envelopes(seed, r);
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
    expect(owner.path).toMatch(/^m\/7744'\/2'\/0'\/60'/);
    expect(tree.signers[0]?.path).toMatch(/^m\/7744'\/2'\/1'\/60'/);
    expect(predictBunkEvmAccount(config(), identity.address, 0)).not.toBe(request().state.account);
    expect(seed).toEqual(seedBefore);
  });
  it('uses the full chain identity and rejects malformed indices/networks', () => {
    expect(
      bunkEvmV2OwnerPath({ chainId: (2n ** 255n + 1n).toString(), accountIndex: 0, ownerIndex: 0 }),
    ).not.toBe(bunkEvmV2OwnerPath({ chainId: '1', accountIndex: 0, ownerIndex: 0 }));
    for (const value of [-1, 256, 0.5, NaN])
      expect(() => bunkEvmV2EnvelopePath(ref(), value)).toThrow();
    for (const chainId of ['0', '01', '-1', (2n ** 256n).toString()])
      expect(() => bunkEvmV2OwnerPath({ ...ref(), chainId })).toThrow();
    expect(() => deriveBunkEvmV2Owner(new Uint8Array(32), ref())).toThrow();
    expect(() => bunkEvmV2OwnerPath({ ...ref(), accountIndex: 2147483648 })).toThrow();
  });
});

describe('One-time owner intent and scoped retries', { timeout: 20000 }, () => {
  it('retries with a new envelope signature and the same owner certificate', () => {
    const r = request(1),
      before = structuredClone(r.intent);
    const first = signBunkEvmV2Envelope(seed, { ...r, attempt: 0, proof: proofFor(1, 0) });
    const second = signBunkEvmV2Envelope(seed, {
      ...r,
      attempt: 1,
      proof: proofFor(1, 1),
      operation: { ...r.operation, maxFeePerGas: 3000000000n },
    });
    expect(first.userOpHash).not.toBe(second.userOpHash);
    expect(first.digest).toBe(second.digest);
    expect(r.intent).toEqual(before);
    expect(signBunkEvmV2Envelope(seed, { ...r, attempt: 0, proof: proofFor(1, 0) })).toEqual(first);
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
      signBunkEvmV2Envelope(seed, { ...r, state: { ...r.state, [field]: values[field] } }),
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
      signBunkEvmV2Envelope(seed, {
        ...r,
        intent: { ...r.intent, certificate: { ...c, [field]: replacement } },
      }),
    ).toThrow();
  });
  it('rejects wrong, altered, short and oversized envelope proofs', () => {
    const r = request(1);
    expect(() => signBunkEvmV2Envelope(seed, { ...r, attempt: 1 })).toThrow();
    for (const proof of [
      r.proof.slice(1),
      [...r.proof, r.proof[0] as Hex],
      [keccak256('0x11'), ...r.proof.slice(1)],
    ]) {
      expect(() => signBunkEvmV2Envelope(seed, { ...r, proof })).toThrow();
    }
  });
  it('rejects v1 config/state, wrong chain, malformed and high-S owner signatures', () => {
    const r = request(1);
    expect(() =>
      bunkEvmV2Config({ ...r.config, protocolVersion: 1 } as unknown as BunkEvmV2Config),
    ).toThrow();
    expect(() => signBunkEvmV2Envelope(seed, { ...r, config: config('1') })).toThrow();
    expect(() =>
      signBunkEvmV2Envelope(seed, { ...r, intent: { ...r.intent, ownerSignature: '0x' } }),
    ).toThrow();
    const sig = r.intent.ownerSignature,
      order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = concatHex([
      slice(sig, 0, 32),
      toHex(order - BigInt(slice(sig, 32, 64)), { size: 32 }),
      toHex(BigInt(slice(sig, 64)) === 27n ? 28 : 27, { size: 1 }),
    ]);
    expect(() =>
      signBunkEvmV2Envelope(seed, { ...r, intent: { ...r.intent, ownerSignature: high } }),
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
        callData: bunkEvmV2RecoveryCalls(),
        callGasLimit: 499999n,
        preVerificationGas: 99999n,
        nonce: 9n,
        sender: fixture.config.factory.address,
        initCode: '0x1234',
      };
    expect(() =>
      signBunkEvmV2Envelope(seed, { ...r, operation: { ...r.operation, [field]: values[field] } }),
    ).toThrow();
  });
  it('enforces the signed gas liability before emitting an envelope', () => {
    const r = request(1);
    expect(() =>
      signBunkEvmV2Envelope(seed, {
        ...r,
        operation: { ...r.operation, maxFeePerGas: 10000000001n },
      }),
    ).toThrow('gas cost');
  });
  it('rejects missing/foreign counterfactual data and nonzero undeployed state', () => {
    const r = request();
    expect(() =>
      signBunkEvmV2Envelope(seed, { ...r, operation: { ...r.operation, initCode: '0x' } }),
    ).toThrow('deployment data');
    expect(() =>
      signBunkEvmV2Envelope(seed, {
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
    expect(() => signBunkEvmV2Envelope(seed, { ...r, state: { ...r.state, nonce: 1n } })).toThrow(
      'Undeployed',
    );
  });
  it('does not allow implicit expired execution or early cleanup', () => {
    const r = request(1);
    expect(() => signBunkEvmV2Envelope(seed, { ...r, now: 2001 })).toThrow('time');
    expect(() => signBunkEvmV2Envelope(seed, { ...r, now: 2000, purpose: 'cleanup' })).toThrow(
      'time',
    );
    expect(() => signBunkEvmV2Envelope(seed, { ...r, now: 999 })).toThrow('time');
    expect(signBunkEvmV2Envelope(seed, { ...r, now: 2001, purpose: 'cleanup' }).purpose).toBe(
      'cleanup',
    );
  });
  it('reserved leaf 255 has fixed fees, no calls or initialization, and starts after expiry', () => {
    const r = request(2);
    expect(bunkEvmV2RecoveryFee(r.intent.certificate)).toBe(10000000000n);
    expect(signBunkEvmV2Envelope(seed, r).calls).toEqual([]);
    for (const operation of [
      { ...r.operation, maxFeePerGas: 10000000001n },
      { ...r.operation, maxPriorityFeePerGas: 1n },
      { ...r.operation, callData: vectorAt(2).callData as Hex },
      { ...r.operation, initCode: '0x12' as Hex },
    ])
      expect(() => signBunkEvmV2Envelope(seed, { ...r, operation })).toThrow();
    expect(() => signBunkEvmV2Envelope(seed, { ...r, purpose: 'action', now: 2000 })).toThrow(
      'reserved',
    );
    expect(() => signBunkEvmV2Intent(seed, { ...intentRequest(1), maximumGasCost: 1n })).toThrow(
      'recovery fee',
    );
    expect(() => signBunkEvmV2Intent(seed, { ...intentRequest(1), executeUntil: 5000 })).toThrow(
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
      decodeBunkEvmV2Calls(
        r.config,
        r.state.account,
        encodeBunkEvmV2Calls(r.config, r.state.account, [call]),
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
        encodeBunkEvmV2Calls(r.config, r.state.account, [{ ...call, ...change }]),
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
        encodeBunkEvmV2Calls(r.config, r.state.account, [{ target, value: 0n, data: '0x' }]),
      ).toThrow();
    expect(() => encodeBunkEvmV2Calls(r.config, r.state.account, [])).toThrow();
    expect(() =>
      decodeBunkEvmV2Calls(r.config, r.state.account, concatHex([r.operation.callData, '0x00'])),
    ).toThrow();
    expect(() => bunkEvmV2Tree(Array(256).fill(r.state.account))).toThrow('distinct');
  });
  it('counts the entire 1120-byte authorization in the 8 KiB operation bound', () => {
    const r = request();
    expect(() =>
      packBunkEvmV2Operation({
        ...r.operation,
        initCode: toHex(new Uint8Array(1024)),
        callData: toHex(new Uint8Array(6144)),
      }),
    ).toThrow('8 KiB');
    expect(() => packBunkEvmV2Operation({ ...r.operation, nonce: 1n << 64n })).toThrow('uint64');
  });
});

it('verifies renewed sponsorship independently, with self-funding limited by the same intent', async () => {
  const r = request(1),
    sponsorKey = privateKeyToAccount(toHex(4n, { size: 32 }));
  const paymaster = '0x8888888888888888888888888888888888888888' as Address;
  const signed = signBunkEvmV2Intent(seed, { ...intentRequest(1), paymaster });
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
  expect(signBunkEvmV2Envelope(seed, sponsored).maximumGasCost).toBe(2600000000000000n);
  expect(() => signBunkEvmV2Envelope(seed, { ...sponsored, now: 1201 })).toThrow('grant');
  expect(() =>
    signBunkEvmV2Envelope(seed, { ...sponsored, sponsor: { ...sponsor, epoch: 1n } }),
  ).toThrow('grant');
  expect(() =>
    signBunkEvmV2Envelope(seed, { ...sponsored, operation: { ...op, maxFeePerGas: 2100000000n } }),
  ).toThrow('signature');
  expect(() => signBunkEvmV2Envelope(seed, { ...sponsored, sponsor: undefined })).toThrow(
    'Missing',
  );
  expect(() =>
    signBunkEvmV2Envelope(seed, {
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
    signBunkEvmV2Envelope(seed, { ...r, intent: signed.intent, attempt: 1, proof: proofFor(1, 1) })
      .maximumGasCost,
  ).toBe(2200000000000000n);
  expect(bunkEvmV2IntentDigest(r.config, signed.intent.certificate)).toBe(signed.digest);
}, 20000);
