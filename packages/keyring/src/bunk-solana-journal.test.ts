import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BunkJournalSnapshot,
  type BunkJournalStore,
  BunkSigningUncertain,
} from './bunk-evm-v2-journal';
import { encryptedBunkJournalStore } from './bunk-evm-v2-store';
import {
  type BunkSolanaAction,
  type BunkSolanaInstruction,
  bunkSolanaAddressBytes,
} from './bunk-solana';
import {
  refreshBunkSolanaAccount,
  reserveBunkSolanaAction,
  signBunkSolanaApproval,
  startBunkSolanaRestore,
} from './bunk-solana-journal';
import {
  type BunkSolanaAccess,
  type BunkSolanaRelease,
  observeBunkSolanaAccount,
} from './bunk-solana-observe';
import fixture from './fixtures/bunk-solana.json';
import { mnemonicToSeed } from './index';

let seed: Uint8Array;
beforeAll(async () => {
  seed = await mnemonicToSeed(fixture.phrase);
});
afterAll(() => seed.fill(0));
const first = fixture.cases[0];
if (!first) throw new Error('Missing fixture');
const f = first;
const code = Uint8Array.of(1, 2, 3, 4);
const release: BunkSolanaRelease = {
  genesisHash: f.scope.genesisHash,
  program: f.scope.program,
  programData: base58.encode(new Uint8Array(32).fill(12)),
  codeSha256: `0x${bytesToHex(sha256(code))}`,
  codeLength: code.length,
  upgradeAuthority: null,
};
const native: BunkSolanaAction = {
  kind: 'native',
  destination: f.destination,
  lamports: 1_000_000n,
};
const window = { validAfter: 0n, validUntil: 1000n };
function rawAccount(owner: string, data: Uint8Array, executable = false) {
  return { owner, data: [base64.encode(data), 'base64'], executable, lamports: 20_000_000 };
}
class Chain {
  slot = 100;
  data: Uint8Array | null = null;
  genesis = release.genesisHash;
  now = 1200;
  calls: { method: string; params: readonly unknown[] }[] = [];
  change: (method: string, result: unknown) => unknown = (_, result) => result;
  block = (slot: number) => ({
    blockhash: base58.encode(sha256(utf8ToBytes(`slot-${slot}`))),
    blockTime: 1000 + slot,
  });
  access: BunkSolanaAccess = {
    now: () => this.now,
    maxFinalizedAgeSeconds: 300,
    rpc: {
      request: async (method, params) => {
        this.calls.push({ method, params });
        let result: unknown;
        if (method === 'getGenesisHash') result = this.genesis;
        else if (method === 'getBlock') result = this.block(params[0] as number);
        else if (method === 'getMultipleAccounts') {
          const program = concatBytes(
            Uint8Array.of(2, 0, 0, 0),
            bunkSolanaAddressBytes(release.programData),
          );
          const data = new Uint8Array(45 + code.length);
          data[0] = 3;
          data[4] = 1;
          data.set(code, 45);
          const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
          result = {
            context: { slot: this.slot },
            value: [
              rawAccount(loader, program, true),
              rawAccount(loader, data),
              this.data ? rawAccount(release.program, this.data) : null,
            ],
          };
        } else throw new Error(`Unexpected RPC ${method}`);
        return this.change(method, result);
      },
    },
  };
  /** Unit-test transition fixture only; real program acceptance tests this separately. */
  land(instructions: BunkSolanaInstruction[]) {
    const instruction = instructions[1];
    if (!instruction) throw new Error('Missing instruction');
    const d = instruction.data;
    if (d[0] === 0)
      this.data = concatBytes(
        utf8ToBytes('HNYBUNK1'),
        d.slice(1, 69),
        new Uint8Array(16),
        d.slice(69),
        Uint8Array.of(f.bump),
      );
    else {
      if (!this.data) throw new Error('No wallet');
      const v = new DataView(this.data.buffer);
      if (d[0] === 2) {
        v.setUint32(76, v.getUint32(76, true) + 1, true);
        v.setUint32(80, 0, true);
        this.data.set(d.slice(5, 37), 92);
        this.data.set(d.slice(37, 69), 124);
      } else {
        v.setUint32(80, v.getUint32(80, true) + 1, true);
        v.setBigUint64(84, v.getBigUint64(84, true) + 1n, true);
        this.data.set(d.slice(33, 65), 92);
      }
    }
    this.slot++;
    this.now++;
  }
}
class Memory implements BunkJournalStore {
  rows = new Map<string, BunkJournalSnapshot>();
  writes = 0;
  failAt = 0;
  committedFailure = false;
  async read(key: string) {
    const row = this.rows.get(key);
    return row ? { ...row } : null;
  }
  async compareAndSwap(key: string, revision: number | null, value: string) {
    this.writes++;
    if (this.writes === this.failAt && !this.committedFailure)
      throw new Error('Injected storage failure');
    const row = this.rows.get(key);
    if ((row?.revision ?? null) !== revision) return false;
    this.rows.set(key, { revision: revision === null ? 0 : revision + 1, value });
    if (this.writes === this.failAt) throw new Error('Injected committed storage failure');
    return true;
  }
}
async function ready(store: BunkJournalStore = new Memory(), chain = new Chain()) {
  const { key } = await startBunkSolanaRestore(store, seed, release, 7, f.payer, chain.access);
  const bootstrap = await signBunkSolanaApproval(
    store,
    key,
    seed,
    'bootstrap',
    f.payer,
    chain.access,
  );
  chain.land(bootstrap.instructions);
  expect((await refreshBunkSolanaAccount(store, key, seed, chain.access)).phase).toBe('restoring');
  const reset = await signBunkSolanaApproval(store, key, seed, 'recovery', f.payer, chain.access);
  chain.land(reset.instructions);
  expect((await refreshBunkSolanaAccount(store, key, seed, chain.access)).phase).toBe('ready');
  return { key, store, chain };
}

