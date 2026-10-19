import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNK_MAX_INDEX, bunkOwnerPath } from './bunk';
import {
  BUNK_SOLANA_SYSTEM,
  type BunkSolanaAccount,
  type BunkSolanaAction,
  type BunkSolanaKeyRef,
  bunkSolanaAddressBytes,
  bunkSolanaDigest,
  bunkSolanaKeyPath,
  bunkSolanaPrecompile,
  bunkSolanaPrivateKey,
  bunkSolanaSpent,
  bunkSolanaWallet,
  decodeBunkSolanaState,
  deriveBunkSolanaKey,
  prepareBunkSolanaExecution,
  prepareBunkSolanaInitialization,
  prepareBunkSolanaRecovery,
} from './bunk-solana';
import fixture from './fixtures/bunk-solana.json';
import { mnemonicToSeed } from './index';

let seed: Uint8Array;
beforeAll(async () => {
  seed = await mnemonicToSeed(fixture.phrase);
});
afterAll(() => seed.fill(0));
const first = fixture.cases[0];
if (!first) throw new Error('Missing Solana vector');
const f = first;
function account(row = f): BunkSolanaAccount {
  return {
    address: row.wallet,
    owner: row.scope.program,
    executable: false,
    data: hexToBytes(row.state),
  };
}
const window = { validAfter: 3n, validUntil: 100n };
const native: BunkSolanaAction = {
  kind: 'native',
  destination: f.destination,
  lamports: 1_000_000n,
};
const cpi: BunkSolanaAction = {
  kind: 'cpi',
  program: f.target,
  accounts: [
    { address: f.destination, writable: true, signer: false },
    { address: f.wallet, writable: false, signer: true },
  ],
  data: Uint8Array.of(9, 8, 7),
};
const execute = (
  a = account(),
  action: BunkSolanaAction = native,
  payer = f.payer,
  validity = window,
) => prepareBunkSolanaExecution(seed, f.scope, a, payer, action, validity);
const mutate = (offset: number, value: number) => {
  const a = account();
  a.data[offset] = value;
  return a;
};
function advanced() {
  const a = account(),
    v = new DataView(a.data.buffer);
  v.setUint32(80, 1, true);
  v.setBigUint64(84, 1n, true);
  a.data.set(hexToBytes(f.keys.owner1.commitment.slice(2)), 92);
  return a;
}

describe('Solana phrase client independent vectors', () => {
  for (const [i, row] of fixture.cases.entries()) {
    it(`matches all seven role keys and wallet state for scope ${i}`, () => {
      const refs: Record<string, BunkSolanaKeyRef> = {
        deployment: { ...row.scope, role: 'deployment' },
        owner0: { ...row.scope, role: 'owner', epoch: 0, ownerIndex: 0 },
        owner1: { ...row.scope, role: 'owner', epoch: 0, ownerIndex: 1 },
        recovery0: { ...row.scope, role: 'recovery', epoch: 0 },
        nextOwner: { ...row.scope, role: 'owner', epoch: 1, ownerIndex: 0 },
        nextRecovery: { ...row.scope, role: 'recovery', epoch: 1 },
        maxOwner: {
          ...row.scope,
          role: 'owner',
          epoch: BUNK_MAX_INDEX,
          ownerIndex: BUNK_MAX_INDEX,
        },
      };
      for (const [name, ref] of Object.entries(refs))
        expect(deriveBunkSolanaKey(seed, ref)).toEqual(row.keys[name as keyof typeof row.keys]);
      expect(
        bunkSolanaWallet(row.scope.program, row.keys.deployment.publicKey, row.scope.accountIndex),
      ).toEqual({ address: row.wallet, bump: row.bump });
      expect(
        bunkSolanaSpent(row.scope.program, row.wallet, row.keys.owner0.commitment as `0x${string}`)
          .address,
      ).toBe(row.spentOwner);
      expect(decodeBunkSolanaState(row.scope, account(row))).toEqual({
        genesisHash: row.scope.genesisHash,
        identity: row.keys.deployment.publicKey,
        accountIndex: row.scope.accountIndex,
        epoch: 0,
        ownerIndex: 0,
        nonce: 0n,
        owner: row.keys.owner0.commitment,
        recovery: row.keys.recovery0.commitment,
        bump: row.bump,
      });
    });
    it(`matches all four instruction/digest/signature/precompile encodings for scope ${i}`, () => {
      const actions = [
        prepareBunkSolanaInitialization(seed, row.scope, row.payer),
        prepareBunkSolanaExecution(
          seed,
          row.scope,
          account(row),
          row.payer,
          { kind: 'native', destination: row.destination, lamports: 1_000_000n },
          window,
        ),
        prepareBunkSolanaExecution(
          seed,
          row.scope,
          account(row),
          row.payer,
          {
            kind: 'cpi',
            program: row.target,
            accounts: [
              { address: row.destination, writable: true, signer: false },
              { address: row.wallet, writable: false, signer: true },
            ],
            data: Uint8Array.of(9, 8, 7),
          },
          window,
        ),
        prepareBunkSolanaRecovery(seed, row.scope, account(row), row.payer),
      ];
      for (const [n, p] of actions.entries()) {
        const v = row.vectors[n];
        if (!v) throw new Error('Missing instruction vector');
        expect(bytesToHex(p.instruction.data)).toBe(v.instruction);
        expect(p.digest).toBe(v.digest);
        const privateKey = bunkSolanaPrivateKey(seed, p.key);
        try {
          const signature = ed25519.sign(hexToBytes(p.digest.slice(2)), privateKey);
          expect(bytesToHex(signature)).toBe(v.signature);
          expect(
            bytesToHex(bunkSolanaPrecompile(p.signer.publicKey, p.digest, signature).data),
          ).toBe(v.precompile);
        } finally {
          privateKey.fill(0);
        }
      }
    });
  }
});

