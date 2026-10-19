import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bech32, bech32m } from '@scure/base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bunkPrivateKeyFor, deriveBunkOwner } from './bunk';
import {
  assembleBunkBitcoinTransaction,
  BITCOIN_MAX_SATOSHIS,
  type BunkBitcoinSpendRequest,
  type BunkBitcoinTransaction,
  bunkBitcoinAddressScript,
  bunkBitcoinDust,
  bunkBitcoinSignatureDigest,
  prepareBunkBitcoinSpend,
} from './bunk-bitcoin';
import fixture from './fixtures/bunk-v1.json';
import { mnemonicToSeed } from './index';

let seed: Uint8Array;
beforeAll(async () => {
  seed = await mnemonicToSeed(fixture.phrase);
});
afterAll(() => seed.fill(0));
const scope = { network: { family: 'bitcoin', network: 'regtest' } as const, accountIndex: 0 };
function coin(ownerIndex: number, satoshis = 100_000n) {
  const owner = deriveBunkOwner(seed, { ...scope, ownerIndex });
  return {
    txid: (ownerIndex + 1).toString(16).padStart(64, '0'),
    vout: 0,
    satoshis,
    ownerIndex,
    scriptPubKey: `0014${owner.commitment.slice(2)}`,
  };
}
function request(): BunkBitcoinSpendRequest {
  return {
    network: 'regtest',
    accountIndex: 0,
    changeIndex: 3,
    utxos: [coin(0), coin(1), coin(2)],
    payments: [
      {
        address: bech32.encode('bcrt', [0, ...bech32.toWords(new Uint8Array(20).fill(55))]),
        satoshis: 150_000n,
      },
    ],
    feeRateSatPerKvB: 1000n,
    dustRelayFeeSatPerKvB: 3000n,
    maxFeeSat: 1000n,
    lockTime: 100,
  };
}
function sign(p: ReturnType<typeof prepareBunkBitcoinSpend>) {
  return p.selected.map((u, i) => {
    const key = bunkPrivateKeyFor(seed, { ...scope, ownerIndex: u.ownerIndex });
    try {
      return bytesToHex(
        secp256k1.sign(hexToBytes(p.signatureDigests[i] ?? ''), key, {
          prehash: false,
          lowS: true,
          format: 'der',
        }),
      );
    } finally {
      key.fill(0);
    }
  });
}
describe('Bitcoin spend construction', () => {
  it('selects all known coins of a chosen owner together without granting signing authority', () => {
    const r = request(),
      first = coin(0, 80_000n);
    r.utxos = [first, { ...first, vout: 1, satoshis: 70_000n }, coin(1)];
    r.payments = [{ address: r.payments[0]?.address ?? '', satoshis: 120_000n }];
    const p = prepareBunkBitcoinSpend(seed, r);
    expect(p.selected.map((u) => u.ownerIndex)).toEqual([0, 0]);
    expect(p.signatureDigests[0]).not.toBe(p.signatureDigests[1]);
    expect(p.signingAuthorized).toBe(false);
  });
  it('skips an oversized owner group rather than partially consuming it', () => {
    const r = request(),
      first = coin(0, 3000n);
    r.utxos = [
      ...Array.from({ length: 101 }, (_, vout) => ({ ...first, vout })),
      coin(1, 200_000n),
    ];
    const p = prepareBunkBitcoinSpend(seed, r);
    expect(p.selected.map((u) => u.ownerIndex)).toEqual([1]);
  });
  it('matches the published BIP143 native-P2WPKH input digest and DER signature', () => {
    // Public-domain BIP143 Native P2WPKH vector. First input is legacy P2PK;
    // only the second input's witness digest is under test (no legacy signing).
    const reverse = (v: string) => bytesToHex(hexToBytes(v).reverse());
    const tx: BunkBitcoinTransaction = {
      version: 1,
      lockTime: 17,
      inputs: [
        {
          txid: reverse('fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f'),
          vout: 0,
          satoshis: 625_000_000n,
          sequence: 0xffffffee,
          publicKey: '03c9f4836b9a4f77fc0d81f7bcb01b7f1b35916864b9476c241ce9fc198bd25432',
        },
        {
          txid: reverse('ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a'),
          vout: 1,
          satoshis: 600_000_000n,
          sequence: 0xffffffff,
          publicKey: '025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357',
        },
      ],
      outputs: [
        {
          satoshis: 112_340_000n,
          scriptPubKey: '76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac',
        },
        {
          satoshis: 223_450_000n,
          scriptPubKey: '76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac',
        },
      ],
    };
    const hash = bunkBitcoinSignatureDigest(tx, 1);
    expect(hash).toBe('c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670');
    const publicVectorKey = hexToBytes(
      '619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9',
    );
    expect(
      bytesToHex(
        secp256k1.sign(hexToBytes(hash), publicVectorKey, {
          prehash: false,
          lowS: true,
          format: 'der',
        }),
      ),
    ).toBe(
      '304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee',
    );
    publicVectorKey.fill(0);
  });
  it('selects deterministically, preserves payments, derives change and verifies final bytes', () => {
    const r = request(),
      before = structuredClone(r),
      p = prepareBunkBitcoinSpend(seed, r);
    expect(p.signingAuthorized).toBe(false);
    expect(p.selected.map((i) => i.ownerIndex)).toEqual([0, 1]);
    expect(p.transaction.outputs[0]?.satoshis).toBe(150_000n);
    expect(p.changeAddress).toBe(deriveBunkOwner(seed, { ...scope, ownerIndex: 3 }).ownerAddress);
    expect(p.changeSatoshis + p.feeSatoshis + 150_000n).toBe(200_000n);
    expect(p.feeSatoshis).toBe(BigInt(p.maxVbytes));
    const signed = assembleBunkBitcoinTransaction(p.transaction, sign(p));
    expect(signed.txid).toBe(p.txid);
    expect(signed.wtxid).not.toBe(p.txid);
    expect(signed.rawTransaction.slice(0, 12)).toBe('020000000001');
    expect(signed.vbytes).toBeLessThanOrEqual(p.maxVbytes);
    expect(r).toEqual(before);
    expect(prepareBunkBitcoinSpend(seed, { ...r, utxos: [...r.utxos].reverse() })).toEqual(p);
  });
  it('handles sub-satoshi-per-vbyte fees and dust change within the explicit cap', () => {
    const r = request();
    r.utxos = [coin(0)];
    r.payments = [{ ...r.payments[0], address: r.payments[0]?.address ?? '', satoshis: 99_700n }];
    const p = prepareBunkBitcoinSpend(seed, r);
    expect(p.changeSatoshis).toBe(0n);
    expect(p.feeSatoshis).toBe(300n);
    expect(() => prepareBunkBitcoinSpend(seed, { ...r, maxFeeSat: 299n })).toThrow(
      'fee/input limits',
    );
    const low = prepareBunkBitcoinSpend(seed, { ...request(), feeRateSatPerKvB: 100n });
    expect(low.feeSatoshis).toBe((BigInt(low.maxVbytes) + 9n) / 10n);
  });
  it('selects another input when it permits change instead of excessive dust donation', () => {
    const r = request();
    r.utxos = [coin(0), coin(1, 10_000n)];
    r.payments = [{ address: r.payments[0]?.address ?? '', satoshis: 99_700n }];
    r.maxFeeSat = 250n;
    const p = prepareBunkBitcoinSpend(seed, r);
    expect(p.selected).toHaveLength(2);
    expect(p.changeSatoshis).toBeGreaterThan(0n);
    expect(p.feeSatoshis).toBeLessThanOrEqual(250n);
  });
  it('rejects duplicate outpoints, wrong ownership, exhausted indices and bad money', () => {
    const r = request(),
      u = coin(0);
    for (const changed of [
      { utxos: [u, u] },
      { utxos: [{ ...u, scriptPubKey: `0014${'11'.repeat(20)}` }] },
      { changeIndex: 0 },
      { changeIndex: 0x80000000 },
      { feeRateSatPerKvB: 0n },
      { utxos: [{ ...u, satoshis: BITCOIN_MAX_SATOSHIS + 1n }] },
      { utxos: [{ ...u, satoshis: 0n }] },
      { lockTime: 500_000_000 },
      { payments: [{ address: r.payments[0]?.address ?? '', satoshis: 293n }] },
    ])
      expect(() => prepareBunkBitcoinSpend(seed, { ...r, ...changed })).toThrow();
  });
  it('rejects payments back to selected or reserved change addresses', () => {
    const r = request();
    for (const ownerIndex of [0, 3]) {
      const address = deriveBunkOwner(seed, { ...scope, ownerIndex }).ownerAddress;
      expect(() =>
        prepareBunkBitcoinSpend(seed, { ...r, payments: [{ address, satoshis: 50_000n }] }),
      ).toThrow(/reuse|aliases/);
    }
  });
  it('rejects wrong, high-S, reordered and stale signatures after transaction mutation', () => {
    const p = prepareBunkBitcoinSpend(seed, request()),
      signatures = sign(p);
    expect(() => assembleBunkBitcoinTransaction(p.transaction, [])).toThrow('signature count');
    expect(() =>
      assembleBunkBitcoinTransaction(p.transaction, [...signatures].reverse()),
    ).toThrow();
    const parsed = secp256k1.Signature.fromBytes(hexToBytes(signatures[0] ?? ''), 'der');
    const high = new secp256k1.Signature(parsed.r, secp256k1.Point.Fn.ORDER - parsed.s);
    expect(() =>
      assembleBunkBitcoinTransaction(p.transaction, [
        bytesToHex(high.toBytes('der')),
        ...signatures.slice(1),
      ]),
    ).toThrow();
    for (const mutate of [
      (t: BunkBitcoinTransaction) => {
        t.lockTime++;
      },
      (t: BunkBitcoinTransaction) => {
        if (t.inputs[0]) t.inputs[0].satoshis++;
      },
      (t: BunkBitcoinTransaction) => {
        if (t.inputs[0]) t.inputs[0].vout++;
      },
      (t: BunkBitcoinTransaction) => {
        if (t.outputs[0]) t.outputs[0].satoshis--;
      },
    ]) {
      const tx = structuredClone(p.transaction);
      mutate(tx);
      expect(() => assembleBunkBitcoinTransaction(tx, signatures)).toThrow();
    }
  });
});