describe('finalized Solana observation', () => {
  it('checks one bank, release, genesis, checkpoint and prefunded undeployed state', async () => {
    const chain = new Chain();
    const observation = await observeBunkSolanaAccount(
      release,
      f.keys.deployment.publicKey,
      7,
      chain.access,
    );
    expect(observation.account).toBeNull();
    expect(observation.wallet).toBe(f.wallet);
    const call = chain.calls.find((r) => r.method === 'getMultipleAccounts');
    expect(call?.params).toEqual([
      [release.program, release.programData, f.wallet],
      { encoding: 'base64', commitment: 'finalized', minContextSlot: 0 },
    ]);
    chain.change = (method, result) => {
      if (method === 'getMultipleAccounts')
        (result as { value: unknown[] }).value[2] = rawAccount(
          '11111111111111111111111111111111',
          new Uint8Array(),
        );
      return result;
    };
    expect(
      (
        await observeBunkSolanaAccount(
          release,
          f.keys.deployment.publicKey,
          7,
          chain.access,
          observation.checkpoint,
        )
      ).lamports,
    ).toBe(20_000_000n);
  });
  it('rejects code/program/upgrade policy substitution and malformed snapshots', async () => {
    for (const mutation of [
      'code',
      'loader',
      'program',
      'authority',
      'padding',
      'length',
      'slot',
      'lamports',
      'wallet',
    ]) {
      const chain = new Chain();
      chain.change = (method, result) => {
        if (method !== 'getMultipleAccounts') return result;
        const r = result as { context: { slot: number }; value: ReturnType<typeof rawAccount>[] };
        if (mutation === 'length') r.value.pop();
        else if (mutation === 'slot') r.context.slot = 2 ** 53;
        else if (mutation === 'wallet') r.value[2] = rawAccount(f.target, new Uint8Array());
        else {
          const a = r.value[mutation === 'program' ? 0 : 1];
          if (!a) throw new Error('Missing account');
          if (mutation === 'loader') a.owner = f.target;
          else if (mutation === 'lamports') a.lamports = 2 ** 53;
          else {
            let data = base64.decode(a.data[0] ?? '');
            if (mutation === 'padding') data = concatBytes(data, Uint8Array.of(1));
            else data[mutation === 'code' ? 45 : mutation === 'authority' ? 12 : 4] = 1;
            a.data[0] = base64.encode(data);
          }
        }
        return r;
      };
      // Change the first code byte away from fixture value 1.
      if (mutation === 'code')
        chain.change = (method, result) => {
          if (method === 'getMultipleAccounts') {
            const a = (result as { value: ReturnType<typeof rawAccount>[] }).value[1];
            if (!a) throw new Error('Missing account');
            const data = base64.decode(a.data[0] ?? '');
            data[45] = 99;
            a.data[0] = base64.encode(data);
          }
          return result;
        };
      await expect(
        observeBunkSolanaAccount(release, f.keys.deployment.publicKey, 7, chain.access),
      ).rejects.toThrow();
    }
  });
  it('rejects stale/null/future blocks and changing genesis/anchors', async () => {
    for (const mode of ['stale', 'null', 'future', 'genesis', 'anchor']) {
      const chain = new Chain();
      let reads = 0;
      chain.change = (method, value) => {
        if (method === 'getGenesisHash' && mode === 'genesis' && ++reads > 1) return f.target;
        if (method === 'getBlock') {
          if (mode === 'null') return null;
          const v = value as { blockTime: number; blockhash: string };
          if (mode === 'stale') v.blockTime = 1;
          if (mode === 'future') v.blockTime = 9999;
          if (mode === 'anchor' && ++reads > 1) v.blockhash = f.target;
        }
        return value;
      };
      await expect(
        observeBunkSolanaAccount(release, f.keys.deployment.publicKey, 7, chain.access),
      ).rejects.toThrow();
    }
  });
  it('snapshots release input before asynchronous RPC work and checks the old anchor', async () => {
    const chain = new Chain(),
      c = { ...release };
    chain.change = (_, result) => {
      c.program = f.target;
      return result;
    };
    const o = await observeBunkSolanaAccount(c, f.keys.deployment.publicKey, 7, chain.access);
    expect(o.scope.program).toBe(release.program);
    chain.change = (method, result) =>
      method === 'getBlock' ? { ...chain.block(100), blockhash: f.target } : result;
    await expect(
      observeBunkSolanaAccount(release, f.keys.deployment.publicKey, 7, chain.access, o.checkpoint),
    ).rejects.toThrow('anchor');
  });
});

