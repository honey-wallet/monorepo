import {
  type Address,
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  type Hex,
  keccak256,
  parseAbiParameters,
  recoverAddress,
  size,
  slice,
  toHex,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUNK_MAX_INDEX, bunkOwnerPath } from './bunk';
import {
  type BunkEvmConfig,
  type BunkEvmOperation,
  bunkEvmConfigHash,
  bunkEvmInitializer,
  bunkEvmOwnerDigest,
  bunkEvmSponsorshipDigest,
  bunkEvmUserOpHash,
  decodeBunkEvmCalls,
  encodeBunkEvmCalls,
  packBunkEvmOperation,
  predictBunkEvmAccount,
} from './bunk-evm';
import {
  bunkEvmDeploymentPath,
  deriveBunkEvmDeploymentIdentity,
  signBunkEvmDeployment,
  signBunkEvmOperation,
} from './bunk-evm-sign';
import fixture from './fixtures/bunk-evm-v1.json';
import { mnemonicToSeed } from './index';

let seed: Uint8Array;
beforeAll(async () => {
  seed = await mnemonicToSeed(fixture.phrase);
});
function vectorAt(index: number) {
  const value = fixture.vectors[index];
  if (!value) throw new Error('Missing fixture');
  return value;
}
const config = (chainId = '1'): BunkEvmConfig => ({ ...fixture.config, chainId }) as BunkEvmConfig;
const operation = (value = vectorAt(0).operation): BunkEvmOperation =>
  ({
    ...value,
    nonce: BigInt(value.nonce),
    verificationGasLimit: BigInt(value.verificationGasLimit),
    callGasLimit: BigInt(value.callGasLimit),
    preVerificationGas: BigInt(value.preVerificationGas),
    maxPriorityFeePerGas: BigInt(value.maxPriorityFeePerGas),
    maxFeePerGas: BigInt(value.maxFeePerGas),
  }) as BunkEvmOperation;
function request(index = 0) {
  const vector = vectorAt(index);
  return {
    config: config(vector.chainId),
    state: {
      account: vector.account as Address,
      accountIndex: vector.accountIndex,
      ownerIndex: vector.ownerIndex,
      commitment: vector.currentCommitment as Hex,
      nonce: BigInt(vector.ownerIndex),
    },
    operation: operation(vector.operation),
    validity: { ...vector.validity },
    maximumGasCost: 10000000000000000n,
  };
}

describe('Bunk EVM independent Python/OpenSSL/Foundry vectors', () => {
  it('labels every derived identity test-only and never-fund', () => {
    expect(fixture.fixtureOnly).toBe(
      'Synthetic test-only vectors; never fund or deploy these derived identities.',
    );
    expect(fixture.phrase).not.toBe([...Array(11).fill('abandon'), 'about'].join(' '));
  });

  for (const [index, vector] of fixture.vectors.entries()) {
    it(`matches deployment, ABI and operation signatures for chain ${vector.chainId}, account ${vector.accountIndex}`, async () => {
      const c = config(vector.chainId),
        identity = deriveBunkEvmDeploymentIdentity(seed, vector.accountIndex);
      expect(identity.path).toBe(vector.identity.path);
      expect(identity.publicKey).toBe(vector.identity.publicKey);
      expect(identity.address.toLowerCase()).toBe(vector.identity.address);
      expect(bunkEvmInitializer(c)).toBe(fixture.initializer);
      expect(bunkEvmConfigHash(c)).toBe(fixture.configHash);
      expect(predictBunkEvmAccount(c, identity.address, vector.accountIndex).toLowerCase()).toBe(
        vector.account,
      );
      const deployment = signBunkEvmDeployment(seed, c, vector.accountIndex);
      expect(deployment.digest).toBe(vector.deploymentDigest);
      expect(deployment.signature).toBe(vector.deploymentSignature);
      expect(deployment.factoryData).toBe(vector.factoryData);
      expect(deployment.firstOwner.commitment).toBe(vector.initialCommitment);
      expect(
        await recoverAddress({ hash: deployment.digest, signature: deployment.signature }),
      ).toBe(identity.address);
      const signed = signBunkEvmOperation(seed, request(index));
      expect(signed.userOpHash).toBe(vector.userOpHash);
      expect(signed.digest).toBe(vector.ownerDigest);
      expect(signed.operation.signature).toBe(vector.authorization);
      expect(signed.nextOwner.commitment).toBe(vector.nextCommitment);
      expect(size(signed.operation.signature)).toBe(320);
      expect(signed.calls).toEqual(
        decodeBunkEvmCalls(c, signed.operation.sender, signed.operation.callData),
      );
    });
  }
  it('keeps deployment identity/account stable across chains while owner commitments differ', () => {
    const a = signBunkEvmDeployment(seed, config('1'), 0),
      b = signBunkEvmDeployment(seed, config('8453'), 0);
    expect(a.identity).toEqual(b.identity);
    expect(a.account).toBe(b.account);
    expect(a.firstOwner.commitment).not.toBe(b.firstOwner.commitment);
    expect(a.digest).not.toBe(b.digest);
  });
  it('reserves a disjoint hardened branch and rejects malformed seeds/indices', () => {
    const path = bunkEvmDeploymentPath(0);
    expect(path).toBe("m/7744'/1'/2147483647'/60'/0'");
    const ownerPath = bunkOwnerPath({
      network: { family: 'evm', chainId: '1' },
      accountIndex: 0,
      ownerIndex: 0,
    });
    expect(ownerPath.startsWith(`${path}/`)).toBe(false);
    expect(path.startsWith(`${ownerPath}/`)).toBe(false);
    expect(bunkEvmDeploymentPath(BUNK_MAX_INDEX)).toContain("2147483647'");
    for (const n of [-1, 0.1, NaN, Infinity, BUNK_MAX_INDEX + 1])
      expect(() => deriveBunkEvmDeploymentIdentity(seed, n)).toThrow();
    for (const n of [0, 32, 63, 65])
      expect(() => deriveBunkEvmDeploymentIdentity(new Uint8Array(n), 0)).toThrow();
  });
  it('does not mutate seed, state or approved operation, or advance the owner on signing', () => {
    const r = request(),
      before = structuredClone(r),
      copy = seed.slice();
    expect(signBunkEvmOperation(seed, r)).toEqual(signBunkEvmOperation(seed, r));
    expect(r).toEqual(before);
    expect(seed).toEqual(copy);
    expect('privateKey' in deriveBunkEvmDeploymentIdentity(seed, 0)).toBe(false);
  });
});