describe('Bitcoin recipient and dust policy', () => {
  it('accepts standard legacy, witness-v0 and Taproot recipients', () => {
    expect(bunkBitcoinAddressScript('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'mainnet')).toBe(
      '76a9147680adec8eabcabac676be9e83854ade0bd22cdb88ac',
    );
    expect(bunkBitcoinAddressScript('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'mainnet')).toBe(
      'a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87',
    );
    for (const [version, length, coder] of [
      [0, 20, bech32],
      [0, 32, bech32],
      [1, 32, bech32m],
    ] as const) {
      const address = coder.encode('bc', [
        version,
        ...coder.toWords(new Uint8Array(length).fill(17)),
      ]);
      const expected = `${version ? '51' : '00'}${length.toString(16)}${'11'.repeat(length)}`;
      expect(bunkBitcoinAddressScript(address, 'mainnet')).toBe(expected);
      expect(bunkBitcoinAddressScript(address.toUpperCase(), 'mainnet')).toBe(expected);
      expect(() => bunkBitcoinAddressScript(address, 'testnet')).toThrow();
    }
  });
  it('rejects wrong networks, checksums, mixed case and unsupported witness forms', () => {
    const program = bech32.toWords(new Uint8Array(32).fill(17));
    for (const address of [
      '1BoatSLRHtKNngkdXEeobR76b53LETtpyTp',
      bech32.encode('bc', [1, ...program]),
      bech32m.encode('bc', [0, ...program]),
      bech32m.encode('bc', [2, ...program]),
      bech32.encode('bc', [0, ...bech32.toWords(new Uint8Array(21))]),
      `bC${bech32.encode('bc', [0, ...program]).slice(2)}`,
    ])
      expect(() => bunkBitcoinAddressScript(address, 'mainnet')).toThrow();
    expect(() =>
      bunkBitcoinAddressScript('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'regtest'),
    ).toThrow();
  });
  it('matches Bitcoin Core dust thresholds at 3000 sat/kvB', () => {
    expect(bunkBitcoinDust(`0014${'11'.repeat(20)}`, 3000n)).toBe(294n);
    expect(bunkBitcoinDust(`0020${'11'.repeat(32)}`, 3000n)).toBe(330n);
    expect(bunkBitcoinDust(`5120${'11'.repeat(32)}`, 3000n)).toBe(330n);
    expect(bunkBitcoinDust(`76a914${'11'.repeat(20)}88ac`, 3000n)).toBe(546n);
    expect(bunkBitcoinDust(`a914${'11'.repeat(20)}87`, 3000n)).toBe(540n);
  });
});