describe('Solana atomic account journal', () => {
  it('requires bootstrap then finalized generation recovery before ordinary signing', async () => {
    const store = new Memory(),
      chain = new Chain();
    const { key } = await startBunkSolanaRestore(store, seed, release, 7, f.payer, chain.access);
    await expect(
      reserveBunkSolanaAction(store, key, seed, f.payer, native, window, chain.access),
    ).rejects.toThrow('recovery');
    await expect(
      signBunkSolanaApproval(store, key, seed, 'recovery', f.payer, chain.access),
    ).rejects.toThrow('not deployed');
    const initialized = await ready();
    expect(
      initialized.chain.data && new DataView(initialized.chain.data.buffer).getUint32(76, true),
    ).toBe(1);
  });
  it('keeps one digest after failure, returns exact signature on retry, advances only on finalized state', async () => {
    const { store, key, chain } = await ready();
    const reserved = await reserveBunkSolanaAction(
      store,
      key,
      seed,
      f.payer,
      native,
      window,
      chain.access,
    );
    const first = await signBunkSolanaApproval(store, key, seed, 'owner', f.payer, chain.access);
    expect(first.digest).toBe(reserved.digest);
    await refreshBunkSolanaAccount(store, key, seed, chain.access); // included failure changes no account state
    await expect(
      reserveBunkSolanaAction(
        store,
        key,
        seed,
        f.payer,
        { ...native, lamports: 2n } as BunkSolanaAction,
        window,
        chain.access,
      ),
    ).rejects.toThrow('another digest');
    const retry = await signBunkSolanaApproval(store, key, seed, 'owner', f.target, chain.access);
    expect(retry.instructions[0]).toEqual(first.instructions[0]);
    chain.land(retry.instructions);
    expect((await refreshBunkSolanaAccount(store, key, seed, chain.access)).state?.ownerIndex).toBe(
      1,
    );
    expect(
      (await reserveBunkSolanaAction(store, key, seed, f.payer, native, window, chain.access))
        .digest,
    ).not.toBe(first.digest);
  });
  it('requires explicit identical reconstruction after signature-save failure', async () => {
    const store = new Memory(),
      { key, chain } = await ready(store);
    await reserveBunkSolanaAction(store, key, seed, f.payer, native, window, chain.access);
    store.failAt = store.writes + 2;
    await expect(
      signBunkSolanaApproval(store, key, seed, 'owner', f.payer, chain.access),
    ).rejects.toThrow('storage');
    await expect(
      signBunkSolanaApproval(store, key, seed, 'owner', f.payer, chain.access),
    ).rejects.toBeInstanceOf(BunkSigningUncertain);
    await expect(
      reserveBunkSolanaAction(
        store,
        key,
        seed,
        f.payer,
        native,
        { ...window, validUntil: 999n },
        chain.access,
      ),
    ).rejects.toThrow('another digest');
    const restored = await signBunkSolanaApproval(
      store,
      key,
      seed,
      'owner',
      f.payer,
      chain.access,
      true,
    );
    const retried = await signBunkSolanaApproval(store, key, seed, 'owner', f.target, chain.access);
    expect(restored.instructions[0]).toEqual(retried.instructions[0]);
  });
  it('preserves claimed recovery across repeated restore and permits exact reconstruction', async () => {
    const store = new Memory(),
      { key, chain } = await ready(store);
    const first = await startBunkSolanaRestore(store, seed, release, 7, f.payer, chain.access);
    store.failAt = store.writes + 2;
    await expect(
      signBunkSolanaApproval(store, key, seed, 'recovery', f.payer, chain.access),
    ).rejects.toThrow('storage');
    const again = await startBunkSolanaRestore(store, seed, release, 7, f.target, chain.access);
    expect(again.recoveryDigest).toBe(first.recoveryDigest);
    await expect(
      signBunkSolanaApproval(store, key, seed, 'recovery', f.payer, chain.access),
    ).rejects.toBeInstanceOf(BunkSigningUncertain);
    const restored = await signBunkSolanaApproval(
      store,
      key,
      seed,
      'recovery',
      f.payer,
      chain.access,
      true,
    );
    chain.land(restored.instructions);
    expect((await refreshBunkSolanaAccount(store, key, seed, chain.access)).phase).toBe('ready');
  });
  it('handles failed-before-claim and committed-but-unacknowledged writes', async () => {
    for (const committed of [false, true]) {
      const store = new Memory(),
        { key, chain } = await ready(store);
      await reserveBunkSolanaAction(store, key, seed, f.payer, native, window, chain.access);
      store.failAt = store.writes + (committed ? 2 : 1);
      store.committedFailure = committed;
      await expect(
        signBunkSolanaApproval(store, key, seed, 'owner', f.payer, chain.access),
      ).rejects.toThrow('storage');
      expect(
        (await signBunkSolanaApproval(store, key, seed, 'owner', f.payer, chain.access))
          .instructions,
      ).toHaveLength(2);
    }
  });
  it('serializes competing approvals and signing claims across callers', async () => {
    const { key, chain, store } = await ready();
    const reserved = await Promise.allSettled([
      reserveBunkSolanaAction(store, key, seed, f.payer, native, window, chain.access),
      reserveBunkSolanaAction(
        store,
        key,
        seed,
        f.payer,
        { ...native, lamports: 2n } as BunkSolanaAction,
        window,
        chain.access,
      ),
    ]);
    expect(reserved.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const signatures = await Promise.allSettled([
      signBunkSolanaApproval(store, key, seed, 'owner', f.payer, chain.access),
      signBunkSolanaApproval(store, key, seed, 'owner', f.payer, chain.access),
    ]);
    expect(signatures.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('forces lost-history and explicit backup imports through another generation', async () => {
    const { key, chain, store } = await ready();
    const lost = new Memory();
    await expect(
      reserveBunkSolanaAction(lost, key, seed, f.payer, native, window, chain.access),
    ).rejects.toThrow('history');
    for (const s of [lost, store]) {
      const reset = await startBunkSolanaRestore(s, seed, release, 7, f.payer, chain.access);
      expect(reset.bootstrapRequired).toBe(false);
      await expect(
        reserveBunkSolanaAction(s, key, seed, f.payer, native, window, chain.access),
      ).rejects.toThrow('recovery');
    }
    const signed = await signBunkSolanaApproval(lost, key, seed, 'recovery', f.payer, chain.access);
    chain.land(signed.instructions);
    expect((await refreshBunkSolanaAccount(lost, key, seed, chain.access)).state?.epoch).toBe(2);
  });
  it('keeps expired reservations and requires independent recovery', async () => {
    const { key, chain, store } = await ready();
    await reserveBunkSolanaAction(
      store,
      key,
      seed,
      f.payer,
      native,
      { validAfter: 0n, validUntil: 103n },
      chain.access,
    );
    chain.slot = 104;
    await expect(
      signBunkSolanaApproval(store, key, seed, 'owner', f.payer, chain.access),
    ).rejects.toThrow('expired');
    await expect(
      reserveBunkSolanaAction(store, key, seed, f.payer, native, window, chain.access),
    ).rejects.toThrow('another digest');
    await startBunkSolanaRestore(store, seed, release, 7, f.payer, chain.access);
    expect(
      (await signBunkSolanaApproval(store, key, seed, 'recovery', f.payer, chain.access))
        .instructions,
    ).toHaveLength(2);
  });
  it('rejects rollback, anchor changes, mutated ciphertext and foreign releases', async () => {
    const { key, chain, store } = await ready();
    chain.data = hexToBytes(f.state);
    await expect(refreshBunkSolanaAccount(store, key, seed, chain.access)).rejects.toThrow(
      'regressed',
    );
    await expect(
      startBunkSolanaRestore(store, seed, release, 7, f.payer, chain.access),
    ).rejects.toThrow('regressed');
    await expect(
      startBunkSolanaRestore(store, seed, { ...release, codeLength: 5 }, 7, f.payer, chain.access),
    ).rejects.toThrow('migration');
    const raw = new Memory(),
      encryptionKey = new Uint8Array(32).fill(77);
    let nonce = 0;
    const encrypted = encryptedBunkJournalStore(raw, encryptionKey, (length) =>
      new Uint8Array(length).fill(++nonce),
    );
    const init = await startBunkSolanaRestore(
      encrypted,
      seed,
      release,
      7,
      f.payer,
      new Chain().access,
    );
    const row = raw.rows.get(init.key);
    if (!row) throw new Error('Missing ciphertext');
    expect(row.value).not.toContain('honey-solana-account');
    raw.rows.set(init.key, { ...row, revision: row.revision + 1 });
    await expect(
      signBunkSolanaApproval(encrypted, init.key, seed, 'bootstrap', f.payer, new Chain().access),
    ).rejects.toThrow();
    encrypted.destroy();
    encryptionKey.fill(0);
  });
  it('snapshots action/seed and rejects corrupted signed records', async () => {
    const store = new Memory(),
      { key, chain } = await ready(store);
    const mutable = { ...native },
      inputSeed = seed.slice();
    const pending = reserveBunkSolanaAction(
      store,
      key,
      inputSeed,
      f.payer,
      mutable,
      window,
      chain.access,
    );
    inputSeed.fill(0);
    if (mutable.kind === 'native') mutable.lamports = 2n;
    await pending;
    const signed = await signBunkSolanaApproval(store, key, seed, 'owner', f.payer, chain.access);
    expect(signed.instructions[1]?.data.slice(-8)).toEqual(
      Uint8Array.of(64, 66, 15, 0, 0, 0, 0, 0),
    );
    const row = store.rows.get(key);
    if (!row) throw new Error('Missing record');
    const r = JSON.parse(row.value);
    r.owner.signature = '00'.repeat(64);
    store.rows.set(key, { ...row, value: JSON.stringify(r) });
    await expect(
      signBunkSolanaApproval(store, key, seed, 'owner', f.payer, chain.access),
    ).rejects.toThrow('signature');
  });
});