describe('Bunk signing rejects authority and encoding drift', () => {
  it.each(['nonce', 'account', 'commitment', 'ownerIndex'] as const)(
    'rejects wrong observed %s',
    (field) => {
      const r = request();
      if (field === 'nonce') r.state.nonce++;
      else if (field === 'ownerIndex') r.state.ownerIndex++;
      else if (field === 'account') r.state.account = r.config.helper.address;
      else r.state.commitment = toHex(new Uint8Array(32).fill(3));
      expect(() => signBunkEvmOperation(seed, r)).toThrow();
    },
  );
  it('rejects a different seed, deployment certificate, nonce lane and exhausted owner', () => {
    expect(() => signBunkEvmOperation(new Uint8Array(64).fill(1), request())).toThrow(/account/);
    const altered = request();
    altered.operation.initCode = concatHex([altered.operation.initCode, '0x00']);
    expect(() => signBunkEvmOperation(seed, altered)).toThrow(/deployment data/);
    const lane = request();
    lane.state.nonce = 1n << 64n;
    lane.operation.nonce = lane.state.nonce;
    expect(() => signBunkEvmOperation(seed, lane)).toThrow(/uint64/);
    const terminal = request();
    terminal.state.ownerIndex = BUNK_MAX_INDEX;
    expect(() => signBunkEvmOperation(seed, terminal)).toThrow(/exhausted/);
  });
  it('rejects noncanonical/trailing calls, forbidden administration and excessive batches', () => {
    const r = request(),
      target = r.config.singleton.address;
    for (const address of [
      r.state.account,
      r.config.module.address,
      r.config.factory.address,
      r.config.entryPoint.address,
      zeroAddress,
    ])
      expect(() =>
        encodeBunkEvmCalls(r.config, r.state.account, [{ target: address, value: 0n, data: '0x' }]),
      ).toThrow();
    expect(() => encodeBunkEvmCalls(r.config, r.state.account, [])).toThrow();
    expect(() =>
      encodeBunkEvmCalls(
        r.config,
        r.state.account,
        Array.from({ length: 17 }, () => ({ target, value: 0n, data: '0x' as Hex })),
      ),
    ).toThrow();
    expect(() =>
      decodeBunkEvmCalls(r.config, r.state.account, concatHex([r.operation.callData, '0x00'])),
    ).toThrow(/Noncanonical/);
    expect(() => decodeBunkEvmCalls(r.config, r.state.account, '0x12345678')).toThrow();
    expect(() =>
      encodeBunkEvmCalls(r.config, r.state.account, [
        { target, value: 0n, data: toHex(new Uint8Array(6144)) },
      ]),
    ).toThrow(/large/);
  });
  it('binds gas, fee, calldata, nonce and chain changes into the operation hash', () => {
    const c = config(),
      op = operation(),
      hash = bunkEvmUserOpHash(c, op);
    for (const key of [
      'nonce',
      'callGasLimit',
      'preVerificationGas',
      'maxPriorityFeePerGas',
      'maxFeePerGas',
    ] as const)
      expect(bunkEvmUserOpHash(c, { ...op, [key]: op[key] + 1n })).not.toBe(hash);
    expect(bunkEvmUserOpHash(c, { ...op, callData: concatHex([op.callData, '0x00']) })).not.toBe(
      hash,
    );
    expect(bunkEvmUserOpHash(config('8453'), op)).not.toBe(hash);
    const next = vectorAt(0).nextCommitment as Hex;
    expect(
      bunkEvmOwnerDigest(c, op, {
        ownerIndex: 0,
        nextCommitment: next,
        validAfter: 1001,
        validUntil: 2000,
      }),
    ).not.toBe(vectorAt(0).ownerDigest);
  });
  it('enforces valid windows, fee approval and numeric limits before signing', () => {
    for (const validity of [
      { validAfter: 1000, validUntil: 1000 },
      { validAfter: 1000, validUntil: 4601 },
      { validAfter: -1, validUntil: 100 },
      { validAfter: 0.1, validUntil: 100 },
      { validAfter: 0, validUntil: 2 ** 48 },
    ])
      expect(() => signBunkEvmOperation(seed, { ...request(), validity })).toThrow(/validity/);
    expect(() => signBunkEvmOperation(seed, { ...request(), maximumGasCost: 1n })).toThrow(
      /gas cost/,
    );
    for (const [key, value] of [
      ['nonce', -1n],
      ['verificationGasLimit', 500001n],
      ['preVerificationGas', 0n],
      ['maxFeePerGas', 0n],
      ['maxPriorityFeePerGas', 3_000_000_000n],
      ['callGasLimit', 1n << 120n],
    ] as const)
      expect(() => packBunkEvmOperation({ ...operation(), [key]: value })).toThrow();
    expect(() => bunkEvmConfigHash(config('01'))).toThrow(/chain ID/);
  });
});