describe('Solana preparation boundaries', () => {
  it('keeps roles, generations, networks, programs and old paths separate', () => {
    const paths = fixture.cases.flatMap((v) => Object.values(v.keys).map((k) => k.path));
    expect(new Set(paths).size).toBe(28);
    expect(
      new Set(fixture.cases.flatMap((v) => Object.values(v.keys).map((k) => k.commitment))).size,
    ).toBe(28);
    const legacy = bunkOwnerPath({
      network: { family: 'solana', genesisHash: f.scope.genesisHash },
      accountIndex: 7,
      ownerIndex: 0,
    });
    expect(legacy.startsWith("m/7744'/1'/501'/")).toBe(true);
    expect(paths).not.toContain(legacy);
    for (const path of paths)
      expect(
        path
          .split('/')
          .slice(1)
          .every((p) => /^\d+'$/.test(p)),
      ).toBe(true);
  });
  it('rejects malformed scope/index/role/seed without changing the seed', () => {
    const copy = seed.slice();
    const ref = { ...f.scope, role: 'owner', epoch: 0, ownerIndex: 0 } as const;
    for (const value of [-1, 0.5, NaN, Infinity, 2 ** 31]) {
      for (const field of ['accountIndex', 'epoch', 'ownerIndex'])
        expect(() => bunkSolanaKeyPath({ ...ref, [field]: value })).toThrow();
    }
    for (const value of ['', '0'.repeat(32), BUNK_SOLANA_SYSTEM, `${f.scope.program}1`]) {
      expect(() => bunkSolanaKeyPath({ ...ref, program: value })).toThrow();
      expect(() => bunkSolanaKeyPath({ ...ref, genesisHash: value })).toThrow();
    }
    expect(() =>
      bunkSolanaKeyPath({ ...ref, role: 'nope' } as unknown as BunkSolanaKeyRef),
    ).toThrow();
    expect(() => bunkSolanaPrivateKey(seed.slice(0, 32), ref)).toThrow();
    expect(seed).toEqual(copy);
  });
  it('rejects corrupted or substituted account state', () => {
    for (const a of [
      mutate(0, 0),
      mutate(8, 9),
      mutate(40, 0),
      mutate(72, 3),
      mutate(156, 0),
      { ...account(), data: account().data.slice(1) },
      { ...account(), address: f.destination },
      { ...account(), owner: f.target },
      { ...account(), executable: true },
    ])
      expect(() => decodeBunkSolanaState(f.scope, a)).toThrow();
    const view = new Uint8Array(200);
    view.set(account().data, 17);
    expect(
      decodeBunkSolanaState(f.scope, { ...account(), data: view.subarray(17, 174) }).nonce,
    ).toBe(0n);
  });
  it('rejects invalid/aliased authorities and counter bounds', () => {
    for (const offset of [92, 124]) {
      const a = account();
      a.data.fill(0, offset, offset + 32);
      expect(() => decodeBunkSolanaState(f.scope, a)).toThrow();
    }
    const alias = account();
    alias.data.set(alias.data.slice(92, 124), 124);
    expect(() => decodeBunkSolanaState(f.scope, alias)).toThrow();
    for (const offset of [72, 76, 80]) {
      const a = account();
      new DataView(a.data.buffer).setUint32(offset, 2 ** 31, true);
      expect(() => decodeBunkSolanaState(f.scope, a)).toThrow();
    }
    const nonce = account();
    new DataView(nonce.data.buffer).setBigUint64(84, 0xffffffffffffffffn, true);
    expect(() => execute(nonce)).toThrow('exhausted');
    expect(() => prepareBunkSolanaRecovery(seed, f.scope, nonce, f.payer)).not.toThrow();
    const a = account();
    new DataView(a.data.buffer).setUint32(80, BUNK_MAX_INDEX, true);
    expect(() => execute(a)).toThrow('exhausted');
    new DataView(a.data.buffer).setUint32(76, BUNK_MAX_INDEX, true);
    expect(() => prepareBunkSolanaRecovery(seed, f.scope, a, f.payer)).toThrow('exhausted');
  });
  it('requires the phrase identity and matching current owner/recovery', () => {
    expect(() =>
      prepareBunkSolanaExecution(
        new Uint8Array(64).fill(1),
        f.scope,
        account(),
        f.payer,
        native,
        window,
      ),
    ).toThrow('identity');
    for (const offset of [92, 124])
      expect(() => execute(mutate(offset, 123))).toThrow('authorities');
    expect(() => prepareBunkSolanaRecovery(seed, f.scope, mutate(124, 123), f.payer)).toThrow(
      'recovery',
    );
  });
  it('allows independent recovery with unknown current owner and unchanged certificate after advancement', () => {
    const initial = prepareBunkSolanaRecovery(seed, f.scope, account(), f.payer);
    const later = prepareBunkSolanaRecovery(seed, f.scope, advanced(), f.target);
    expect(later.digest).toBe(initial.digest);
    expect(later.instruction.data).toEqual(initial.instruction.data);
    expect(later.instruction.accounts[4]).not.toEqual(initial.instruction.accounts[4]);
    expect(prepareBunkSolanaRecovery(seed, f.scope, mutate(92, 123), f.payer).digest).toBe(
      initial.digest,
    );
    expect(execute(advanced()).digest).not.toBe(execute().digest);
  });
  it('forbids sensitive payer roles and aliased controls/destinations', () => {
    expect(() => execute(account(), native, f.keys.owner1.publicKey)).toThrow('payer');
    for (const payer of [f.keys.nextOwner.publicKey, f.keys.nextRecovery.publicKey])
      expect(() => prepareBunkSolanaRecovery(seed, f.scope, account(), payer)).toThrow('payer');
    for (const payer of [
      f.keys.deployment.publicKey,
      f.keys.owner0.publicKey,
      f.keys.recovery0.publicKey,
      f.wallet,
      BUNK_SOLANA_SYSTEM,
      f.spentOwner,
    ])
      expect(() => execute(account(), native, payer)).toThrow();
    for (const a of execute().instruction.accounts.slice(0, 6))
      expect(() =>
        execute(account(), { ...native, destination: a.address } as BunkSolanaAction),
      ).toThrow();
  });
  it('binds action/window/successor and permits separately funded identical retries', () => {
    const p = execute();
    expect(execute(account(), native, f.target).digest).toBe(p.digest);
    expect(execute(account(), { ...native, lamports: 2n } as BunkSolanaAction).digest).not.toBe(
      p.digest,
    );
    expect(
      execute(account(), native, f.payer, { validAfter: 3n, validUntil: 101n }).digest,
    ).not.toBe(p.digest);
    const data = p.instruction.data.slice();
    data[33] = (data[33] ?? 0) ^ 1;
    expect(bunkSolanaDigest(f.scope, f.wallet, data, [f.destination])).not.toBe(p.digest);
  });
  it('rejects invalid amounts/windows/oversized authorization', () => {
    for (const n of [0n, -1n, 1n << 64n])
      expect(() => execute(account(), { ...native, lamports: n } as BunkSolanaAction)).toThrow();
    for (const v of [
      { validAfter: 0n, validUntil: 0n },
      { validAfter: 4n, validUntil: 3n },
      { validAfter: -1n, validUntil: 3n },
      { validAfter: 0n, validUntil: 1n << 64n },
    ])
      expect(() => execute(account(), native, f.payer, v)).toThrow();
    expect(() => bunkSolanaDigest(f.scope, f.wallet, new Uint8Array(701), [])).toThrow();
    expect(() =>
      bunkSolanaDigest(f.scope, f.wallet, new Uint8Array(), Array(14).fill(f.target)),
    ).toThrow();
  });
  it('binds exact ordered CPI account privileges and snapshots payload', () => {
    if (cpi.kind !== 'cpi') throw new Error('Expected CPI');
    const p = execute(account(), cpi);
    expect(p.instruction.accounts.at(-1)?.signer).toBe(false);
    expect(execute(account(), { ...cpi, accounts: [...cpi.accounts].reverse() }).digest).not.toBe(
      p.digest,
    );
    expect(
      execute(account(), {
        ...cpi,
        accounts: cpi.accounts.map((a) =>
          a.address === f.destination ? { ...a, writable: false } : a,
        ),
      }).digest,
    ).not.toBe(p.digest);
    const data = Uint8Array.of(9, 8, 7),
      copy = execute(account(), { ...cpi, data });
    data.fill(0);
    expect(copy.instruction.data).toEqual(p.instruction.data);
  });
  it('rejects CPI control aliases, duplicate metas, self-calls and signer escalation', () => {
    if (cpi.kind !== 'cpi') throw new Error('Expected CPI');
    const bad: BunkSolanaAction[] = [
      { ...cpi, program: f.scope.program },
      { ...cpi, program: f.payer },
      { ...cpi, accounts: [] },
      { ...cpi, accounts: Array(13).fill(cpi.accounts[0]) },
      { ...cpi, data: new Uint8Array(513) },
      { ...cpi, accounts: [...cpi.accounts, ...cpi.accounts] },
    ];
    for (const address of execute(account(), cpi)
      .instruction.accounts.slice(1, 7)
      .map((a) => a.address))
      bad.push({ ...cpi, accounts: [{ address, writable: false, signer: false }] });
    for (const [address, writable, signer] of [
      [f.wallet, true, true],
      [f.wallet, false, false],
      [f.destination, false, true],
    ] as const)
      bad.push({ ...cpi, accounts: [{ address, writable, signer }] });
    for (const action of bad) expect(() => execute(account(), action)).toThrow();
  });
  it('rejects wrong message/key/signature and malformed public encodings', () => {
    const p = execute(),
      v = f.vectors[1];
    if (!v) throw new Error('Missing vector');
    const signature = hexToBytes(v.signature);
    expect(() => bunkSolanaPrecompile(f.keys.recovery0.publicKey, p.digest, signature)).toThrow();
    expect(() =>
      bunkSolanaPrecompile(p.signer.publicKey, `0x${'00'.repeat(32)}`, signature),
    ).toThrow();
    signature[0] = (signature[0] ?? 0) ^ 1;
    expect(() => bunkSolanaPrecompile(p.signer.publicKey, p.digest, signature)).toThrow();
    expect(() => bunkSolanaPrecompile(p.signer.publicKey, p.digest, signature.slice(1))).toThrow();
    expect(() => bunkSolanaAddressBytes(base58.encode(new Uint8Array(33)))).toThrow();
    expect(() => bunkSolanaSpent(f.scope.program, f.wallet, '0xAB')).toThrow();
  });
});