describe('Honey sponsor approval is verified before owner signing', () => {
  const key = toHex(4n, { size: 32 }),
    signer = privateKeyToAccount(key);
  const sponsor = {
    paymaster: {
      address: '0x8888888888888888888888888888888888888888' as Address,
      codeHash: keccak256('0x12'),
    },
    signer: signer.address,
    epoch: 0n,
    maxCostPerOperation: 10n ** 17n,
  };
  const abi = parseAbiParameters(
    '(uint48 validAfter,uint48 validUntil,uint128 maxCost,uint256 nonce,uint64 epoch,bytes signature)',
  );
  async function sponsored() {
    const r = { ...request(), sponsor: structuredClone(sponsor) },
      grant = {
        validAfter: 900,
        validUntil: 2100,
        maxCost: 10n ** 17n,
        nonce: 1n,
        epoch: 0n,
        signature: toHex(new Uint8Array(65)),
      };
    const header = concatHex([
      sponsor.paymaster.address,
      toHex(200000n, { size: 16 }),
      toHex(0n, { size: 16 }),
    ]);
    r.operation.paymasterAndData = concatHex([header, encodeAbiParameters(abi, [grant])]);
    grant.signature = await signer.sign({
      hash: bunkEvmSponsorshipDigest(r.config, r.operation, grant),
    });
    r.operation.paymasterAndData = concatHex([header, encodeAbiParameters(abi, [grant])]);
    return r;
  }
  it('accepts the exact grant and binds it into the final owner hash', async () => {
    const r = await sponsored(),
      signed = signBunkEvmOperation(seed, r);
    expect(signed.maximumGasCost).toBe(2600000000000000n);
    expect(size(signed.operation.signature)).toBe(320);
    expect(size(signed.operation.paymasterAndData)).toBe(404);
    expect(signed.userOpHash).not.toBe(vectorAt(0).userOpHash);
  });
  it.each(['gas', 'signer', 'epoch', 'cap', 'window', 'paymaster'] as const)(
    'rejects sponsor %s drift',
    async (field) => {
      const r = await sponsored();
      if (field === 'gas') r.operation.callGasLimit++;
      else if (field === 'signer') r.sponsor.signer = r.config.helper.address;
      else if (field === 'epoch') r.sponsor.epoch++;
      else if (field === 'cap') r.sponsor.maxCostPerOperation = 1n;
      else if (field === 'window') r.validity.validUntil = 2101;
      else r.sponsor.paymaster.address = r.config.helper.address;
      expect(() => signBunkEvmOperation(seed, r)).toThrow();
    },
  );
  it('rejects missing, malformed and high-S sponsor grants', async () => {
    const r = await sponsored();
    expect(() => signBunkEvmOperation(seed, { ...r, sponsor: undefined })).toThrow(/Missing/);
    expect(() =>
      signBunkEvmOperation(seed, { ...r, operation: { ...r.operation, paymasterAndData: '0x' } }),
    ).toThrow(/missing/);
    const [grant] = decodeAbiParameters(abi, slice(r.operation.paymasterAndData, 52));
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = concatHex([
      slice(grant.signature, 0, 32),
      toHex(order - BigInt(slice(grant.signature, 32, 64)), { size: 32 }),
      toHex(Number(BigInt(slice(grant.signature, 64))) === 27 ? 28 : 27, { size: 1 }),
    ]);
    r.operation.paymasterAndData = concatHex([
      slice(r.operation.paymasterAndData, 0, 52),
      encodeAbiParameters(abi, [{ ...grant, signature: high }]),
    ]);
    expect(() => signBunkEvmOperation(seed, r)).toThrow(/signature/);
  });
});
